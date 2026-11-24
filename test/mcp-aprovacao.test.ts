import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  criarProvedorMcp,
  executarMcpAprovadas,
  expirarAprovacoesVencidas,
  lerConfigMcpDeTexto,
  processarEventoNexus,
  redator,
  resolverServidoresMcp,
  responderAprovacaoPeloPainel,
  timeoutDaTool,
  type Banco,
  type Cerebro,
  type ClienteMcp,
  type ServidorMcpResolvido,
} from '@jarvis/core';
import { bancoLimpo, NUMERO_BRENO, regrasTeste } from './ajuda.ts';

// Item 793 (parte 2): ponte MCP na conversa do painel + execução única depois da aprovação.
const regras = regrasTeste();
const CONFIG = lerConfigMcpDeTexto(readFileSync('config/mcp-servidores.yaml', 'utf8'));
const ENV = { JARVIS_CORE_OPENJARVIS_MCP_URL: 'http://openjarvis.invalido/mcp' };
const TOOLS = ['calculator', 'think', 'web_search', 'file_read', 'memory_search', 'memory_retrieve', 'deep_research', 'morning_digest'];

interface Chamada {
  tool: string;
  args: Record<string, unknown>;
  timeoutMs?: number;
}

function clienteFalso(o: { texto?: string; falha?: boolean; listaFalha?: boolean; atrasoMs?: number } = {}) {
  const chamadas: Chamada[] = [];
  let listagens = 0;
  const cliente: ClienteMcp = {
    iniciar: async () => undefined,
    listarTools: async () => {
      listagens++;
      if (o.listaFalha) throw new Error('servidor fora do ar');
      return TOOLS.map((name) => ({ name, description: name }));
    },
    chamarTool: async (tool, args, timeoutMs) => {
      chamadas.push({ tool, args, timeoutMs });
      if (o.atrasoMs) await new Promise((r) => setTimeout(r, o.atrasoMs));
      if (o.falha) throw new Error('queda no meio da pesquisa');
      return { texto: o.texto ?? 'relatório pronto', erro: false };
    },
    encerrar: async () => undefined,
  };
  return { cliente, chamadas, listagens: () => listagens };
}

const servidores = (): ServidorMcpResolvido[] => resolverServidoresMcp(CONFIG, ENV);

let banco: Banco;
beforeEach(async () => {
  banco = await bancoLimpo();
});
afterEach(async () => {
  redator.limpar();
  await banco.end();
});

const evento = { tipo: 'conversa' as const, numero: NUMERO_BRENO, texto: 'Jarvis, faça uma pesquisa profunda', via: 'numero' as const };

/** Conversa em que o cérebro tenta usar deep_research (amarelo): deve virar pedido, não execução. */
async function conversaPedindoDeepResearch(f: ReturnType<typeof clienteFalso>): Promise<{ resposta: string; saida: string }> {
  let saida = '';
  const cerebro: Cerebro = {
    pensar: async () => 'sem ferramentas',
    pensarComFerramentas: async (_s, _p, _tools, executar) => {
      saida = await executar('mcp__openjarvis__deep_research', { tema: 'mercado de café', token: 'abc' }, 10_000);
      return 'Pedi a aprovação.';
    },
  };
  const mcp = criarProvedorMcp({ db: banco, regras, env: ENV, carregarConfig: () => CONFIG, criarCliente: () => f.cliente });
  const r = await processarEventoNexus(banco, regras, evento, { cerebro, mcp });
  expect(r).toMatchObject({ tipo: 'conversa', resposta: 'Pedi a aprovação.' });
  return { resposta: 'Pedi a aprovação.', saida };
}

async function aprovacaoMcp(): Promise<{ id: string; mcp_estado: string; status: string }> {
  const r = await banco.query(`select id, mcp_estado, status from aprovacoes where mcp_tool = 'deep_research'`);
  expect(r.rows).toHaveLength(1);
  return r.rows[0] as { id: string; mcp_estado: string; status: string };
}

describe('conversa do painel com a ponte MCP', () => {
  it('sem URL no ambiente: conversa segue normal, sem MCP', async () => {
    let vistas: string[] = [];
    const cerebro: Cerebro = {
      pensar: async () => 'resposta normal',
      pensarComFerramentas: async (_s, _p, tools) => {
        vistas = tools.map((t) => t.name);
        return 'com ferramentas';
      },
    };
    const mcp = criarProvedorMcp({ db: banco, regras, env: {}, carregarConfig: () => CONFIG });
    expect(await mcp.obter()).toBeNull();
    const r = await processarEventoNexus(banco, regras, evento, { cerebro, mcp });
    // item 852: sem MCP a conversa ainda tem as ferramentas locais (só leitura), e nenhuma mcp__*
    expect(r).toMatchObject({ tipo: 'conversa', resposta: 'com ferramentas' });
    expect(vistas).toEqual(['meta_metricas', 'web_abrir']);
  });

  it('config ilegível ou servidor fora do ar: segue sem MCP e o resultado negativo fica em cache curto', async () => {
    const f = clienteFalso({ listaFalha: true });
    let agora = 1_000;
    const mcp = criarProvedorMcp({ db: banco, regras, env: ENV, carregarConfig: () => CONFIG, criarCliente: () => f.cliente, agora: () => agora });
    expect(await mcp.obter()).toBeNull();
    expect(await mcp.obter()).toBeNull();
    expect(f.listagens()).toBe(1);
    agora += 16_000;
    expect(await mcp.obter()).toBeNull();
    expect(f.listagens()).toBe(2);
    const quebrado = criarProvedorMcp({ db: banco, regras, env: ENV, carregarConfig: () => { throw new Error('yaml quebrado'); } });
    expect(await quebrado.obter()).toBeNull();
    const cerebro: Cerebro = { pensar: async () => 'ok mesmo assim' };
    const r = await processarEventoNexus(banco, regras, evento, { cerebro, mcp: quebrado });
    expect(r).toMatchObject({ resposta: 'ok mesmo assim' });
  });

  it('servidor lento além da espera máxima: conversa não trava', async () => {
    const lento: ClienteMcp = { ...clienteFalso().cliente, listarTools: () => new Promise(() => undefined) };
    const mcp = criarProvedorMcp({ db: banco, regras, env: ENV, carregarConfig: () => CONFIG, criarCliente: () => lento, esperaMaxMs: 50 });
    expect(await mcp.obter()).toBeNull();
  });

  it('cache por processo: lista uma vez e o anti-loop de uma conversa não vaza para a outra', async () => {
    const f = clienteFalso();
    const mcp = criarProvedorMcp({ db: banco, regras, env: ENV, carregarConfig: () => CONFIG, criarCliente: () => f.cliente });
    const a = await mcp.obter();
    const b = await mcp.obter();
    expect(f.listagens()).toBe(1);
    expect(a!.ferramentas.map((t) => t.name)).toContain('mcp__openjarvis__morning_digest');
    expect(await a!.executar('mcp__openjarvis__calculator', { e: '1+1' }, 5000)).toContain('relatório pronto');
    expect(await b!.executar('mcp__openjarvis__calculator', { e: '1+1' }, 5000)).toContain('relatório pronto');
    expect(f.chamadas.filter((c) => c.tool === 'calculator')).toHaveLength(2);
  });
});

describe('aprovação de tool MCP amarela: executa uma única vez', () => {
  it('pedir não executa; aprovada executa 1 vez com os args gravados, redige e audita', async () => {
    redator.registrar('segredo_teste', 'abc-segredo-9999');
    const f = clienteFalso({ texto: 'achei isto com abc-segredo-9999 no meio' });
    const { saida } = await conversaPedindoDeepResearch(f);
    expect(saida).toContain('NÃO executei');
    expect(f.chamadas).toHaveLength(0);

    const ap = await aprovacaoMcp();
    expect(ap).toMatchObject({ mcp_estado: 'pendente', status: 'pendente' });
    const aviso = await banco.query(`select tipo from avisos where aprovacao_id = $1`, [ap.id]);
    expect(aviso.rows).toEqual([{ tipo: 'pedido_aprovacao' }]);
    // pendente ainda não executa
    expect(await executarMcpAprovadas(banco, { servidores: servidores(), criarCliente: () => f.cliente })).toEqual({ executadas: 0, erros: 0 });
    expect(f.chamadas).toHaveLength(0);

    expect(await responderAprovacaoPeloPainel(banco, ap.id, 'aprovar', 'breno')).toBe('aprovada');
    const deps = { servidores: servidores(), criarCliente: () => f.cliente };
    expect(await executarMcpAprovadas(banco, deps)).toEqual({ executadas: 1, erros: 0 });
    expect(f.chamadas).toEqual([{ tool: 'deep_research', args: { tema: 'mercado de café', token: 'abc' }, timeoutMs: 600_000 }]);

    const linha = (await banco.query(`select mcp_estado, mcp_resultado, mcp_erro from aprovacoes where id = $1`, [ap.id])).rows[0] as Record<string, string | null>;
    expect(linha.mcp_estado).toBe('executada');
    expect(linha.mcp_resultado).toContain('[segredo:segredo_teste]');
    expect(linha.mcp_resultado).not.toContain('abc-segredo-9999');
    const aud = await banco.query(`select detalhes from auditoria where acao = 'mcp_aprovada_executada'`);
    expect(aud.rows).toHaveLength(1);
    expect(JSON.stringify(aud.rows[0])).not.toContain('abc-segredo-9999');
    const texto = await banco.query(`select conteudo from avisos where tipo = 'texto'`);
    expect(JSON.stringify(texto.rows)).toContain('Executei openjarvis/deep_research');

    // outra rodada do worker e uma segunda decisão não repetem
    expect(await executarMcpAprovadas(banco, deps)).toEqual({ executadas: 0, erros: 0 });
    expect(await responderAprovacaoPeloPainel(banco, ap.id, 'aprovar', 'breno')).toBe('ja_respondida');
    expect(await responderAprovacaoPeloPainel(banco, ap.id, 'recusar', 'breno')).toBe('ja_respondida');
    expect(await executarMcpAprovadas(banco, deps)).toEqual({ executadas: 0, erros: 0 });
    expect(f.chamadas).toHaveLength(1);
  });

  it('pedido repetido na mesma conversa não cria segunda aprovação', async () => {
    const f = clienteFalso();
    const mcp = criarProvedorMcp({ db: banco, regras, env: ENV, carregarConfig: () => CONFIG, criarCliente: () => f.cliente });
    const c = (await mcp.obter())!;
    await c.executar('mcp__openjarvis__deep_research', { tema: 'x' }, 5000);
    const segunda = await c.executar('mcp__openjarvis__deep_research', { tema: 'x' }, 5000);
    expect(segunda).toContain('já teve a aprovação pedida');
    expect((await banco.query(`select 1 from aprovacoes where mcp_tool = 'deep_research'`)).rowCount).toBe(1);
  });

  it('recusada não executa', async () => {
    const f = clienteFalso();
    await conversaPedindoDeepResearch(f);
    const ap = await aprovacaoMcp();
    expect(await responderAprovacaoPeloPainel(banco, ap.id, 'recusar', 'breno')).toBe('recusada');
    expect(await executarMcpAprovadas(banco, { servidores: servidores(), criarCliente: () => f.cliente })).toEqual({ executadas: 0, erros: 0 });
    expect(f.chamadas).toHaveLength(0);
    // recusada e depois "aprovar" também não vale
    expect(await responderAprovacaoPeloPainel(banco, ap.id, 'aprovar', 'breno')).toBe('ja_respondida');
    expect(await executarMcpAprovadas(banco, { servidores: servidores(), criarCliente: () => f.cliente })).toEqual({ executadas: 0, erros: 0 });
    expect(f.chamadas).toHaveLength(0);
  });

  it('expirada não executa', async () => {
    const f = clienteFalso();
    await conversaPedindoDeepResearch(f);
    const ap = await aprovacaoMcp();
    await banco.query(`update aprovacoes set expira_em = now() - interval '1 minute' where id = $1`, [ap.id]);
    await expirarAprovacoesVencidas(banco);
    expect((await aprovacaoMcp()).status).toBe('expirada');
    expect(await responderAprovacaoPeloPainel(banco, ap.id, 'aprovar', 'breno')).toBe('ja_respondida');
    expect(await executarMcpAprovadas(banco, { servidores: servidores(), criarCliente: () => f.cliente })).toEqual({ executadas: 0, erros: 0 });
    expect(f.chamadas).toHaveLength(0);
  });

  it('falha na execução vira erro, avisa e nunca repete', async () => {
    const f = clienteFalso({ falha: true });
    await conversaPedindoDeepResearch(f);
    const ap = await aprovacaoMcp();
    await responderAprovacaoPeloPainel(banco, ap.id, 'aprovar', 'breno');
    const deps = { servidores: servidores(), criarCliente: () => f.cliente };
    expect(await executarMcpAprovadas(banco, deps)).toEqual({ executadas: 0, erros: 1 });
    expect(await executarMcpAprovadas(banco, deps)).toEqual({ executadas: 0, erros: 0 });
    expect(f.chamadas).toHaveLength(1);
    const l = (await banco.query(`select mcp_estado, mcp_erro from aprovacoes where id = $1`, [ap.id])).rows[0] as Record<string, string>;
    expect(l.mcp_estado).toBe('erro');
    expect(l.mcp_erro).toContain('queda no meio');
    expect((await banco.query(`select 1 from auditoria where acao = 'mcp_aprovada_erro'`)).rowCount).toBe(1);
    expect(JSON.stringify((await banco.query(`select conteudo from avisos where tipo = 'texto'`)).rows)).toContain('NÃO foi repetida');
  });

  it('dois executores ao mesmo tempo: uma só chamada', async () => {
    const f = clienteFalso({ atrasoMs: 50 });
    await conversaPedindoDeepResearch(f);
    const ap = await aprovacaoMcp();
    await responderAprovacaoPeloPainel(banco, ap.id, 'aprovar', 'breno');
    const deps = { servidores: servidores(), criarCliente: () => f.cliente };
    const rs = await Promise.all([executarMcpAprovadas(banco, deps), executarMcpAprovadas(banco, deps)]);
    expect(rs.reduce((n, r) => n + r.executadas, 0)).toBe(1);
    expect(f.chamadas).toHaveLength(1);
  });

  it('servidor sem URL neste processo não reivindica a aprovação', async () => {
    const f = clienteFalso();
    await conversaPedindoDeepResearch(f);
    const ap = await aprovacaoMcp();
    await responderAprovacaoPeloPainel(banco, ap.id, 'aprovar', 'breno');
    expect(await executarMcpAprovadas(banco, { servidores: [], criarCliente: () => f.cliente })).toEqual({ executadas: 0, erros: 0 });
    expect((await aprovacaoMcp()).mcp_estado).toBe('pendente');
  });

  it('execução interrompida (processo caiu) vira erro e não repete', async () => {
    const f = clienteFalso();
    await conversaPedindoDeepResearch(f);
    const ap = await aprovacaoMcp();
    await responderAprovacaoPeloPainel(banco, ap.id, 'aprovar', 'breno');
    await banco.query(`update aprovacoes set mcp_estado = 'executando', mcp_iniciada_em = now() - interval '2 hours' where id = $1`, [ap.id]);
    await executarMcpAprovadas(banco, { servidores: servidores(), criarCliente: () => f.cliente });
    expect((await aprovacaoMcp()).mcp_estado).toBe('erro');
    expect(f.chamadas).toHaveLength(0);
  });
});

describe('timeout por tool', () => {
  it('deep_research e morning_digest 600 s; as demais herdam o do servidor', () => {
    const [s] = servidores();
    expect(timeoutDaTool(s!, 'deep_research')).toBe(600_000);
    expect(timeoutDaTool(s!, 'morning_digest')).toBe(600_000);
    expect(timeoutDaTool(s!, 'web_search')).toBe(30_000);
  });

  it('timeout para tool fora da allowlist é recusado', () => {
    expect(() => lerConfigMcpDeTexto('versao: 1\nservidores:\n  x:\n    url_env: X_URL\n    tools: [a]\n    timeouts_ms: { b: 5000 }\n')).toThrow(/allowlist/);
  });

  it('na conversa o prazo do laço limita; verde com timeout próprio usa o menor', async () => {
    const f = clienteFalso();
    const mcp = criarProvedorMcp({ db: banco, regras, env: ENV, carregarConfig: () => CONFIG, criarCliente: () => f.cliente });
    const c = (await mcp.obter())!;
    await c.executar('mcp__openjarvis__web_search', { q: 'a' }, 8000);
    await c.executar('mcp__openjarvis__morning_digest', {}, 9000);
    expect(f.chamadas.map((x) => x.timeoutMs)).toEqual([8000, 9000]);
  });
});
