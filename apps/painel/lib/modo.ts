// Modo de login do painel.
// - "supabase" (padrão quando o Supabase está configurado): login do Breno por link no e-mail,
//   só para os e-mails de JARVIS_PAINEL_EMAILS.
// - "senha": login provisório da Fase 0 (só para desenvolvimento/local).
export type ModoLogin = 'supabase' | 'senha';

export function modoLogin(): ModoLogin {
  const pedido = process.env.JARVIS_PAINEL_AUTH;
  if (pedido === 'senha') return 'senha';
  if (pedido === 'supabase') return 'supabase';
  return process.env.NEXT_PUBLIC_SUPABASE_URL ? 'supabase' : 'senha';
}

/** E-mails autorizados (minúsculos). Vazio = ninguém entra. */
export function emailsAutorizados(): string[] {
  return (process.env.JARVIS_PAINEL_EMAILS ?? '')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}

export function emailAutorizado(email: string | null | undefined): boolean {
  return Boolean(email) && emailsAutorizados().includes(email!.toLowerCase());
}
