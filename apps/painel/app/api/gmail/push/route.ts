import { timingSafeEqual } from 'node:crypto';
import { NextResponse, type NextRequest } from 'next/server';
import { obterBanco } from '../../../../lib/servidor';

export const dynamic = 'force-dynamic';

/**
 * Aviso do Gmail via Pub/Sub push (seção 21). A assinatura do Pub/Sub chama
 * /api/gmail/push?token=<JARVIS_CORE_GMAIL_PUSH_TOKEN>. Guarda só o historyId e a hora
 * (o Pulso alerta se não chegar nada em 24 h). ⚠️ Conferir o formato com o Pub/Sub real.
 */
export async function POST(req: NextRequest) {
  const esperado = process.env.JARVIS_CORE_GMAIL_PUSH_TOKEN ?? '';
  const recebido = req.nextUrl.searchParams.get('token') ?? '';
  const a = Buffer.from(recebido);
  const b = Buffer.from(esperado);
  if (esperado.length < 32 || a.length !== b.length || !timingSafeEqual(a, b)) return NextResponse.json({ ok: false }, { status: 401 });
  try {
    const corpo = (await req.json()) as { message?: { data?: string } };
    const dados = JSON.parse(Buffer.from(corpo.message?.data ?? '', 'base64').toString('utf8')) as { historyId?: string | number };
    if (!dados.historyId) return NextResponse.json({ ok: true, ignorado: true });
    const banco = obterBanco();
    await banco.query(`delete from gmail_eventos where recebido_em < now() - interval '7 days'`);
    await banco.query(`insert into gmail_eventos (history_id) values ($1)`, [String(dados.historyId)]);
  } catch {
    // Pub/Sub reenvia se não receber 2xx; mensagem malformada é descartada.
  }
  return NextResponse.json({ ok: true });
}
