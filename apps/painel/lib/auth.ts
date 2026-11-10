import 'server-only';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { emailAutorizado, modoLogin } from './modo';
import { COOKIE, sessaoValida } from './sessao';
import { clienteSupabaseServidor } from './supabase';

/** Quem está logado (e-mail ou "breno" no modo senha), ou null. */
export async function usuarioAtual(): Promise<string | null> {
  if (modoLogin() === 'senha') {
    const c = await cookies();
    return (await sessaoValida(c.get(COOKIE)?.value)) ? 'breno' : null;
  }
  const sb = await clienteSupabaseServidor();
  const { data } = await sb.auth.getUser();
  return emailAutorizado(data.user?.email) ? data.user!.email!.toLowerCase() : null;
}

/** Use no início de toda Server Action. */
export async function exigirSessao(): Promise<string> {
  const u = await usuarioAtual();
  if (!u) redirect('/entrar');
  return u;
}
