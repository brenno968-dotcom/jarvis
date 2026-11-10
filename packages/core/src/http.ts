import { redator } from './redacao.ts';
import type { ErroResultado } from './tipos.ts';

export class ErroHttp extends Error {
  constructor(
    public readonly status: number,
    public readonly erro: ErroResultado,
  ) {
    super(erro.mensagem);
    this.name = 'ErroHttp';
  }
}

/** Traduz o status HTTP para o tipo de erro da seção 15.3. */
export function classificarStatus(status: number, retryAfter?: string | null, detalhe = ''): ErroResultado {
  const msg = redator.redigir(`HTTP ${status}${detalhe ? `: ${detalhe}` : ''}`).slice(0, 500);
  if (status === 429) {
    const s = Number(retryAfter);
    return { tipo: 'temporario', codigo: 'LIMITE', mensagem: msg, ...(s > 0 ? { tentarNovamenteEmSegundos: Math.min(900, s) } : {}) };
  }
  if (status >= 500 || status === 408) return { tipo: 'temporario', codigo: 'SERVIDOR', mensagem: msg };
  if (status === 401 || status === 403) return { tipo: 'definitivo', codigo: 'CREDENCIAL_RECUSADA', mensagem: msg };
  if (status === 404) return { tipo: 'definitivo', codigo: 'NAO_ENCONTRADO', mensagem: msg };
  if (status === 409) return { tipo: 'definitivo', codigo: 'CONFLITO', mensagem: msg };
  return { tipo: 'definitivo', codigo: 'PEDIDO_INVALIDO', mensagem: msg };
}

export interface OpcoesRequisicao {
  metodo?: 'GET' | 'POST' | 'PATCH' | 'DELETE' | 'PUT';
  token?: string;
  corpo?: unknown;
  cabecalhos?: Record<string, string>;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

/** JSON in/out, com timeout, erros classificados e mensagens redigidas. */
export async function requisitarJson<T = unknown>(url: string, o: OpcoesRequisicao = {}): Promise<T> {
  const f = o.fetchImpl ?? fetch;
  let resp: Response;
  try {
    resp = await f(url, {
      method: o.metodo ?? 'GET',
      headers: {
        accept: 'application/json',
        ...(o.corpo !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(o.token ? { authorization: `Bearer ${o.token}` } : {}),
        ...o.cabecalhos,
      },
      ...(o.corpo !== undefined ? { body: JSON.stringify(o.corpo) } : {}),
      signal: AbortSignal.timeout(o.timeoutMs ?? 30_000),
    });
  } catch (e) {
    throw new ErroHttp(0, {
      tipo: 'temporario',
      codigo: 'REDE',
      mensagem: redator.redigir(`falha de rede: ${(e as Error)?.message ?? e}`),
    });
  }
  const texto = await resp.text();
  if (!resp.ok) {
    let detalhe = texto.slice(0, 300);
    try {
      const j = JSON.parse(texto) as { error?: { message?: string } | string; message?: string };
      detalhe = (typeof j.error === 'object' ? j.error?.message : j.error) ?? j.message ?? detalhe;
    } catch {
      /* corpo não é JSON */
    }
    throw new ErroHttp(resp.status, classificarStatus(resp.status, resp.headers.get('retry-after'), detalhe));
  }
  return (texto ? JSON.parse(texto) : undefined) as T;
}
