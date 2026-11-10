import { createServerClient, type CookieOptions } from '@supabase/ssr';

type CookieParaGravar = { name: string; value: string; options: CookieOptions };
import { NextResponse, type NextRequest } from 'next/server';
import { emailAutorizado, modoLogin } from './lib/modo';
import { COOKIE, sessaoValida } from './lib/sessao';

const LIVRES = ['/entrar', '/auth/callback', '/api/aprovacoes/whatsapp', '/api/mcp', '/api/pagamentos', '/api/oauth', '/.well-known', '/api/saude', '/api/gmail'];

function paraEntrar(req: NextRequest) {
  const u = new URL('/entrar', req.url);
  u.searchParams.set('voltar', req.nextUrl.pathname + req.nextUrl.search);
  return NextResponse.redirect(u);
}

export async function middleware(req: NextRequest) {
  const caminho = req.nextUrl.pathname;
  // Rotas de máquina se autenticam sozinhas (assinatura/token); telas de login são livres.
  if (LIVRES.some((l) => caminho === l || caminho.startsWith(l + '/'))) return NextResponse.next();

  if (modoLogin() === 'senha') {
    if (await sessaoValida(req.cookies.get(COOKIE)?.value)) return NextResponse.next();
    return paraEntrar(req);
  }

  let resposta = NextResponse.next({ request: req });
  const sb = createServerClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
    cookies: {
      getAll: () => req.cookies.getAll(),
      setAll: (lista: CookieParaGravar[]) => {
        for (const { name, value } of lista) req.cookies.set(name, value);
        resposta = NextResponse.next({ request: req });
        for (const { name, value, options } of lista) resposta.cookies.set(name, value, options);
      },
    },
  });
  const { data } = await sb.auth.getUser();
  if (!emailAutorizado(data.user?.email)) return paraEntrar(req);
  return resposta;
}

export const config = { matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'] };
