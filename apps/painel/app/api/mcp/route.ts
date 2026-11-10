import { timingSafeEqual } from 'node:crypto';
import { NextResponse, type NextRequest } from 'next/server';
import { tratarMensagemMcp, usuarioDoToken } from '@jarvis/core';
import { baseUrl } from '../../../lib/base';
import { obterBanco, obterRegras } from '../../../lib/servidor';

export const dynamic = 'force-dynamic';

/**
 * Conector MCP do Jarvis (HTTP "streamable", sem estado, respostas JSON).
 * Aceita o token fixo JARVIS_CORE_MCP_TOKEN (Claude Code) ou um token OAuth (claude.ai, ver /oauth/autorizar).
 */
async function autorizado(req: NextRequest): Promise<boolean> {
  const recebido = (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '');
  if (!recebido) return false;
  // 1) Token fixo (Claude Code, com cabeçalho).
  const fixo = process.env.JARVIS_CORE_MCP_TOKEN;
  if (fixo && fixo.length >= 32) {
    const a = Buffer.from(recebido);
    const b = Buffer.from(fixo);
    if (a.length === b.length && timingSafeEqual(a, b)) return true;
  }
  // 2) Token OAuth (claude.ai).
  return Boolean(await usuarioDoToken(obterBanco(), recebido));
}

function naoAutorizado(req: NextRequest) {
  return NextResponse.json(
    { error: 'não autorizado' },
    { status: 401, headers: { 'www-authenticate': `Bearer resource_metadata="${baseUrl(req)}/.well-known/oauth-protected-resource"` } },
  );
}

export async function POST(req: NextRequest) {
  if (!(await autorizado(req))) return naoAutorizado(req);
  let corpo: unknown;
  try {
    corpo = await req.json();
  } catch {
    return NextResponse.json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'JSON inválido' } }, { status: 400 });
  }
  const banco = obterBanco();
  const regras = obterRegras();
  if (Array.isArray(corpo)) {
    const respostas = (await Promise.all(corpo.map((m) => tratarMensagemMcp(banco, regras, m)))).filter((r) => r !== null);
    return respostas.length ? NextResponse.json(respostas) : new NextResponse(null, { status: 202 });
  }
  const r = await tratarMensagemMcp(banco, regras, corpo as Record<string, unknown>);
  return r === null ? new NextResponse(null, { status: 202 }) : NextResponse.json(r);
}

export async function GET() {
  // Sem fluxo de eventos do servidor (stateless).
  return new NextResponse(null, { status: 405, headers: { allow: 'POST' } });
}
