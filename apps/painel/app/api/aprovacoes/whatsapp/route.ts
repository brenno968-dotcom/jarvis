import { NextResponse, type NextRequest } from 'next/server';
import { marcarWebhookVisto, processarEventoNexus, verificarAssinatura } from '@jarvis/core';
import { obterBanco, obterRegras } from '../../../../lib/servidor';

export const dynamic = 'force-dynamic';

/**
 * Webhook chamado pelo Nexus quando o Breno toca num botão ou manda "PARA TUDO" no WhatsApp.
 * Contrato: docs/INTEGRACAO-NEXUS.md. Sem assinatura válida, nada acontece.
 */
export async function POST(req: NextRequest) {
  const corpo = await req.text();
  const assinatura = req.headers.get('x-jarvis-assinatura');
  const verificacao = verificarAssinatura(
    process.env.JARVIS_CORE_NEXUS_WEBHOOK_SEGREDO,
    req.headers.get('x-jarvis-timestamp'),
    corpo,
    assinatura,
  );
  if (verificacao !== 'ok') {
    return NextResponse.json({ ok: false }, { status: verificacao === 'sem_segredo' ? 503 : 401 });
  }
  const banco = obterBanco();
  if (!(await marcarWebhookVisto(banco, assinatura!))) {
    return NextResponse.json({ ok: true, repetido: true });
  }
  let evento: unknown;
  try {
    evento = JSON.parse(corpo);
  } catch {
    return NextResponse.json({ ok: false }, { status: 400 });
  }
  const resultado = await processarEventoNexus(banco, obterRegras(), evento);
  return NextResponse.json({ ok: true, resultado });
}
