import { timingSafeEqual } from 'node:crypto';
import { NextResponse, type NextRequest } from 'next/server';
import { normalizarPagamento, registrarPagamento } from '@jarvis/core';
import { obterBanco } from '../../../../../lib/servidor';

export const dynamic = 'force-dynamic';

/**
 * Avisos de pagamento. URL configurada na plataforma: /api/pagamentos/<asaas|hotmart>/<id do negócio>.
 * Autenticação (⚠️ conferir na documentação de cada plataforma ao ligar):
 *  - Asaas: cabeçalho "asaas-access-token" = JARVIS_CORE_ASAAS_WEBHOOK_TOKEN
 *  - Hotmart: cabeçalho "x-hotmart-hottok" = JARVIS_CORE_HOTMART_HOTTOK
 */
const CONFIG = {
  asaas: { cabecalho: 'asaas-access-token', segredo: 'JARVIS_CORE_ASAAS_WEBHOOK_TOKEN' },
  hotmart: { cabecalho: 'x-hotmart-hottok', segredo: 'JARVIS_CORE_HOTMART_HOTTOK' },
} as const;

function iguais(a: string, b: string) {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ origem: string; negocio: string }> }) {
  const { origem, negocio } = await params;
  if (origem !== 'asaas' && origem !== 'hotmart') return NextResponse.json({ ok: false }, { status: 404 });
  if (!/^[0-9a-f-]{36}$/.test(negocio)) return NextResponse.json({ ok: false }, { status: 404 });
  const cfg = CONFIG[origem];
  const esperado = process.env[cfg.segredo];
  const recebido = req.headers.get(cfg.cabecalho) ?? '';
  if (!esperado || esperado.length < 16 || !iguais(recebido, esperado)) return NextResponse.json({ ok: false }, { status: 401 });
  let ev;
  try {
    ev = normalizarPagamento(origem, await req.json());
  } catch {
    return NextResponse.json({ ok: false }, { status: 400 });
  }
  const resultado = await registrarPagamento(obterBanco(), negocio, ev);
  return NextResponse.json({ ok: true, resultado });
}
