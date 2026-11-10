import type { NextRequest } from 'next/server';

/** Endereço público do painel (JARVIS_PAINEL_URL em produção; senão, o da própria requisição). */
export function baseUrl(req?: NextRequest): string {
  const fixo = process.env.JARVIS_PAINEL_URL?.replace(/\/$/, '');
  if (fixo) return fixo;
  return req ? req.nextUrl.origin : 'http://localhost:3000';
}
