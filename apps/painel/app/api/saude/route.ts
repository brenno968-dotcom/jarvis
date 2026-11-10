import { timingSafeEqual } from 'node:crypto';
import { NextResponse, type NextRequest } from 'next/server';
import { saudeDoJarvis } from '@jarvis/core';
import { obterBanco } from '../../../lib/servidor';

export const dynamic = 'force-dynamic';

/** Para o Pulso (seção 27). Bearer JARVIS_CORE_PULSO_TOKEN. Não devolve nenhum dado sensível. */
export async function GET(req: NextRequest) {
  const esperado = process.env.JARVIS_CORE_PULSO_TOKEN;
  const recebido = (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '');
  const a = Buffer.from(recebido);
  const b = Buffer.from(esperado ?? '');
  if (!esperado || esperado.length < 32 || a.length !== b.length || !timingSafeEqual(a, b)) {
    return NextResponse.json({ ok: false }, { status: 401 });
  }
  return NextResponse.json(await saudeDoJarvis(obterBanco()), { headers: { 'cache-control': 'no-store' } });
}
