import { NextResponse, type NextRequest } from 'next/server';
import { lerPedidoNexus, marcarWebhookVisto, registrarPedidoNexus, verificarAssinatura } from '@jarvis/core';
import { obterBanco, obterRegras } from '../../../../lib/servidor';

export const dynamic = 'force-dynamic';

/**
 * Pedido do Pulso do Nexus: problema que o Nexus não corrige sozinho (item 177).
 * Contrato: docs/INTEGRACAO-NEXUS.md, seção 4. Sem assinatura válida, nada acontece.
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
  let bruto: unknown;
  try {
    bruto = JSON.parse(corpo);
  } catch {
    return NextResponse.json({ ok: false, motivo: 'corpo inválido' }, { status: 400 });
  }
  const pedido = lerPedidoNexus(bruto);
  if (!pedido) return NextResponse.json({ ok: false, motivo: 'pedido incompleto' }, { status: 400 });
  const banco = obterBanco();
  if (!(await marcarWebhookVisto(banco, assinatura!))) return NextResponse.json({ ok: true, repetido: true });
  const resultado = await registrarPedidoNexus(banco, pedido, process.env.JARVIS_NEXUS_URL ?? 'https://nexus-hub.api.br', obterRegras());
  return NextResponse.json({ ok: true, resultado });
}
