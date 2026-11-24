import { describe, expect, it } from 'vitest';
import {
  configModelosPadrao,
  criarCerebroAnthropic,
  degrauDoModelo,
  ErroHttp,
  escolherModelo,
  executarComEscada,
  GuardasPorEscopo,
  lacoFerramentas,
  loopGuardPadrao,
  LoopGuard,
  pontuarComplexidade,
  type ChamadaLlm,
  type ConfigModelos,
  type GravadorLlm,
} from '@jarvis/core';
import { regrasTeste } from './ajuda.ts';

// Item 792: escada de modelos, fallback e LoopGuard. Sem rede e sem banco: fetch falso, relógio e espera injetados.
const H = 'claude-haiku-5-5';
const S = 'claude-sonnet-5-5';
const O = 'claude-opus-5-5';
const cfg = (extra: Partial<ConfigModelos> = {}): ConfigModelos => ({ ...configModelosPadrao(), ...extra });
const erro = (status: number) => new ErroHttp(status, { tipo: 'temporario', codigo: status === 0 ? 'REDE' : 'SERVIDOR', mensagem: `HTTP ${status}` });

describe('escada: seleção do modelo', () => {
  it('o regras.yaml traz a escada e o mapa finalidade→degrau', () => {
    const m = regrasTeste().modelos;
    expect(m.degraus).toEqual({ haiku: H, sonnet: S, opus: O });
    expect(m.permitir_opus).toBe(false);
    expect(m.por_finalidade).toEqual({ conversa: 'haiku', plano: 'sonnet', oferta: 'sonnet', proativo: 'sonnet' });
    expect(regrasTeste().loop_guard).toMatchObject({ max_chamadas_mesma_tool: 8, repeticoes_ciclo: 2, rodadas_sem_progresso: 3 });
  });

  it('finalidade mapeada escolhe o degrau do mapa, ignorando a heurística', () => {
    const c = cfg();
    expect(escolherModelo(c, { finalidade: 'conversa', texto: 'analise o preço e o código' })).toMatchObject({ modelo: H, motivo: 'finalidade' });
    expect(escolherModelo(c, { finalidade: 'plano' })).toMatchObject({ modelo: S, degrau: 'sonnet', motivo: 'finalidade' });
    expect(escolherModelo(c, { finalidade: 'oferta' }).modelo).toBe(S);
  });

  it('finalidade fora do mapa usa a heurística de complexidade', () => {
    const c = cfg();
    expect(escolherModelo(c, { finalidade: 'outro', texto: 'oi, tudo bem?', nTools: 1 })).toMatchObject({ modelo: H, motivo: 'heuristica', pontos: 0 });
    // categoria de palavra (dinheiro, com acento e maiúscula) sobe para Sonnet
    expect(escolherModelo(c, { texto: 'Qual a MARGEM e o preço do reembolso?' })).toMatchObject({ modelo: S, motivo: 'heuristica' });
    expect(escolherModelo(c, { texto: 'refatore esta função em TypeScript' }).modelo).toBe(S);
    expect(escolherModelo(c, { texto: 'faça uma análise comparativa' }).modelo).toBe(S);
    // prompt grande (+2) e muitas tools (+2) sozinhos sobem; meio-termo (+1) não
    expect(escolherModelo(c, { texto: 'x'.repeat(21_000) }).modelo).toBe(S);
    expect(escolherModelo(c, { texto: 'oi', nTools: 12 }).modelo).toBe(S);
    expect(escolherModelo(c, { texto: 'x'.repeat(7000), nTools: 3 }).modelo).toBe(H);
    expect(pontuarComplexidade(c, 'x'.repeat(7000), 6)).toBe(2);
  });

  it('heurística no topo pede Opus, mas sem permitir_opus cai para Sonnet', () => {
    const pesado = 'analise o código (sql) e o preço do pagamento. ' + 'x'.repeat(21_000);
    expect(pontuarComplexidade(cfg(), pesado, 12)).toBe(10);
    expect(escolherModelo(cfg(), { texto: pesado, nTools: 12 })).toMatchObject({ modelo: S, degrau: 'sonnet', motivo: 'opus_bloqueado' });
    expect(escolherModelo(cfg({ permitir_opus: true }), { texto: pesado, nTools: 12 })).toMatchObject({ modelo: O, degrau: 'opus', motivo: 'heuristica' });
  });

  it('override explícito vale sobre mapa e heurística; Opus por override também exige a flag', () => {
    expect(escolherModelo(cfg(), { finalidade: 'conversa', modelo: S })).toMatchObject({ modelo: S, degrau: 'sonnet', motivo: 'override' });
    expect(escolherModelo(cfg(), { finalidade: 'plano', modelo: H }).modelo).toBe(H);
    expect(escolherModelo(cfg(), { modelo: O })).toMatchObject({ modelo: S, motivo: 'opus_bloqueado' });
    expect(escolherModelo(cfg({ permitir_opus: true }), { modelo: O })).toMatchObject({ modelo: O, degrau: 'opus' });
    // modelo fora da escada passa como veio (sem degrau, logo sem troca de degrau)
    expect(escolherModelo(cfg(), { modelo: 'modelo-externo' })).toMatchObject({ modelo: 'modelo-externo', degrau: null });
    expect(degrauDoModelo(cfg(), 'claude-haiku-5-5-20261101')).toBe('haiku');
  });

  it('o mapa por finalidade pode ser trocado na config', () => {
    expect(escolherModelo(cfg({ por_finalidade: { conversa: 'sonnet' } }), { finalidade: 'conversa' }).modelo).toBe(S);
  });
});

describe('escada: fallback', () => {
  const semEspera = { dormir: async () => undefined, timeoutMs: 60_000 };

  it('529 repete com backoff no mesmo modelo e depois cai Sonnet→Haiku', async () => {
    const esperas: number[] = [];
    const vistas: { modelo: string; fallbackDe: string | null }[] = [];
    const r = await executarComEscada(
      cfg(),
      escolherModelo(cfg(), { modelo: S }),
      async (t) => {
        vistas.push({ modelo: t.modelo, fallbackDe: t.fallbackDe });
        if (t.modelo === S) throw erro(529);
        return 'ok';
      },
      { ...semEspera, dormir: async (ms) => void esperas.push(ms) },
    );
    expect(vistas).toEqual([
      { modelo: S, fallbackDe: null },
      { modelo: S, fallbackDe: null },
      { modelo: H, fallbackDe: S },
    ]);
    expect(esperas).toEqual([300]);
    expect(r).toMatchObject({ resposta: 'ok', modelo: H, trocas: 1, tentativas: 3 });
  });

  it.each([429, 500, 502, 503, 504, 529, 0])('status %i é transitório (e 0 = rede/timeout)', async (status) => {
    let n = 0;
    const r = await executarComEscada(cfg(), escolherModelo(cfg(), { modelo: S }), async () => (++n === 1 ? Promise.reject(erro(status)) : 'ok'), semEspera);
    expect(r).toMatchObject({ resposta: 'ok', modelo: S, trocas: 0, tentativas: 2 });
  });

  it('erro definitivo (400/401) não repete nem troca', async () => {
    let n = 0;
    await expect(executarComEscada(cfg(), escolherModelo(cfg(), { modelo: S }), async () => (n++, Promise.reject(erro(401))), semEspera)).rejects.toMatchObject({ status: 401 });
    expect(n).toBe(1);
  });

  it('Haiku com resposta vazia sobe para Sonnet', async () => {
    const usados: string[] = [];
    const r = await executarComEscada(
      cfg(),
      escolherModelo(cfg(), { modelo: H }),
      async (t) => (usados.push(t.modelo), t.modelo === H ? '' : 'resposta'),
      { ...semEspera, valida: (x) => x.trim() !== '' },
    );
    expect(usados).toEqual([H, S]);
    expect(r).toMatchObject({ resposta: 'resposta', modelo: S, trocas: 1 });
  });

  it('Haiku sobrecarregado cai para Sonnet', async () => {
    const r = await executarComEscada(cfg(), escolherModelo(cfg(), { modelo: H }), async (t) => (t.modelo === H ? Promise.reject(erro(503)) : 'ok'), semEspera);
    expect(r).toMatchObject({ modelo: S, trocas: 1, tentativas: 3 });
  });

  it('limite de trocas: com max_trocas=1 não há segunda troca; devolve a resposta ruim que já veio', async () => {
    const c = cfg({ fallback: { ...cfg().fallback, max_trocas: 1, tentativas_por_degrau: 1 } });
    const usados: string[] = [];
    // Haiku vazio → Sonnet (troca 1); Sonnet 529 → sem troca disponível: devolve a resposta (vazia) do Haiku
    const r = await executarComEscada(c, escolherModelo(c, { modelo: H }), async (t) => (usados.push(t.modelo), t.modelo === H ? '' : Promise.reject(erro(529))), { ...semEspera, valida: (x) => x !== '' });
    expect(usados).toEqual([H, S]);
    expect(r).toMatchObject({ resposta: '', trocas: 1 });
    // sem resposta anterior, o erro propaga
    await expect(executarComEscada(c, escolherModelo(c, { modelo: S }), async (t) => (t.modelo === S ? Promise.reject(erro(529)) : Promise.reject(erro(500))), semEspera)).rejects.toMatchObject({ status: 500 });
  });

  it('máximo de 2 trocas por padrão, sem voltar a modelo que já falhou', async () => {
    const c = cfg({ permitir_opus: true });
    const usados: string[] = [];
    // Haiku vazio → Sonnet vazio → Opus vazio: 2 trocas; sem terceira, devolve a última resposta (vazia)
    const r = await executarComEscada(c, escolherModelo(c, { modelo: H }), async (t) => (usados.push(t.modelo), ''), { ...semEspera, valida: (x) => x !== '' });
    expect(usados).toEqual([H, S, O]);
    expect(r).toMatchObject({ modelo: O, trocas: 2, resposta: '' });
    // Sonnet fora do ar: vai para Haiku e, com Haiku fora também, não volta ao Sonnet
    const u2: string[] = [];
    await expect(executarComEscada(cfg(), escolherModelo(cfg(), { modelo: S }), async (t) => (u2.push(t.modelo), Promise.reject(erro(529))), semEspera)).rejects.toMatchObject({ status: 529 });
    expect(u2).toEqual([S, S, H, H]);
  });

  it('sem Opus liberado, Sonnet com resposta vazia devolve a resposta (não há degrau acima)', async () => {
    const r = await executarComEscada(cfg(), escolherModelo(cfg(), { modelo: S }), async () => '', { ...semEspera, valida: (x) => x !== '' });
    expect(r).toMatchObject({ modelo: S, trocas: 0, resposta: '' });
  });

  it('modelo fora da escada repete, mas não troca de degrau', async () => {
    const usados: string[] = [];
    await expect(executarComEscada(cfg(), escolherModelo(cfg(), { modelo: 'x-externo' }), async (t) => (usados.push(t.modelo), Promise.reject(erro(500))), semEspera)).rejects.toBeInstanceOf(ErroHttp);
    expect(usados).toEqual(['x-externo', 'x-externo']);
  });

  it('respeita o prazo total: sem tempo, não tenta de novo', async () => {
    let t = 0;
    let n = 0;
    await expect(
      executarComEscada(cfg(), escolherModelo(cfg(), { modelo: S }), async () => (n++, (t += 5000), Promise.reject(erro(529))), { ...semEspera, timeoutMs: 6000, agora: () => t }),
    ).rejects.toBeInstanceOf(ErroHttp);
    expect(n).toBe(2);
  });
});

describe('cerebro com escada: telemetria por tentativa', () => {
  const resp = (corpo: unknown, status = 200) => new Response(JSON.stringify(corpo), { status });
  const ok = (texto: string) => resp({ content: [{ type: 'text', text: texto }], stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 5 } });
  function ambiente(respostas: (modelo: string) => Response) {
    const pedidos: string[] = [];
    const chamadas: ChamadaLlm[] = [];
    const gravador: GravadorLlm = { gravar: async (c) => void chamadas.push(c) };
    const fetchImpl = (async (_u: string, init: RequestInit) => {
      const modelo = (JSON.parse(String(init.body)) as { model: string }).model;
      pedidos.push(modelo);
      return respostas(modelo);
    }) as unknown as typeof fetch;
    return { pedidos, chamadas, gravador, fetchImpl };
  }

  it('Sonnet 529 duas vezes → Haiku; cada tentativa grava o modelo real e fallback_de', async () => {
    const a = ambiente((m) => (m === S ? resp({ error: { message: 'overloaded' } }, 529) : ok('{"a":1}')));
    const c = criarCerebroAnthropic({ chave: 'k', fetchImpl: a.fetchImpl, gravador: a.gravador, escada: cfg(), dormir: async () => undefined });
    expect(await c.pensar('s', [{ role: 'user', content: 'faça o plano' }])).toBe('{"a":1}');
    expect(a.pedidos).toEqual([S, S, H]);
    await new Promise((r) => setTimeout(r, 10));
    expect(a.chamadas.map((x) => [x.modelo, x.statusHttp, x.fallbackDe ?? null, x.finalidade])).toEqual([
      [S, 529, null, 'plano'],
      [S, 529, null, 'plano'],
      [H, 200, S, 'plano'],
    ]);
  });

  it('conversa: finalidade usa Haiku; override por chamada (contexto.modelo) usa o modelo pedido', async () => {
    const a = ambiente(() => ok('oi'));
    const c = criarCerebroAnthropic({ chave: 'k', fetchImpl: a.fetchImpl, escada: cfg() });
    await c.pensarComFerramentas!('s', 'oi', [], async () => '', {});
    await c.pensarComFerramentas!('s', 'oi', [], async () => '', { contexto: { modelo: S } });
    await c.pensar('s', [{ role: 'user', content: 'x' }], { finalidade: 'conversa' });
    expect(a.pedidos).toEqual([H, S, H]);
  });

  it('resposta vazia do Haiku sobe para Sonnet; Opus por override sem flag vira Sonnet', async () => {
    const a = ambiente((m) => (m === H ? resp({ content: [], stop_reason: 'end_turn' }) : ok('veio')));
    const c = criarCerebroAnthropic({ chave: 'k', fetchImpl: a.fetchImpl, escada: cfg() });
    expect(await c.pensarComFerramentas!('s', 'oi', [], async () => '')).toBe('veio');
    expect(a.pedidos).toEqual([H, S]);
    a.pedidos.length = 0;
    await c.pensar('s', [{ role: 'user', content: 'x' }], { modelo: O });
    expect(a.pedidos).toEqual([S]);
  });

  it('sem escada configurada o comportamento antigo é mantido (um modelo, sem repetição)', async () => {
    const a = ambiente(() => resp({ error: { message: 'x' } }, 529));
    const c = criarCerebroAnthropic({ chave: 'k', fetchImpl: a.fetchImpl });
    await expect(c.pensar('s', [{ role: 'user', content: 'x' }])).rejects.toBeInstanceOf(ErroHttp);
    expect(a.pedidos).toEqual([S]);
  });
});

describe('LoopGuard', () => {
  const cfgG = (extra = {}) => ({ ...loopGuardPadrao(), ...extra });

  it('(a) ciclo A→B→A→B com os mesmos argumentos', () => {
    const g = new LoopGuard(cfgG());
    expect(g.antes('buscar', { q: 1 })).toBeNull();
    expect(g.antes('ler', { id: 2 })).toBeNull();
    expect(g.antes('buscar', { q: 1 })).toBeNull();
    const v = g.antes('ler', { id: 2 });
    expect(v).toMatchObject({ padrao: 'ciclo' });
    expect(v!.motivo).toMatch(/buscar e ler/);
    // travado: tudo o que vier depois também é negado
    expect(g.antes('outra', {})).toBe(v);
  });

  it('(a) argumentos diferentes não formam ciclo; A,A,A,A tampouco', () => {
    const g = new LoopGuard(cfgG());
    for (const [t, a] of [['buscar', { q: 1 }], ['ler', { id: 1 }], ['buscar', { q: 2 }], ['ler', { id: 2 }]] as const) expect(g.antes(t, a)).toBeNull();
    const h = new LoopGuard(cfgG());
    for (let i = 0; i < 4; i++) expect(h.antes('x', { i: 1 })).toBeNull();
  });

  it('(a) repeticoes_ciclo maior exige mais voltas', () => {
    const g = new LoopGuard(cfgG({ repeticoes_ciclo: 3 }));
    const seq = ['A', 'B', 'A', 'B', 'A'];
    for (const t of seq) expect(g.antes(t, {})).toBeNull();
    expect(g.antes('B', {})).toMatchObject({ padrao: 'ciclo' });
  });

  it('(b) a mesma tool mais de N vezes na tarefa', () => {
    const g = new LoopGuard(cfgG({ max_chamadas_mesma_tool: 3 }));
    for (let i = 0; i < 3; i++) expect(g.antes('pesquisar', { i })).toBeNull();
    const v = g.antes('pesquisar', { i: 99 });
    expect(v).toMatchObject({ padrao: 'mesma_tool', tool: 'pesquisar' });
    expect(v!.motivo).toMatch(/3 vezes/);
  });

  it('(c) N rodadas sem progresso; resultado novo ou tool nova zera a contagem', () => {
    const g = new LoopGuard(cfgG({ rodadas_sem_progresso: 3 }));
    const rodada = (tool: string, args: object, saida: string) => {
      g.antes(tool, args as Record<string, unknown>);
      g.depois(tool, saida);
      return g.fecharRodada();
    };
    expect(rodada('ler', { a: 1 }, 'X')).toBeNull(); // tool nova + resultado novo
    expect(rodada('ler', { a: 2 }, 'X')).toBeNull(); // sem novidade (1)
    expect(rodada('ler', { a: 3 }, 'Y')).toBeNull(); // resultado novo: zera
    expect(rodada('ler', { a: 4 }, 'Y')).toBeNull(); // 1
    expect(rodada('ler', { a: 5 }, 'Y')).toBeNull(); // 2
    expect(rodada('ler', { a: 6 }, 'Y')).toMatchObject({ padrao: 'sem_progresso' }); // 3
  });

  it('desligado, nunca dispara', () => {
    const g = new LoopGuard(cfgG({ ativo: false, max_chamadas_mesma_tool: 1 }));
    for (let i = 0; i < 5; i++) expect(g.antes('x', {})).toBeNull();
    expect(g.fecharRodada()).toBeNull();
  });
});

describe('LoopGuard no laço de tools', () => {
  const usoTool = (id: string, name: string, input: object) => ({ type: 'tool_use' as const, id, name, input: input as Record<string, unknown> });
  const pedeTools = (...usos: ReturnType<typeof usoTool>[]) => async () => ({ content: usos, stop_reason: 'tool_use' });

  it('interrompe no ciclo A→B→A→B, audita e devolve o motivo (sem chamar o modelo de novo)', async () => {
    const roteiro = [usoTool('1', 'buscar', { q: 1 }), usoTool('2', 'ler', { id: 2 }), usoTool('3', 'buscar', { q: 1 }), usoTool('4', 'ler', { id: 2 })];
    let i = 0;
    let modelo = 0;
    const executadas: string[] = [];
    const auditoria: string[] = [];
    const r = await lacoFerramentas(
      async () => (modelo++, pedeTools(roteiro[i++]!)()),
      'pergunta',
      async (nome) => (executadas.push(nome), `r-${executadas.length}`),
      { rodadas: 10, loopGuard: loopGuardPadrao(), aoLoop: (v) => void auditoria.push(v.padrao) },
    );
    expect(r).toMatch(/Parei para não entrar em loop: ciclo detectado/);
    expect(executadas).toEqual(['buscar', 'ler', 'buscar']);
    expect(modelo).toBe(4);
    expect(auditoria).toEqual(['ciclo']);
  });

  it('interrompe quando a mesma tool passa do limite por conversa', async () => {
    let n = 0;
    const r = await lacoFerramentas(async () => pedeTools(usoTool(String(n), 'pesquisar', { n: n++ }))(), 'p', async () => `res-${n}`, {
      rodadas: 20,
      loopGuard: { ...loopGuardPadrao(), max_chamadas_mesma_tool: 3 },
    });
    expect(r).toMatch(/pesquisar já foi chamada 3 vezes/);
    expect(n).toBe(4);
  });

  it('interrompe após N rodadas sem progresso (resultado sempre igual)', async () => {
    let n = 0;
    const r = await lacoFerramentas(async () => pedeTools(usoTool(String(n), 'status', { n: n++ }))(), 'p', async () => 'sempre igual', {
      rodadas: 20,
      loopGuard: { ...loopGuardPadrao(), rodadas_sem_progresso: 3 },
    });
    expect(r).toMatch(/3 rodadas seguidas sem progresso/);
    expect(n).toBe(4); // 1ª rodada traz novidade; as 3 seguintes não
  });

  it('falha ao auditar não derruba a conversa; fluxo normal não é afetado', async () => {
    let n = 0;
    const r = await lacoFerramentas(async () => pedeTools(usoTool('a', 'x', { n: n++ }))(), 'p', async () => 'igual', {
      rodadas: 20,
      loopGuard: { ...loopGuardPadrao(), rodadas_sem_progresso: 2 },
      aoLoop: () => Promise.reject(new Error('banco fora')),
    });
    expect(r).toMatch(/Parei/);
    const normal = await lacoFerramentas(
      async (m) => (m.length < 2 ? { content: [usoTool('a', 'x', {})], stop_reason: 'tool_use' } : { content: [{ type: 'text' as const, text: 'pronto' }], stop_reason: 'end_turn' }),
      'p',
      async () => 'dado',
    );
    expect(normal).toBe('pronto');
  });
});

describe('LoopGuard por escopo (executor)', () => {
  it('um guard por escopo, recomeçando após a janela parada; escopo travado não renova a janela', () => {
    let t = 0;
    const gs = new GuardasPorEscopo({ ...loopGuardPadrao(), executor_janela_minutos: 10, executor_max_mesma_acao: 2 }, () => t);
    const g = gs.obter('plano-1');
    expect(gs.obter('plano-1')).toBe(g);
    expect(gs.obter('plano-2')).not.toBe(g);
    g.antes('mp/publicar', {});
    g.antes('mp/publicar', { b: 1 });
    expect(g.antes('mp/publicar', { b: 2 })).toMatchObject({ padrao: 'mesma_tool' });
    t = 9 * 60_000;
    expect(gs.obter('plano-1')).toBe(g); // travado: não renovou, mas ainda dentro da janela de 10 min desde a última renovação
    t = 11 * 60_000;
    expect(gs.obter('plano-1')).not.toBe(g); // janela passou: recomeça limpo
  });
});
