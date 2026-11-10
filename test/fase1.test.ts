import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buscarTarefa,
  CofreMemoria,
  criarTarefa,
  definirDestinoLog,
  ProvedorMemoria,
  reaplicarSegredo,
  salvarSegredoNaDory,
  tratarMensagemMcp,
  type Banco,
} from '@jarvis/core';
import {
  adaptadorTeste,
  ciclo,
  criarAdaptadorSupabase,
  criarAdaptadorVercel,
  RegistroAdaptadores,
  testarChaves,
  testarChavesSeVencido,
  TOKEN_SUPABASE,
  TOKEN_VERCEL,
  type OpcoesWorker,
} from '@jarvis/worker';
import { bancoLimpo, criarEmpresa, regrasTeste } from './ajuda.ts';

const regras = regrasTeste();
const VALOR = 'valor-super-secreto-da-api-123456';
const TK_VERCEL = 'tk_vercel_falso_abcdefghijklmnop';
const TK_SUPA = 'sbp_falso_abcdefghijklmnopqrstuv';

let banco: Banco;
let empresa: string;
let logs: string[];

interface Chamada {
  metodo: string;
  url: string;
  corpo: unknown;
  auth: string | null;
}

/** fetch falso: responde por (método, trecho da URL). */
function fetchFalso(rotas: [string, string, (c: Chamada) => [number, unknown, Record<string, string>?]][]) {
  const chamadas: Chamada[] = [];
  const f = (async (url: string, init: RequestInit = {}) => {
    const h = (init.headers ?? {}) as Record<string, string>;
    const c: Chamada = {
      metodo: init.method ?? 'GET',
      url,
      corpo: init.body ? JSON.parse(String(init.body)) : undefined,
      auth: h.authorization ?? null,
    };
    chamadas.push(c);
    const rota = rotas.find(([m, trecho]) => m === c.metodo && url.includes(trecho));
    if (!rota) return new Response(JSON.stringify({ error: { message: 'rota não simulada' } }), { status: 404 });
    const [status, corpo, cab] = rota[2](c);
    return new Response(JSON.stringify(corpo), { status, headers: cab });
  }) as unknown as typeof fetch;
  return { f, chamadas };
}

function opcoes(registro: RegistroAdaptadores, extra: Partial<OpcoesWorker> = {}): OpcoesWorker {
  return {
    banco,
    regras,
    registro,
    segredos: new ProvedorMemoria({ [TOKEN_VERCEL]: TK_VERCEL, [TOKEN_SUPABASE]: TK_SUPA, NEXUSDRIVE_TESTE_API_KEY: VALOR }),
    workerId: 'w1',
    heartbeatMs: 50,
    ...extra,
  };
}

beforeEach(async () => {
  banco = await bancoLimpo();
  empresa = await criarEmpresa(banco);
  logs = [];
  definirDestinoLog((l) => logs.push(l));
});
afterEach(async () => {
  definirDestinoLog((l) => process.stdout.write(l + '\n'));
  await banco.end();
});

async function semVazamento() {
  expect(logs.join('\n')).not.toContain(VALOR);
  for (const [t, c] of [
    ['tarefas', 'resultado'],
    ['tarefas', 'erro'],
    ['tarefas', 'parametros'],
    ['auditoria', 'detalhes'],
    ['efeitos', 'resultado'],
    ['segredos_ref', 'destinos'],
  ] as const) {
    const r = await banco.query(`select count(*)::int as n from ${t} where ${c}::text like $1`, [`%${VALOR}%`]);
    expect(r.rows[0].n, `${t}.${c}`).toBe(0);
  }
}

describe('Fase 1 — adaptador Vercel', () => {
  const estados = ['BUILDING', 'READY'];
  const rotasOk = () => {
    let i = 0;
    return fetchFalso([
      ['POST', '/v10/projects/meu-projeto/env', () => [200, { created: {} }]],
      ['GET', '/v6/deployments', () => [200, { deployments: [{ uid: 'dpl_base' }] }]],
      ['POST', '/v13/deployments', () => [200, { id: 'dpl_novo', url: 'meu-projeto.vercel.app' }]],
      ['GET', '/v13/deployments/dpl_novo', () => [200, { readyState: estados[Math.min(i++, 1)] }]],
      ['GET', '/v2/user', () => [200, { user: {} }]],
    ]);
  };

  it('cria variável de teste pelo nome do segredo, faz redeploy e espera READY', async () => {
    const { f, chamadas } = rotasOk();
    const reg = new RegistroAdaptadores().registrar(criarAdaptadorVercel({ fetchImpl: f, esperar: async () => {} }));
    const { tarefa } = await criarTarefa(
      banco,
      regras,
      {
        empresaId: empresa,
        agente: 'jarvis_infra',
        acao: 'criar_variavel_ambiente_teste',
        plataforma: 'vercel',
        parametros: { projeto: 'meu-projeto', variavel: 'API_KEY', segredo: 'NEXUSDRIVE_TESTE_API_KEY' },
        idempotencyKey: 'vercel-1',
      },
      'teste',
    );
    expect(tarefa.nivel_semaforo).toBe('verde');
    expect(await ciclo(opcoes(reg))).toBe('executou');

    const final = await buscarTarefa(banco, tarefa.id);
    expect(final?.status).toBe('concluida');
    expect(final?.resultado).toMatchObject({ ok: true, dados: { variavel: 'API_KEY', deployment_id: 'dpl_novo' } });

    const env = chamadas.find((c) => c.url.includes('/env'))!;
    expect(env.url).toContain('upsert=true');
    expect(env.corpo).toEqual({ key: 'API_KEY', value: VALOR, type: 'sensitive', target: ['preview'] });
    expect(env.auth).toBe(`Bearer ${TK_VERCEL}`);
    const novo = chamadas.find((c) => c.metodo === 'POST' && c.url.includes('/v13/deployments'))!;
    expect(novo.corpo).toEqual({ name: 'meu-projeto', deploymentId: 'dpl_base' });
    expect(chamadas.filter((c) => c.url.includes('/v13/deployments/dpl_novo')).length).toBe(2);
    await semVazamento();
    expect(logs.join('\n')).not.toContain(TK_VERCEL);
  });

  it('variável de produção é amarela e manda target production', async () => {
    const { f, chamadas } = rotasOk();
    const reg = new RegistroAdaptadores().registrar(criarAdaptadorVercel({ fetchImpl: f, esperar: async () => {} }));
    const { tarefa } = await criarTarefa(
      banco,
      regras,
      {
        empresaId: empresa,
        agente: 'jarvis_infra',
        acao: 'aplicar_variavel_producao',
        plataforma: 'vercel',
        parametros: { projeto: 'meu-projeto', variavel: 'API_KEY', segredo: 'NEXUSDRIVE_TESTE_API_KEY' },
        idempotencyKey: 'vercel-prod',
      },
      'teste',
    );
    expect(tarefa.nivel_semaforo).toBe('amarelo');
    await ciclo(opcoes(reg));
    expect(chamadas.find((c) => c.url.includes('/env'))!.corpo).toMatchObject({ target: ['production', 'preview'] });
    expect(chamadas.find((c) => c.metodo === 'POST' && c.url.includes('/v13/deployments'))!.corpo).toMatchObject({
      target: 'production',
    });
  });

  it('repetir a mesma tarefa não chama a Vercel de novo', async () => {
    const { f, chamadas } = rotasOk();
    const reg = new RegistroAdaptadores().registrar(criarAdaptadorVercel({ fetchImpl: f, esperar: async () => {} }));
    const nova = {
      empresaId: empresa,
      agente: 'jarvis_infra',
      acao: 'criar_variavel_ambiente_teste',
      plataforma: 'vercel',
      parametros: { projeto: 'meu-projeto', variavel: 'API_KEY', segredo: 'NEXUSDRIVE_TESTE_API_KEY', redeploy: false },
      idempotencyKey: 'vercel-repetida',
    };
    await criarTarefa(banco, regras, nova, 'teste');
    await ciclo(opcoes(reg));
    const r2 = await criarTarefa(banco, regras, nova, 'teste');
    expect(r2.jaExistia).toBe(true);
    expect(await ciclo(opcoes(reg))).toBe('vazio');
    expect(chamadas.filter((c) => c.url.includes('/env')).length).toBe(1);
  });

  it('403 = credencial recusada (definitivo); 429 = tenta de novo depois', async () => {
    const reg403 = new RegistroAdaptadores().registrar(
      criarAdaptadorVercel({ fetchImpl: fetchFalso([['POST', '/env', () => [403, { error: { message: 'forbidden' } }]]]).f }),
    );
    const base = {
      empresaId: empresa,
      agente: 'jarvis_infra',
      acao: 'criar_variavel_ambiente_teste',
      plataforma: 'vercel',
      parametros: { projeto: 'p', variavel: 'API_KEY', segredo: 'NEXUSDRIVE_TESTE_API_KEY' },
    };
    const { tarefa: t1 } = await criarTarefa(banco, regras, { ...base, idempotencyKey: 'a' }, 'teste');
    await ciclo(opcoes(reg403));
    expect((await buscarTarefa(banco, t1.id))).toMatchObject({ status: 'falhou', erro: { codigo: 'CREDENCIAL_RECUSADA' } });

    const reg429 = new RegistroAdaptadores().registrar(
      criarAdaptadorVercel({ fetchImpl: fetchFalso([['POST', '/env', () => [429, {}, { 'retry-after': '30' }]]]).f }),
    );
    const { tarefa: t2 } = await criarTarefa(banco, regras, { ...base, idempotencyKey: 'b' }, 'teste');
    await ciclo(opcoes(reg429));
    const r = await banco.query(`select status, proxima_tentativa_em > now() + interval '20 seconds' as espera from tarefas where id = $1`, [t2.id]);
    expect(r.rows[0]).toEqual({ status: 'pendente', espera: true });
  });

  it('deploy que termina em ERROR falha a tarefa', async () => {
    const { f } = fetchFalso([
      ['POST', '/env', () => [200, {}]],
      ['GET', '/v6/deployments', () => [200, { deployments: [{ uid: 'dpl_base' }] }]],
      ['POST', '/v13/deployments', () => [200, { id: 'dpl_x' }]],
      ['GET', '/v13/deployments/dpl_x', () => [200, { readyState: 'ERROR' }]],
    ]);
    const reg = new RegistroAdaptadores().registrar(criarAdaptadorVercel({ fetchImpl: f, esperar: async () => {} }));
    const { tarefa } = await criarTarefa(
      banco,
      regras,
      {
        empresaId: empresa,
        agente: 'jarvis_infra',
        acao: 'criar_variavel_ambiente_teste',
        plataforma: 'vercel',
        parametros: { projeto: 'p', variavel: 'API_KEY', segredo: 'NEXUSDRIVE_TESTE_API_KEY' },
        idempotencyKey: 'err',
      },
      'teste',
    );
    await ciclo(opcoes(reg));
    expect(await buscarTarefa(banco, tarefa.id)).toMatchObject({ status: 'falhou', erro: { codigo: 'DEPLOY_ERROR' } });
  });

  it('parâmetro com valor no lugar do nome do segredo é recusado', async () => {
    const reg = new RegistroAdaptadores().registrar(criarAdaptadorVercel({ fetchImpl: rotasOk().f }));
    const { tarefa } = await criarTarefa(
      banco,
      regras,
      {
        empresaId: empresa,
        agente: 'jarvis_infra',
        acao: 'criar_variavel_ambiente_teste',
        plataforma: 'vercel',
        parametros: { projeto: 'p', variavel: 'API_KEY', segredo: 'sk-live-isso-e-um-valor' },
        idempotencyKey: 'ruim',
      },
      'teste',
    );
    await ciclo(opcoes(reg));
    expect(await buscarTarefa(banco, tarefa.id)).toMatchObject({ status: 'falhou', erro: { codigo: 'PARAMETROS_INVALIDOS' } });
  });
});

describe('Fase 1 — adaptador Supabase', () => {
  it('aplica segredo de Edge Function e lista só os nomes', async () => {
    const { f, chamadas } = fetchFalso([
      ['POST', '/v1/projects/abcdefghijklmnop/secrets', () => [201, {}]],
      ['GET', '/v1/projects/abcdefghijklmnop/secrets', () => [200, [{ name: 'B', value: 'x' }, { name: 'A', value: 'y' }]]],
    ]);
    const reg = new RegistroAdaptadores().registrar(criarAdaptadorSupabase({ fetchImpl: f }));
    const { tarefa } = await criarTarefa(
      banco,
      regras,
      {
        empresaId: empresa,
        agente: 'jarvis_infra',
        acao: 'criar_segredo',
        plataforma: 'supabase',
        parametros: { projeto_ref: 'abcdefghijklmnop', nome_na_funcao: 'ASAAS_API_KEY', segredo: 'NEXUSDRIVE_TESTE_API_KEY' },
        idempotencyKey: 's1',
      },
      'teste',
    );
    expect(tarefa.nivel_semaforo).toBe('amarelo');
    await ciclo(opcoes(reg));
    expect((await buscarTarefa(banco, tarefa.id))?.status).toBe('concluida');
    expect(chamadas[0]!.corpo).toEqual([{ name: 'ASAAS_API_KEY', value: VALOR }]);
    expect(chamadas[0]!.auth).toBe(`Bearer ${TK_SUPA}`);

    const { tarefa: t2 } = await criarTarefa(
      banco,
      regras,
      {
        empresaId: empresa,
        agente: 'jarvis_infra',
        acao: 'consultar_estado',
        plataforma: 'supabase',
        parametros: { projeto_ref: 'abcdefghijklmnop' },
        idempotencyKey: 's2',
      },
      'teste',
    );
    await ciclo(opcoes(reg));
    expect((await buscarTarefa(banco, t2.id))?.resultado).toMatchObject({ dados: { nomes: ['A', 'B'] } });
    await semVazamento();
  });
});

describe('Fase 1 — Dory e rotação', () => {
  it('salva na Dory só com referência no banco; trocar o valor marca a rotação', async () => {
    const cofre = new CofreMemoria();
    const meta = { empresaId: empresa, plataforma: 'asaas', bitwardenProjeto: 'proj-nexus-drive', destinos: ['vercel:nexus:producao:ASAAS_API_KEY'] };
    expect(await salvarSegredoNaDory(banco, cofre, 'NEXUSDRIVE_COBRANCA_ASAAS_API_KEY', VALOR, meta, 'teste')).toEqual({ criado: true });
    expect([...cofre.itens.values()][0]).toMatchObject({ valor: VALOR, projeto: 'proj-nexus-drive' });
    const ref = await banco.query(`select bitwarden_secret_id, rotacionado_em from segredos_ref`);
    expect(ref.rows[0]).toMatchObject({ bitwarden_secret_id: 'bw-1', rotacionado_em: null });

    expect(await salvarSegredoNaDory(banco, cofre, 'NEXUSDRIVE_COBRANCA_ASAAS_API_KEY', VALOR + '-novo', meta, 'teste')).toEqual({ criado: false });
    expect([...cofre.itens.values()][0]!.valor).toBe(VALOR + '-novo');
    const ref2 = await banco.query(`select rotacionado_em is not null as rodou from segredos_ref`);
    expect(ref2.rows[0].rodou).toBe(true);
    await semVazamento();
  });

  it('reaplicar cria uma tarefa por destino, sem duplicar', async () => {
    const cofre = new CofreMemoria();
    await salvarSegredoNaDory(
      banco,
      cofre,
      'NEXUSDRIVE_COBRANCA_ASAAS_API_KEY',
      VALOR,
      {
        empresaId: empresa,
        plataforma: 'asaas',
        bitwardenProjeto: 'p',
        destinos: ['vercel:nexus:producao:ASAAS_API_KEY', 'supabase:abcdefghijklmnop:ASAAS_API_KEY', 'formato-errado'],
      },
      'teste',
    );
    const r = await reaplicarSegredo(banco, regras, 'NEXUSDRIVE_COBRANCA_ASAAS_API_KEY', 'teste');
    expect(r).toEqual({ criadas: 2, ignorados: ['formato-errado'] });
    expect((await reaplicarSegredo(banco, regras, 'NEXUSDRIVE_COBRANCA_ASAAS_API_KEY', 'teste')).criadas).toBe(0);
    const t = await banco.query(`select acao, plataforma, nivel_semaforo from tarefas order by plataforma`);
    expect(t.rows).toEqual([
      { acao: 'criar_segredo', plataforma: 'supabase', nivel_semaforo: 'amarelo' },
      { acao: 'aplicar_variavel_producao', plataforma: 'vercel', nivel_semaforo: 'amarelo' },
    ]);
  });
});

describe('Fase 1 — teste diário das chaves', () => {
  it('marca ok/falha por plataforma, avisa o Breno e só roda uma vez por dia', async () => {
    const cofre = new CofreMemoria();
    for (const [nome, plataforma] of [
      ['JARVIS_CORE_VERCEL_TOKEN', 'vercel'],
      ['JARVIS_CORE_SUPABASE_TOKEN', 'supabase'],
    ]) {
      await salvarSegredoNaDory(banco, cofre, nome!, 'x'.repeat(20), { empresaId: empresa, plataforma: plataforma!, bitwardenProjeto: 'jarvis-core' }, 'teste');
    }
    const reg = new RegistroAdaptadores()
      .registrar(adaptadorTeste)
      .registrar(criarAdaptadorVercel({ fetchImpl: fetchFalso([['GET', '/v2/user', () => [200, {}]]]).f }))
      .registrar(criarAdaptadorSupabase({ fetchImpl: fetchFalso([['GET', '/v1/projects', () => [401, { message: 'bad' }]]]).f }));
    const r = await testarChaves(opcoes(reg));
    expect(r).toEqual({ teste: true, vercel: true, supabase: false });
    const refs = await banco.query(`select plataforma, ultimo_teste_ok from segredos_ref order by plataforma`);
    expect(refs.rows).toEqual([
      { plataforma: 'supabase', ultimo_teste_ok: false },
      { plataforma: 'vercel', ultimo_teste_ok: true },
    ]);
    const av = await banco.query(`select conteudo->>'texto' as t from avisos`);
    expect(av.rows[0].t).toContain('supabase');
    expect(await testarChavesSeVencido(opcoes(reg))).toBe(false);
    expect(await testarChavesSeVencido(opcoes(reg), Date.now() + 25 * 3600 * 1000)).toBe(true);
  });
});

describe('Fase 1 — conector MCP', () => {
  const rpc = (method: string, params?: Record<string, unknown>, id: number | undefined = 1) =>
    tratarMensagemMcp(banco, regras, { jsonrpc: '2.0', id, method, params });

  it('inicializa e lista as ferramentas', async () => {
    expect(await rpc('initialize', { protocolVersion: '2025-06-18' })).toMatchObject({
      result: { protocolVersion: '2025-06-18', serverInfo: { name: 'jarvis' } },
    });
    expect(await tratarMensagemMcp(banco, regras, { jsonrpc: '2.0', method: 'notifications/initialized' })).toBeNull();
    const l = (await rpc('tools/list')) as { result: { tools: { name: string }[] } };
    expect(l.result.tools.map((t) => t.name)).toEqual([
      'jarvis_estado',
      'jarvis_listar_tarefas',
      'jarvis_consultar_tarefa',
      'jarvis_criar_tarefa',
      'jarvis_propor_plano',
    ]);
    expect(await rpc('metodo/inexistente')).toMatchObject({ error: { code: -32601 } });
  });

  it('o Claude cria tarefa; vermelha vai para aprovação do Breno', async () => {
    const verde = (await rpc('tools/call', {
      name: 'jarvis_criar_tarefa',
      arguments: { acao: 'teste_eco', plataforma: 'teste', empresa_id: empresa },
    })) as { result: { content: { text: string }[] } };
    expect(JSON.parse(verde.result.content[0]!.text)).toMatchObject({ nivel: 'verde', status: 'pendente' });

    const verm = (await rpc('tools/call', {
      name: 'jarvis_criar_tarefa',
      arguments: { acao: 'criar_conta', plataforma: 'hotmart', empresa_id: empresa, resumo: 'Criar conta na Hotmart' },
    })) as { result: { content: { text: string }[] } };
    expect(JSON.parse(verm.result.content[0]!.text)).toMatchObject({ nivel: 'vermelho', status: 'aguardando_aprovacao' });

    const estado = (await rpc('tools/call', { name: 'jarvis_estado', arguments: {} })) as { result: { content: { text: string }[] } };
    expect(JSON.parse(estado.result.content[0]!.text).aprovacoes_pendentes).toHaveLength(1);
  });

  it('recusa parâmetro que parece segredo', async () => {
    const r = (await rpc('tools/call', {
      name: 'jarvis_criar_tarefa',
      arguments: { acao: 'teste_eco', plataforma: 'teste', empresa_id: empresa, parametros: { api_key: 'sk-123' } },
    })) as { result: { isError: boolean; content: { text: string }[] } };
    expect(r.result.isError).toBe(true);
    expect(r.result.content[0]!.text).toContain('parece um segredo');
    const n = await banco.query(`select count(*)::int as n from tarefas`);
    expect(n.rows[0].n).toBe(0);
  });
});
