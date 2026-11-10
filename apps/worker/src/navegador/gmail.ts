// Leitura de códigos de verificação no Gmail (seção 21). Só leitura (gmail.readonly).
import { requisitarJson } from '@jarvis/core';

export interface MensagemEmail {
  id: string;
  remetente: string;
  recebidaEm: number; // ms
  assunto: string;
  corpo: string;
}

export interface ClienteGmail {
  buscar(consulta: string): Promise<MensagemEmail[]>;
  /** Aviso instantâneo (seção 21): renova o users.watch no tópico do Pub/Sub. Vale no máximo 7 dias. */
  renovarWatch?(topico: string): Promise<{ historyId: string; expiraEm: number }>;
}

export interface CriteriosCodigo {
  remetente: string;
  /** Expressão regular do código (ex.: "\\b\\d{6}\\b"). */
  padrao: string;
  /** Início da ação (ms): e-mails anteriores são ignorados. */
  desde: number;
}

export function montarConsulta(c: CriteriosCodigo): string {
  return `from:(${c.remetente}) after:${Math.floor(c.desde / 1000)}`;
}

function emailDe(remetente: string): string {
  const m = remetente.match(/<([^>]+)>/);
  return (m ? m[1]! : remetente).trim().toLowerCase();
}

export type ResultadoCodigo =
  | { ok: true; codigo: string }
  | { ok: false; motivo: 'nenhum' | 'ambiguo' };

/** Valida remetente, horário, formato e exige exatamente UM código (seção 21). */
export function extrairCodigo(mensagens: MensagemEmail[], c: CriteriosCodigo): ResultadoCodigo {
  const re = new RegExp(c.padrao, 'g');
  const codigos = new Set<string>();
  for (const m of mensagens) {
    if (emailDe(m.remetente) !== c.remetente.toLowerCase()) continue;
    if (m.recebidaEm < c.desde) continue;
    for (const achado of `${m.assunto}\n${m.corpo}`.matchAll(re)) codigos.add(achado[0]);
  }
  if (codigos.size === 0) return { ok: false, motivo: 'nenhum' };
  if (codigos.size > 1) return { ok: false, motivo: 'ambiguo' };
  return { ok: true, codigo: [...codigos][0]! };
}

/** Verifica a cada `intervaloMs` até `limiteMs`. */
export async function aguardarCodigo(
  cliente: ClienteGmail,
  c: CriteriosCodigo,
  o: { intervaloMs: number; limiteMs: number; esperar: (ms: number) => Promise<void>; agora?: () => number },
): Promise<ResultadoCodigo> {
  const agora = o.agora ?? Date.now;
  const fim = agora() + o.limiteMs;
  for (;;) {
    const r = extrairCodigo(await cliente.buscar(montarConsulta(c)), c);
    if (r.ok || r.motivo === 'ambiguo') return r;
    if (agora() >= fim) return r;
    await o.esperar(o.intervaloMs);
  }
}

function decodificar(b64url: string): string {
  return Buffer.from(b64url.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
}

interface ParteGmail {
  mimeType?: string;
  body?: { data?: string };
  parts?: ParteGmail[];
}

function textoDe(p: ParteGmail | undefined): string {
  if (!p) return '';
  if (p.body?.data && (p.mimeType?.startsWith('text/') ?? true)) {
    const t = decodificar(p.body.data);
    return p.mimeType === 'text/html' ? t.replace(/<[^>]+>/g, ' ') : t;
  }
  return (p.parts ?? []).map(textoDe).join('\n');
}

/**
 * Cliente HTTP do Gmail com refresh token (JARVIS_CORE_GMAIL_REFRESH_TOKEN na Dory).
 * ⚠️ Testado só com respostas simuladas.
 */
export function criarClienteGmail(o: {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  fetchImpl?: typeof fetch;
}): ClienteGmail {
  let acesso: { token: string; expira: number } | undefined;
  async function token() {
    if (acesso && acesso.expira > Date.now() + 30_000) return acesso.token;
    const r = await requisitarJson<{ access_token: string; expires_in: number }>('https://oauth2.googleapis.com/token', {
      metodo: 'POST',
      fetchImpl: o.fetchImpl,
      corpo: { client_id: o.clientId, client_secret: o.clientSecret, refresh_token: o.refreshToken, grant_type: 'refresh_token' },
    });
    acesso = { token: r.access_token, expira: Date.now() + r.expires_in * 1000 };
    return acesso.token;
  }
  const API = 'https://gmail.googleapis.com/gmail/v1/users/me';
  return {
    async renovarWatch(topico) {
      const r = await requisitarJson<{ historyId: string; expiration: string }>(`${API}/watch`, {
        metodo: 'POST',
        token: await token(),
        fetchImpl: o.fetchImpl,
        corpo: { topicName: topico, labelIds: ['INBOX'], labelFilterBehavior: 'INCLUDE' },
      });
      return { historyId: r.historyId, expiraEm: Number(r.expiration) };
    },
    async buscar(consulta) {
      const tk = await token();
      const lista = await requisitarJson<{ messages?: { id: string }[] }>(
        `${API}/messages?${new URLSearchParams({ q: consulta, maxResults: '10' })}`,
        { token: tk, fetchImpl: o.fetchImpl },
      );
      const saida: MensagemEmail[] = [];
      for (const { id } of lista.messages ?? []) {
        const m = await requisitarJson<{
          internalDate: string;
          payload: ParteGmail & { headers?: { name: string; value: string }[] };
        }>(`${API}/messages/${id}?format=full`, { token: tk, fetchImpl: o.fetchImpl });
        const cab = (n: string) => m.payload.headers?.find((h) => h.name.toLowerCase() === n)?.value ?? '';
        saida.push({ id, remetente: cab('from'), assunto: cab('subject'), recebidaEm: Number(m.internalDate), corpo: textoDe(m.payload) });
      }
      return saida;
    },
  };
}
