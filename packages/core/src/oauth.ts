// OAuth 2.1 (código de autorização + PKCE S256, registro dinâmico de cliente) para o conector MCP no claude.ai.
// Só o Breno (login do painel) autoriza. Tokens guardados só como hash.
// ⚠️ Testado com chamadas simuladas; validar conectando de verdade no claude.ai.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Consultavel } from './banco.ts';

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const aleatorio = (n = 32) => randomBytes(n).toString('base64url');

export const DURACAO_ACESSO_S = 60 * 60; // 1 h
export const DURACAO_RENOVACAO_S = 30 * 24 * 60 * 60; // 30 dias

/** Só aceita voltar para endereços do Claude (ou localhost para testes do Claude Code). */
export function redirectPermitido(uri: string): boolean {
  try {
    const u = new URL(uri);
    if (u.protocol === 'https:' && ['claude.ai', 'claude.com'].includes(u.hostname)) return true;
    if (u.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(u.hostname)) return true;
    return false;
  } catch {
    return false;
  }
}

export async function registrarCliente(db: Consultavel, p: { nome?: string; redirectUris: string[] }): Promise<{ client_id: string }> {
  if (!p.redirectUris.length || !p.redirectUris.every(redirectPermitido)) throw new Error('redirect_uri não permitido');
  const client_id = `jarvis_${aleatorio(16)}`;
  await db.query(`insert into oauth_clientes (client_id, nome, redirect_uris) values ($1, $2, $3)`, [
    client_id,
    p.nome?.slice(0, 100) ?? null,
    JSON.stringify(p.redirectUris),
  ]);
  return { client_id };
}

export async function validarPedidoAutorizacao(
  db: Consultavel,
  p: { clientId: string; redirectUri: string; codeChallenge: string; metodo: string; responseType: string },
): Promise<string | null> {
  if (p.responseType !== 'code') return 'response_type precisa ser "code"';
  if (p.metodo !== 'S256' || !/^[A-Za-z0-9_-]{43}$/.test(p.codeChallenge)) return 'PKCE S256 obrigatório';
  const c = await db.query<{ redirect_uris: string[] }>(`select redirect_uris from oauth_clientes where client_id = $1`, [p.clientId]);
  if (!c.rows[0]) return 'cliente desconhecido';
  if (!c.rows[0].redirect_uris.includes(p.redirectUri)) return 'redirect_uri não registrado';
  return null;
}

/** Depois do "Autorizar" do Breno: código de uso único, 5 minutos. */
export async function emitirCodigo(
  db: Consultavel,
  p: { clientId: string; redirectUri: string; codeChallenge: string; usuario: string },
): Promise<string> {
  const codigo = aleatorio();
  await db.query(
    `insert into oauth_codigos (codigo_hash, client_id, redirect_uri, code_challenge, usuario, expira_em)
     values ($1, $2, $3, $4, $5, now() + interval '5 minutes')`,
    [sha(codigo), p.clientId, p.redirectUri, p.codeChallenge, p.usuario],
  );
  return codigo;
}

export interface Tokens {
  access_token: string;
  token_type: 'Bearer';
  expires_in: number;
  refresh_token: string;
}

async function emitirTokens(db: Consultavel, clientId: string, usuario: string): Promise<Tokens> {
  const acesso = aleatorio();
  const renovacao = aleatorio();
  await db.query(
    `insert into oauth_tokens (token_hash, tipo, client_id, usuario, expira_em) values
       ($1, 'acesso', $3, $4, now() + make_interval(secs => $5)),
       ($2, 'renovacao', $3, $4, now() + make_interval(secs => $6))`,
    [sha(acesso), sha(renovacao), clientId, usuario, DURACAO_ACESSO_S, DURACAO_RENOVACAO_S],
  );
  return { access_token: acesso, token_type: 'Bearer', expires_in: DURACAO_ACESSO_S, refresh_token: renovacao };
}

export type ErroOAuth = { error: 'invalid_grant' | 'invalid_request' | 'invalid_client' | 'unsupported_grant_type'; error_description: string };

export async function trocarCodigo(
  db: Consultavel,
  p: { codigo: string; clientId: string; redirectUri: string; codeVerifier: string },
): Promise<Tokens | ErroOAuth> {
  const r = await db.query<{ client_id: string; redirect_uri: string; code_challenge: string; usuario: string; valido: boolean }>(
    `update oauth_codigos set usado_em = now()
      where codigo_hash = $1 and usado_em is null
      returning client_id, redirect_uri, code_challenge, usuario, expira_em > now() as valido`,
    [sha(p.codigo)],
  );
  const c = r.rows[0];
  if (!c || !c.valido) return { error: 'invalid_grant', error_description: 'código inválido, usado ou vencido' };
  if (c.client_id !== p.clientId || c.redirect_uri !== p.redirectUri) return { error: 'invalid_grant', error_description: 'cliente ou redirect diferente' };
  const esperado = Buffer.from(createHash('sha256').update(p.codeVerifier).digest('base64url'));
  const recebido = Buffer.from(c.code_challenge);
  if (esperado.length !== recebido.length || !timingSafeEqual(esperado, recebido)) {
    return { error: 'invalid_grant', error_description: 'PKCE não confere' };
  }
  return emitirTokens(db, c.client_id, c.usuario);
}

/** Renovação com rotação: o token de renovação usado é revogado. */
export async function renovar(db: Consultavel, p: { refreshToken: string; clientId: string }): Promise<Tokens | ErroOAuth> {
  const r = await db.query<{ usuario: string; client_id: string }>(
    `update oauth_tokens set revogado_em = now()
      where token_hash = $1 and tipo = 'renovacao' and revogado_em is null and expira_em > now()
      returning usuario, client_id`,
    [sha(p.refreshToken)],
  );
  const t = r.rows[0];
  if (!t || t.client_id !== p.clientId) return { error: 'invalid_grant', error_description: 'token de renovação inválido' };
  return emitirTokens(db, t.client_id, t.usuario);
}

/** Valida o Bearer do conector: devolve o usuário ou null. */
export async function usuarioDoToken(db: Consultavel, token: string): Promise<string | null> {
  if (!token) return null;
  const r = await db.query<{ usuario: string }>(
    `select usuario from oauth_tokens where token_hash = $1 and tipo = 'acesso' and revogado_em is null and expira_em > now()`,
    [sha(token)],
  );
  return r.rows[0]?.usuario ?? null;
}

/** Revoga tudo de um cliente (ou de todos, para o "PARA TUDO"). */
export async function revogarTokensMcp(db: Consultavel, clientId?: string): Promise<number> {
  const r = await db.query(
    `update oauth_tokens set revogado_em = now() where revogado_em is null and ($1::text is null or client_id = $1)`,
    [clientId ?? null],
  );
  return r.rowCount ?? 0;
}

export function metadadosServidor(base: string) {
  return {
    issuer: base,
    authorization_endpoint: `${base}/oauth/autorizar`,
    token_endpoint: `${base}/api/oauth/token`,
    registration_endpoint: `${base}/api/oauth/registrar`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    scopes_supported: ['jarvis'],
  };
}

export function metadadosRecurso(base: string) {
  return { resource: `${base}/api/mcp`, authorization_servers: [base], scopes_supported: ['jarvis'], bearer_methods_supported: ['header'] };
}
