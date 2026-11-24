import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import {
  COMPONENTES_COM_DECISAO,
  assinarDecisao,
  criarAprovacao,
  enviarDecisaoAoNexus,
  enviarDecisoesPendentesAoNexus,
  lerPedidoNexus,
  montarCorpoDecisao,
  registrarPedidoNexus,
  responderAprovacao,
  tokenDaAprovacao,
  urlDecisaoNexus,
  verificarAssinatura,
  type Banco,
} from '@jarvis/core';
import { bancoLimpo, NUMERO_BRENO, regrasTeste } from './ajuda.ts';

const SEGREDO = 'segredo-compartilhado-com-mais-de-32-caracteres';
const ID = '3f2b6c1e-8a4d-4e7b-9c10-5d2a7b9e0f11';
const regras = regrasTeste();

/** Cópia fiel da verificação do Nexus (src/lib/jarvis.ts: assinar/conferirPedido): HMAC-SHA256 hex de "<ts>.<corpo>", janela de 5 min. */
function conferirComoONexus(seg: string, ts: string | null, corpo: string, assinatura: string | null, agora = Math.floor(Date.now() / 1000)): string {
  if (!ts || !assinatura) return 'faltando';
  const n = Number(ts);
  if (!Number.isInteger(n) || Math.abs(agora - n) > 300) return 'fora_da_janela';
  const esperado = createHmac('sha256', seg).update(`${n}.${corpo}`).digest('hex');
  return esperado === assinatura ? 'ok' : 'invalida';
}

/** Cópia do validador do Nexus (src/lib/maestro/decisao-jarvis.ts: lerDecisao). */
function lerDecisaoComoONexus(json: unknown): { decisao: unknown } | { erro: string } {
  if (!json || typeof json !== 'object') return { erro: 'corpo inválido' };
  const j = json as Record<string, unknown>;
  const componente = typeof j.componente === 'string' ? j.componente.trim() : '';
  const escopo = typeof j.escopo === 'string' ? j.escopo.trim() : '';
  if (!componente || componente.length > 60) return { erro: 'componente inválido' };
  if (!escopo || escopo.length > 200) return { erro: 'escopo inválido' };
  if (j.decisao !== 'aprovado' && j.decisao !== 'recusado') return { erro: 'decisao' };
  return { decisao: { componente, escopo, decisao: j.decisao } };
}

describe('payload e assinatura da decisão (contrato do Nexus)', () => {
  it('monta o corpo com os três campos e o Nexus aceita', () => {
    const corpo = montarCorpoDecisao({ componente: 'xavier_lancamento', escopo: ID, decisao: 'aprovado' });
    expect(JSON.parse(corpo)).toEqual({ componente: 'xavier_lancamento', escopo: ID, decisao: 'aprovado' });
    expect(lerDecisaoComoONexus(JSON.parse(corpo))).toEqual({ decisao: { componente: 'xavier_lancamento', escopo: ID, decisao: 'aprovado' } });
  });

  it('cabeçalhos assinados batem com a verificação do Nexus e com a do Jarvis', () => {
    const corpo = montarCorpoDecisao({ componente: 'xavier_lancamento', escopo: ID, decisao: 'recusado' });
    const h = assinarDecisao(SEGREDO, corpo, 1_800_000_000) as Record<string, string>;
    const ts = h['x-jarvis-timestamp'] ?? null, assin = h['x-jarvis-assinatura'] ?? null;
    expect(h['x-jarvis-timestamp']).toBe('1800000000');
    expect(h['x-jarvis-assinatura']).toBe(createHmac('sha256', SEGREDO).update(`1800000000.${corpo}`).digest('hex'));
    expect(conferirComoONexus(SEGREDO, ts, corpo, assin, 1_800_000_010)).toBe('ok');
    expect(verificarAssinatura(SEGREDO, ts, corpo, assin, 1_800_000_010)).toBe('ok');
    // corpo adulterado, segredo errado e relógio fora da janela falham
    expect(conferirComoONexus(SEGREDO, ts, corpo.replace('recusado', 'aprovado'), assin, 1_800_000_010)).toBe('invalida');
    expect(conferirComoONexus('outro-segredo-com-mais-de-32-caracteres-x', ts, corpo, assin, 1_800_000_010)).toBe('invalida');
    expect(conferirComoONexus(SEGREDO, ts, corpo, assin, 1_800_000_999)).toBe('fora_da_janela');
  });

  it('endereço: JARVIS_NEXUS_URL, depois a origem dos avisos, depois o padrão', () => {
    expect(urlDecisaoNexus({ JARVIS_NEXUS_URL: 'https://nexus.exemplo.br/' })).toBe('https://nexus.exemplo.br/api/jarvis/decisao');
    expect(urlDecisaoNexus({ JARVIS_CORE_NEXUS_AVISOS_URL: 'https://n.exemplo.br/api/jarvis/avisos' })).toBe('https://n.exemplo.br/api/jarvis/decisao');
    expect(urlDecisaoNexus({})).toBe('https://nexus-hub.api.br/api/jarvis/decisao');
  });
});

describe('envio com retry', () => {
  const p = { componente: 'xavier_lancamento', escopo: ID, decisao: 'aprovado' as const };
  const sem = async () => {};

  it('envia assinado, em POST, e o Nexus confere', async () => {
    const vistos: { url: string; init: RequestInit }[] = [];
    const r = await enviarDecisaoAoNexus(p, {
      url: 'https://n.exemplo.br/api/jarvis/decisao', segredo: SEGREDO, dormir: sem,
      fetchImpl: (async (url: string, init: RequestInit) => { vistos.push({ url, init }); return new Response('{"ok":true}', { status: 200 }); }) as unknown as typeof fetch,
    });
    expect(r).toMatchObject({ entregue: true, tentativas: 1 });
    const h = vistos[0]!.init.headers as Record<string, string>;
    expect(vistos[0]!.init.method).toBe('POST');
    expect(conferirComoONexus(SEGREDO, h['x-jarvis-timestamp'] ?? null, String(vistos[0]!.init.body), h['x-jarvis-assinatura'] ?? null)).toBe('ok');
  });

  it('tenta de novo em 503 e erro de rede, e para ao entregar', async () => {
    let n = 0;
    const r = await enviarDecisaoAoNexus(p, {
      url: 'https://n.exemplo.br/x', segredo: SEGREDO, dormir: sem,
      fetchImpl: (async () => { n++; if (n === 1) throw new TypeError('fetch failed'); if (n === 2) return new Response('', { status: 503 }); return new Response('{}', { status: 200 }); }) as unknown as typeof fetch,
    });
    expect(r).toMatchObject({ entregue: true, tentativas: 3 });
  });

  it('desiste depois das tentativas, não repete 401 e trata 409 como entregue', async () => {
    let n = 0;
    const falha = await enviarDecisaoAoNexus(p, { url: 'https://n/x', segredo: SEGREDO, dormir: sem, fetchImpl: (async () => { n++; return new Response('', { status: 500 }); }) as unknown as typeof fetch });
    expect(falha).toMatchObject({ entregue: false, tentativas: 3 });
    expect(n).toBe(3);
    n = 0;
    const r401 = await enviarDecisaoAoNexus(p, { url: 'https://n/x', segredo: SEGREDO, dormir: sem, fetchImpl: (async () => { n++; return new Response('', { status: 401 }); }) as unknown as typeof fetch });
    expect(r401).toMatchObject({ entregue: false, tentativas: 1 });
    expect(n).toBe(1);
    const r409 = await enviarDecisaoAoNexus(p, { url: 'https://n/x', segredo: SEGREDO, dormir: sem, fetchImpl: (async () => new Response('{"ok":false}', { status: 409 })) as unknown as typeof fetch });
    expect(r409).toMatchObject({ entregue: true, status: 409 });
  });

  it('sem segredo não chama a rede', async () => {
    let n = 0;
    const r = await enviarDecisaoAoNexus(p, { url: 'https://n/x', segredo: 'curto', fetchImpl: (async () => { n++; return new Response(''); }) as unknown as typeof fetch });
    expect(r).toMatchObject({ entregue: false, motivo: 'sem_segredo' });
    expect(n).toBe(0);
  });
});

describe('pedido do Nexus vira aprovação e devolve a decisão', () => {
  let banco: Banco;
  beforeEach(async () => { process.env.JARVIS_CORE_APROVACAO_SEGREDO = SEGREDO; banco = await bancoLimpo(); });
  afterEach(async () => { delete process.env.JARVIS_CORE_APROVACAO_SEGREDO; await banco.end(); });

  const pedido = () => lerPedidoNexus({ componente: 'xavier_lancamento', escopo: ID, classe: 'breno', texto: 'Xavier pede aprovação (Empresa X): pagar R$ 25.000. Responda aprovado ou recusado.', link: '/financeiro' })!;

  it('o Nexus tem executor para cada componente da lista', () => {
    expect([...COMPONENTES_COM_DECISAO]).toEqual(['estruturador', 'renave_cancelamento', 'conversor_carga', 'xavier_lancamento']);
  });

  it('aprovar pelo WhatsApp envia aprovado ao Nexus uma vez; repetir o pedido não duplica', async () => {
    expect(await registrarPedidoNexus(banco, pedido(), undefined, regras)).toEqual({ registrado: true, avisado: true });
    expect(await registrarPedidoNexus(banco, pedido(), undefined, regras)).toEqual({ registrado: true, avisado: false });
    const ap = (await banco.query(`select id, origem_componente, origem_escopo, status from aprovacoes`)).rows;
    expect(ap).toHaveLength(1);
    expect(ap[0]).toMatchObject({ origem_componente: 'xavier_lancamento', origem_escopo: ID, status: 'pendente' });
    const aviso = (await banco.query(`select tipo, aprovacao_id from avisos`)).rows;
    expect(aviso).toEqual([{ tipo: 'pedido_aprovacao', aprovacao_id: ap[0].id }]);

    const enviados: unknown[] = [];
    const opts = { url: 'https://n/x', segredo: SEGREDO, dormir: async () => {}, fetchImpl: (async (_u: string, init: RequestInit) => { enviados.push(JSON.parse(String(init.body))); return new Response('{"ok":true}', { status: 200 }); }) as unknown as typeof fetch };
    // antes de responder, nada vai
    expect(await enviarDecisoesPendentesAoNexus(banco, opts)).toEqual({ entregues: 0, falhas: 0 });
    const token = tokenDaAprovacao(SEGREDO, ap[0].id);
    expect(await responderAprovacao(banco, regras, token, 'aprovar', NUMERO_BRENO)).toBe('aprovada');
    expect(await enviarDecisoesPendentesAoNexus(banco, opts)).toEqual({ entregues: 1, falhas: 0 });
    expect(await enviarDecisoesPendentesAoNexus(banco, opts)).toEqual({ entregues: 0, falhas: 0 });
    expect(enviados).toEqual([{ componente: 'xavier_lancamento', escopo: ID, decisao: 'aprovado' }]);
  });

  it('recusar envia recusado; falha de envio fica para reenvio', async () => {
    await registrarPedidoNexus(banco, pedido(), undefined, regras);
    const id = (await banco.query(`select id from aprovacoes`)).rows[0].id as string;
    await responderAprovacao(banco, regras, tokenDaAprovacao(SEGREDO, id), 'recusar', NUMERO_BRENO);
    const corpos: unknown[] = [];
    let ligado = false;
    const opts = { url: 'https://n/x', segredo: SEGREDO, tentativas: 2, dormir: async () => {}, fetchImpl: (async (_u: string, init: RequestInit) => { corpos.push(JSON.parse(String(init.body))); return new Response('', { status: ligado ? 200 : 502 }); }) as unknown as typeof fetch };
    expect(await enviarDecisoesPendentesAoNexus(banco, opts)).toEqual({ entregues: 0, falhas: 1 });
    expect((await banco.query(`select decisao_tentativas, decisao_enviada_em from aprovacoes where id = $1`, [id])).rows[0]).toMatchObject({ decisao_tentativas: 2, decisao_enviada_em: null });
    ligado = true;
    expect(await enviarDecisoesPendentesAoNexus(banco, opts)).toEqual({ entregues: 1, falhas: 0 });
    expect(corpos.at(-1)).toEqual({ componente: 'xavier_lancamento', escopo: ID, decisao: 'recusado' });
  });

  it('aprovação comum (sem origem) não manda nada ao Nexus e pedido de outro componente segue só como aviso', async () => {
    const c = await criarAprovacao(banco, regras, { resumo: 'qualquer' });
    await responderAprovacao(banco, regras, c.token, 'aprovar', NUMERO_BRENO);
    expect(await registrarPedidoNexus(banco, lerPedidoNexus({ componente: 'whatsapp', escopo: 'drive', classe: 'breno', texto: 'falta o número' })!, undefined, regras)).toEqual({ registrado: true, avisado: true });
    expect((await banco.query(`select count(*)::int as n from aprovacoes where origem_componente is not null`)).rows[0].n).toBe(0);
    expect(await enviarDecisoesPendentesAoNexus(banco, { url: 'https://n/x', segredo: SEGREDO })).toEqual({ entregues: 0, falhas: 0 });
  });
});
