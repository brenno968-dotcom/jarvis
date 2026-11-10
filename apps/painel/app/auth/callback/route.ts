import { NextResponse, type NextRequest } from 'next/server';
import { clienteSupabaseServidor } from '../../../lib/supabase';

/** Volta do link mágico do e-mail: troca o código pela sessão. */
export async function GET(req: NextRequest) {
  const codigo = req.nextUrl.searchParams.get('code');
  if (codigo) {
    const sb = await clienteSupabaseServidor();
    await sb.auth.exchangeCodeForSession(codigo);
  }
  const voltar = req.nextUrl.searchParams.get('voltar') ?? '/';
  const destino = voltar.startsWith('/') && !voltar.startsWith('//') ? voltar : '/';
  return NextResponse.redirect(new URL(destino, req.url));
}
