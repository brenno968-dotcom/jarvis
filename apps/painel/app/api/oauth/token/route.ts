import { NextResponse, type NextRequest } from 'next/server';
import { renovar, trocarCodigo } from '@jarvis/core';
import { obterBanco } from '../../../../lib/servidor';

export const dynamic = 'force-dynamic';

const semCache = { 'cache-control': 'no-store', pragma: 'no-cache' };

export async function POST(req: NextRequest) {
  const tipo = req.headers.get('content-type') ?? '';
  const dados = tipo.includes('application/json')
    ? new URLSearchParams(Object.entries((await req.json().catch(() => ({}))) as Record<string, string>))
    : new URLSearchParams(await req.text());
  const g = (k: string) => dados.get(k) ?? '';
  const banco = obterBanco();
  let r;
  if (g('grant_type') === 'authorization_code') {
    r = await trocarCodigo(banco, { codigo: g('code'), clientId: g('client_id'), redirectUri: g('redirect_uri'), codeVerifier: g('code_verifier') });
  } else if (g('grant_type') === 'refresh_token') {
    r = await renovar(banco, { refreshToken: g('refresh_token'), clientId: g('client_id') });
  } else {
    r = { error: 'unsupported_grant_type' as const, error_description: 'use authorization_code ou refresh_token' };
  }
  return NextResponse.json(r, { status: 'error' in r ? 400 : 200, headers: semCache });
}
