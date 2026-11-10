import { createServerClient, type CookieOptions } from '@supabase/ssr';

type CookieParaGravar = { name: string; value: string; options: CookieOptions };
import { cookies } from 'next/headers';

export function configSupabase(): { url: string; chave: string } | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const chave = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  return url && chave ? { url, chave } : null;
}

/** Cliente do Supabase Auth no servidor (Server Components, Server Actions, rotas). */
export async function clienteSupabaseServidor() {
  const cfg = configSupabase();
  if (!cfg) throw new Error('Supabase Auth não configurado (NEXT_PUBLIC_SUPABASE_URL/ANON_KEY)');
  const jarra = await cookies();
  return createServerClient(cfg.url, cfg.chave, {
    cookies: {
      getAll: () => jarra.getAll(),
      setAll: (lista: CookieParaGravar[]) => {
        try {
          for (const { name, value, options } of lista) jarra.set(name, value, options);
        } catch {
          // Server Component não pode gravar cookie; o middleware renova a sessão.
        }
      },
    },
  });
}
