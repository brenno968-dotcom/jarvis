// Login PROVISÓRIO do painel (Fase 0). Substituir pelo login do Breno via Supabase Auth
// antes de qualquer uso real (ver docs/STATUS.md). Falha fechado: sem as variáveis, ninguém entra.

export const COOKIE = 'jarvis_sessao';

async function hmac(segredo: string, texto: string): Promise<string> {
  const chave = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(segredo),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const assinatura = await crypto.subtle.sign('HMAC', chave, new TextEncoder().encode(texto));
  let binario = '';
  for (const b of new Uint8Array(assinatura)) binario += String.fromCharCode(b);
  return btoa(binario).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function iguais(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

export async function valorDaSessao(): Promise<string | null> {
  const segredo = process.env.JARVIS_PAINEL_SEGREDO_COOKIE;
  if (!segredo || segredo.length < 32) return null;
  return hmac(segredo, 'breno');
}

export async function sessaoValida(cookie: string | undefined): Promise<boolean> {
  const esperado = await valorDaSessao();
  return Boolean(esperado && cookie && iguais(cookie, esperado));
}

export async function senhaConfere(senha: string): Promise<boolean> {
  const certa = process.env.JARVIS_PAINEL_SENHA;
  if (!certa || certa.length < 12) return false;
  // Compara os HMACs para não vazar o tamanho da senha.
  const segredo = process.env.JARVIS_PAINEL_SEGREDO_COOKIE ?? '';
  return iguais(await hmac(segredo, senha), await hmac(segredo, certa));
}
