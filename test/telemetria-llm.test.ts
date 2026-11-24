import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  calcularCusto,
  cambioUsdBrl,
  criarCerebroAnthropic,
  criarGravadorBanco,
  definirDestinoLog,
  FERRAMENTAS,
  lacoFerramentas,
  precoDoModelo,
  redator,
  registrarChamada,
  tokensDoUso,
  tratarMensagemMcp,
  type Banco,
  type ChamadaLlm,
  type GravadorLlm,
} from '@jarvis/core';
import { bancoLimpo, criarEmpresa, regrasTeste } from './ajuda.ts';

const ENV_VAZIO = {};
const resposta = (corpo: unknown, status = 200) => new Response(JSON.stringify(corpo), { status });
const fetchOk = (usage: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  (async () => resposta({ content: [{ type: 'text', text: '{}' }], stop_reason: 'end_turn', usage, ...extra })) as unknown as typeof fetch;
const esperarGravacoes = (g: ReturnType<typeof gravadorEspiao>, n: number) => vi.waitFor(() => expect(g.chamadas).toHaveLength(n));

function gravadorEspiao() {
  const chamadas: ChamadaLlm[] = [];
  const gravador: GravadorLlm = { gravar: async (c) => void chamadas.push(c) };
  return { chamadas, gravador };
}

describe('preços e custo', () => {
  it('Sonnet 5.5: entrada, saída e cache com os preços oficiais', () => {
    const t = tokensDoUso({ input_tokens: 1_000_000, output_tokens: 1_000_000, cache_read_input_tokens: 1_000_000, cache_creation_input_tokens: 1_000_000 });
    // 2 + 10 + 0,10 + 2,50 = 14,60 USD
    expect(calcularCusto('claude-sonnet-5-5', t, { JARVIS_CORE_USD_BRL: '5' })).toEqual({ usd: 14.6, brl: 73, cambio: 5 });
  });

  it('Opus 5.5 e Haiku 5.5 (faixa até 100 mil tokens)', () => {
    const t = tokensDoUso({ input_tokens: 10_000, output_tokens: 2_000 });
    expect(calcularCusto('claude-opus-5-5', t, ENV_VAZIO)!.usd).toBeCloseTo(0.04 + 0.04, 6);
    expect(calcularCusto('claude-haiku-5-5', t, ENV_VAZIO)!.usd).toBeCloseTo(0.001 + 0.001, 6);
  });

  it('Haiku 5.5 com prompt acima de 100 mil tokens usa a faixa mais cara (cache conta no prompt)', () => {
    const t = tokensDoUso({ input_tokens: 50_000, cache_read_input_tokens: 60_000, output_tokens: 1_000 });
    // 50k*0,50 + 60k*0,05 + 1k*2,50 = 0,025 + 0,003 + 0,0025
    expect(calcularCusto('claude-haiku-5-5', t, ENV_VAZIO)!.usd).toBeCloseTo(0.0305, 6);
  });

  it('escrita de cache de 1 hora usa o preço próprio', () => {
    const t = tokensDoUso({ cache_creation_input_tokens: 1_000_000, cache_creation: { ephemeral_5m_input_tokens: 400_000, ephemeral_1h_input_tokens: 600_000 } });
    expect(calcularCusto('claude-sonnet-5-5', t, ENV_VAZIO)!.usd).toBeCloseTo(0.4 * 2.5 + 0.6 * 4, 6);
  });

  it('reconhece id com data e rejeita modelo desconhecido (custo nulo, nunca chute)', () => {
    expect(precoDoModelo('claude-sonnet-5-5-20261101', ENV_VAZIO)).not.toBeNull();
    expect(precoDoModelo('modelo-que-nao-existe', ENV_VAZIO)).toBeNull();
    expect(calcularCusto('modelo-que-nao-existe', tokensDoUso({ input_tokens: 10 }), ENV_VAZIO)).toBeNull();
  });

  it('preço configurável por env; JSON inválido é ignorado', () => {
    const env = { JARVIS_CORE_PRECOS_LLM: JSON.stringify({ 'claude-novo': { entrada: 1, saida: 5, cache_leitura: 0.1, cache_escrita: 1.25 } }) };
    expect(calcularCusto('claude-novo', tokensDoUso({ input_tokens: 1_000_000 }), env)!.usd).toBe(1);
    expect(precoDoModelo('claude-sonnet-5-5', { JARVIS_CORE_PRECOS_LLM: '{quebrado' })).not.toBeNull();
  });

  it('câmbio: env válido, vírgula decimal e padrão para valor ruim', () => {
    expect(cambioUsdBrl({ JARVIS_CORE_USD_BRL: '5,25' })).toBe(5.25);
    expect(cambioUsdBrl({ JARVIS_CORE_USD_BRL: 'abc' })).toBe(5.5);
    expect(cambioUsdBrl({})).toBe(5.5);
  });

  it('usage ausente ou torto vira zero', () => {
    expect(tokensDoUso(undefined)).toEqual({ entrada: 0, saida: 0, cacheLeitura: 0, cacheEscrita: 0, cacheEscrita1h: 0 });
    expect(tokensDoUso({ input_tokens: -3, output_tokens: Number.NaN }).saida).toBe(0);
  });
});

describe('telemetria no cérebro', () => {
  it('grava modelo, tokens, custo, latência, status e stop_reason', async () => {
    const g = gravadorEspiao();
    let t = 1000;
    const agora = () => (t += 250); // 1ª leitura 1250, 2ª 1500 => 250 ms
    const cerebro = criarCerebroAnthropic({
      chave: 'sk-ant-falsa',
      modelo: 'claude-sonnet-5-5',
      gravador: g.gravador,
      agora,
      fetchImpl: fetchOk({ input_tokens: 1000, output_tokens: 500, cache_read_input_tokens: 2000, cache_creation_input_tokens: 100 }),
    });
    const texto = await cerebro.pensar('sistema', [{ role: 'user', content: 'oi' }], { tarefaId: 'abc', finalidade: 'teste' });
    expect(texto).toBe('{}');
    await esperarGravacoes(g, 1);
    expect(g.chamadas[0]).toMatchObject({
      modelo: 'claude-sonnet-5-5',
      finalidade: 'teste',
      tarefaId: 'abc',
      tokensEntrada: 1000,
      tokensSaida: 500,
      tokensCacheLeitura: 2000,
      tokensCacheEscrita: 100,
      latenciaMs: 250,
      statusHttp: 200,
      stopReason: 'end_turn',
      erro: null,
    });
    // (1000*2 + 500*10 + 2000*0,1 + 100*2,5) / 1e6 = 0,007450 USD
    expect(g.chamadas[0]!.custoUsd).toBeCloseTo(0.00745, 6);
    expect(g.chamadas[0]!.custoBrl).toBeCloseTo(0.00745 * cambioUsdBrl(), 5);
  });

  it('finalidade padrão: plano em pensar, conversa em pensarComFerramentas', async () => {
    const g = gravadorEspiao();
    const cerebro = criarCerebroAnthropic({ chave: 'k', gravador: g.gravador, fetchImpl: fetchOk({ input_tokens: 1, output_tokens: 1 }) });
    await cerebro.pensar('s', [{ role: 'user', content: 'x' }]);
    await cerebro.pensarComFerramentas!('s', 'pergunta', [], async () => '');
    await esperarGravacoes(g, 2);
    expect(g.chamadas.map((c) => c.finalidade)).toEqual(['plano', 'conversa']);
    expect(g.chamadas.map((c) => c.modelo)).toEqual(['claude-sonnet-5-5', 'claude-haiku-5-5']);
  });

  it('cada rodada do laço de ferramentas vira uma chamada', async () => {
    const g = gravadorEspiao();
    const respostas = [
      { content: [{ type: 'tool_use', id: 't1', name: 'x', input: {} }], stop_reason: 'tool_use', usage: { input_tokens: 10, output_tokens: 5 } },
      { content: [{ type: 'text', text: 'pronto' }], stop_reason: 'end_turn', usage: { input_tokens: 20, output_tokens: 7 } },
    ];
    const f = (async () => resposta(respostas.shift())) as unknown as typeof fetch;
    const cerebro = criarCerebroAnthropic({ chave: 'k', gravador: g.gravador, fetchImpl: f });
    const out = await cerebro.pensarComFerramentas!('s', 'p', [{ name: 'x', description: 'd', input_schema: { type: 'object' } }] as never, async () => 'ok', {
      contexto: { empresaId: 'e1' },
    });
    expect(out).toBe('pronto');
    await esperarGravacoes(g, 2);
    expect(g.chamadas.map((c) => [c.tokensEntrada, c.stopReason, c.empresaId])).toEqual([
      [10, 'tool_use', 'e1'],
      [20, 'end_turn', 'e1'],
    ]);
  });

  it('falha do gravador (assíncrona ou síncrona) não quebra a chamada', async () => {
    const avisos: string[] = [];
    definirDestinoLog((l) => avisos.push(l));
    try {
      for (const gravador of [
        { gravar: async () => Promise.reject(new Error('banco caiu')) },
        {
          gravar: () => {
            throw new Error('explodiu na hora');
          },
        },
      ] as GravadorLlm[]) {
        const cerebro = criarCerebroAnthropic({ chave: 'k', gravador, fetchImpl: fetchOk({ input_tokens: 5, output_tokens: 5 }) });
        await expect(cerebro.pensar('s', [{ role: 'user', content: 'x' }])).resolves.toBe('{}');
      }
      await vi.waitFor(() => expect(avisos.filter((a) => a.includes('telemetria de LLM não gravada'))).toHaveLength(2));
    } finally {
      definirDestinoLog((l) => process.stdout.write(l + '\n'));
    }
  });

  it('a gravação não bloqueia a resposta (gravador lento)', async () => {
    const gravador: GravadorLlm = { gravar: () => new Promise(() => {}) }; // nunca termina
    const cerebro = criarCerebroAnthropic({ chave: 'k', gravador, fetchImpl: fetchOk({ input_tokens: 1, output_tokens: 1 }) });
    await expect(cerebro.pensar('s', [{ role: 'user', content: 'x' }])).resolves.toBe('{}');
  });

  it('chamada com erro HTTP é registrada e o erro original continua subindo', async () => {
    const g = gravadorEspiao();
    redator.registrar('chave_teste', 'sk-ant-api03-segredosegredosegredo');
    const f = (async () => resposta({ error: { message: 'sobrecarregado sk-ant-api03-segredosegredosegredo' } }, 529)) as unknown as typeof fetch;
    const cerebro = criarCerebroAnthropic({ chave: 'k', modelo: 'claude-haiku-5-5', gravador: g.gravador, fetchImpl: f });
    await expect(cerebro.pensar('s', [{ role: 'user', content: 'x' }])).rejects.toMatchObject({ status: 529 });
    await esperarGravacoes(g, 1);
    expect(g.chamadas[0]).toMatchObject({ modelo: 'claude-haiku-5-5', statusHttp: 529, tokensEntrada: 0, tokensSaida: 0, custoUsd: 0 });
    expect(g.chamadas[0]!.erro).toContain('SERVIDOR');
    expect(g.chamadas[0]!.erro).not.toContain('segredosegredo');
  });

  it('falha de rede é registrada com status 0', async () => {
    const g = gravadorEspiao();
    const f = (async () => {
      throw new Error('ECONNRESET');
    }) as unknown as typeof fetch;
    const cerebro = criarCerebroAnthropic({ chave: 'k', gravador: g.gravador, fetchImpl: f });
    await expect(cerebro.pensar('s', [{ role: 'user', content: 'x' }])).rejects.toThrow();
    await esperarGravacoes(g, 1);
    expect(g.chamadas[0]).toMatchObject({ statusHttp: 0 });
    expect(g.chamadas[0]!.erro).toContain('REDE');
  });

  it('sem gravador funciona como antes e registrarChamada(undefined) é inócuo', async () => {
    const cerebro = criarCerebroAnthropic({ chave: 'k', fetchImpl: fetchOk({ input_tokens: 1, output_tokens: 1 }) });
    await expect(cerebro.pensar('s', [{ role: 'user', content: 'x' }])).resolves.toBe('{}');
    await expect(registrarChamada(undefined, () => ({}) as ChamadaLlm)).resolves.toBeUndefined();
  });

  it('modelo sem preço grava custo nulo', async () => {
    const g = gravadorEspiao();
    const cerebro = criarCerebroAnthropic({ chave: 'k', modelo: 'claude-futuro-9', gravador: g.gravador, fetchImpl: fetchOk({ input_tokens: 10, output_tokens: 10 }) });
    await cerebro.pensar('s', [{ role: 'user', content: 'x' }]);
    await esperarGravacoes(g, 1);
    expect(g.chamadas[0]).toMatchObject({ custoUsd: null, custoBrl: null, tokensEntrada: 10 });
  });

  it('lacoFerramentas segue igual (regressão)', async () => {
    const r = await lacoFerramentas(async () => ({ content: [{ type: 'text', text: 'oi' }], stop_reason: 'end_turn' }), 'p', async () => '');
    expect(r).toBe('oi');
  });
});

describe('gravador no banco simulado', () => {
  it('ids que não são UUID viram nulos e a ordem dos parâmetros é a da tabela', async () => {
    const query = vi.fn(async () => ({ rows: [] }));
    const base: ChamadaLlm = {
      modelo: 'm', finalidade: 'f', tarefaId: 'nao-uuid', empresaId: '11111111-1111-4111-8111-111111111111',
      tokensEntrada: 1, tokensSaida: 2, tokensCacheLeitura: 3, tokensCacheEscrita: 4,
      custoUsd: 0.5, custoBrl: 2.5, latenciaMs: 9, statusHttp: 200, erro: null, stopReason: 'end_turn',
    };
    await criarGravadorBanco({ query } as unknown as Pick<Banco, 'query'>).gravar(base);
    const [sql, params] = query.mock.calls[0] as unknown as [string, unknown[]];
    expect(sql).toContain('insert into llm_chamadas');
    expect(params).toEqual([base.empresaId, null, null, 'm', 'f', 1, 2, 3, 4, 0.5, 2.5, 9, 200, null, 'end_turn']);
  });
});

describe('telemetria no Postgres e tool jarvis_custos', () => {
  let banco: Banco;
  let empresa: string;
  const regras = regrasTeste();
  const chamar = async (args: Record<string, unknown>) => {
    const r = (await tratarMensagemMcp(banco, regras, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'jarvis_custos', arguments: args } })) as {
      result: { isError?: boolean; content: { text: string }[] };
    };
    return r.result;
  };
  beforeAll(async () => {
    banco = await bancoLimpo();
    empresa = await criarEmpresa(banco);
    const g = criarGravadorBanco(banco);
    const base = { tokensCacheLeitura: 0, tokensCacheEscrita: 0, statusHttp: 200, erro: null, stopReason: 'end_turn', empresaId: empresa };
    await g.gravar({ ...base, modelo: 'claude-sonnet-5-5', finalidade: 'plano', tokensEntrada: 100, tokensSaida: 50, custoUsd: 0.5, custoBrl: 2.75, latenciaMs: 400 });
    await g.gravar({ ...base, modelo: 'claude-sonnet-5-5', finalidade: 'plano', tokensEntrada: 200, tokensSaida: 10, custoUsd: 0.25, custoBrl: 1.375, latenciaMs: 600 });
    await g.gravar({ ...base, modelo: 'claude-haiku-5-5', finalidade: 'conversa', tokensEntrada: 10, tokensSaida: 5, custoUsd: 0.01, custoBrl: 0.055, latenciaMs: 100 });
    await g.gravar({ ...base, modelo: 'claude-haiku-5-5', finalidade: 'conversa', tokensEntrada: 0, tokensSaida: 0, custoUsd: 0, custoBrl: 0, latenciaMs: 30, statusHttp: 529, erro: 'SERVIDOR: HTTP 529', stopReason: null });
    await g.gravar({ ...base, modelo: 'modelo-novo', finalidade: 'oferta', tokensEntrada: 1, tokensSaida: 1, custoUsd: null, custoBrl: null, latenciaMs: 10 });
  });
  afterAll(async () => {
    await banco.end();
  });

  it('a tool está no catálogo MCP', () => {
    expect(FERRAMENTAS.map((f) => f.name)).toContain('jarvis_custos');
  });

  it('agrupa por modelo somando tokens, custo e erros', async () => {
    const r = await chamar({ agrupar: 'modelo' });
    const j = JSON.parse(r.content[0]!.text);
    expect(j.agrupado_por).toBe('modelo');
    const sonnet = j.grupos.find((g: { grupo: string }) => g.grupo === 'claude-sonnet-5-5');
    expect(sonnet).toMatchObject({ chamadas: 2, tokens_entrada: 300, tokens_saida: 60, custo_usd: 0.75, custo_brl: 4.125, latencia_media_ms: 500, latencia_max_ms: 600 });
    expect(j.grupos.find((g: { grupo: string }) => g.grupo === 'claude-haiku-5-5')).toMatchObject({ chamadas: 2, erros: 1 });
    expect(j.grupos.find((g: { grupo: string }) => g.grupo === 'modelo-novo')).toMatchObject({ sem_preco: 1 });
    expect(j.total).toMatchObject({ chamadas: 5, erros: 1, sem_preco: 1, custo_usd: 0.76 });
  });

  it('agrupa por roteiro (finalidade) e por dia', async () => {
    const porRoteiro = JSON.parse((await chamar({ agrupar: 'roteiro' })).content[0]!.text);
    expect(porRoteiro.grupos.map((g: { grupo: string }) => g.grupo)).toEqual(['conversa', 'oferta', 'plano']);
    const porDia = JSON.parse((await chamar({ dias: 1 })).content[0]!.text);
    expect(porDia.agrupado_por).toBe('dia');
    expect(porDia.grupos.reduce((s: number, g: { chamadas: number }) => s + g.chamadas, 0)).toBe(5);
  });

  it('respeita o período (desde/ate) e valida argumentos', async () => {
    const futuro = JSON.parse((await chamar({ desde: '2999-01-01T00:00:00Z' })).content[0]!.text);
    expect(futuro.total.chamadas).toBe(0);
    const passado = JSON.parse((await chamar({ ate: '2000-01-01T00:00:00Z', dias: 366 })).content[0]!.text);
    expect(passado.total.chamadas).toBe(0);
    expect((await chamar({ agrupar: 'banana' })).isError).toBe(true);
    expect((await chamar({ desde: 'ontem' })).isError).toBe(true);
  });

  it('view llm_custos_diarios resume por dia e modelo; anon/authenticated não leem a tabela', async () => {
    const v = await banco.query(`select modelo, chamadas, erros, tokens_entrada, custo_usd from llm_custos_diarios order by modelo`);
    expect(v.rows.map((x) => [x.modelo, x.chamadas, x.erros])).toEqual([['claude-haiku-5-5', 2, 1], ['claude-sonnet-5-5', 2, 0], ['modelo-novo', 1, 0]]);
    const rls = await banco.query(`select relrowsecurity from pg_class where relname = 'llm_chamadas'`);
    expect(rls.rows[0]!.relrowsecurity).toBe(true);
    const grants = await banco.query(`select count(*)::int as n from information_schema.role_table_grants where table_name = 'llm_chamadas' and grantee in ('anon','authenticated')`);
    expect(grants.rows[0]!.n).toBe(0);
  });

  it('tarefa_id e empresa_id reais são gravados', async () => {
    const tarefa = (
      await banco.query(
        `insert into tarefas (empresa_id, agente, acao, idempotency_key, nivel_semaforo) values ($1,'jarvis_infra','x','k-telemetria','verde') returning id`,
        [empresa],
      )
    ).rows[0]!.id as string;
    await criarGravadorBanco(banco).gravar({
      modelo: 'claude-sonnet-5-5', finalidade: 'oferta', tarefaId: tarefa, empresaId: empresa,
      tokensEntrada: 1, tokensSaida: 1, tokensCacheLeitura: 0, tokensCacheEscrita: 0,
      custoUsd: 0, custoBrl: 0, latenciaMs: 1, statusHttp: 200, erro: null, stopReason: null,
    });
    const r = await banco.query(`select tarefa_id, empresa_id from llm_chamadas where tarefa_id = $1`, [tarefa]);
    expect(r.rows[0]).toEqual({ tarefa_id: tarefa, empresa_id: empresa });
  });
});
