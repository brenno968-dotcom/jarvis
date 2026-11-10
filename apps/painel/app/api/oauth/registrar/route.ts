import { NextResponse, type NextRequest } from 'next/server';
import { registrarCliente } from '@jarvis/core';
import { obterBanco } from '../../../../lib/servidor';

export const dynamic = 'force-dynamic';

/** Registro dinâmico de cliente (RFC 7591), só com redirect para o Claude. */
export async function POST(req: NextRequest) {
  let corpo: { redirect_uris?: unknown; client_name?: unknown };
  try {
    corpo = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid_client_metadata' }, { status: 400 });
  }
  const uris = Array.isArray(corpo.redirect_uris) ? corpo.redirect_uris.filter((u): u is string => typeof u === 'string') : [];
  try {
    const { client_id } = await registrarCliente(obterBanco(), { nome: typeof corpo.client_name === 'string' ? corpo.client_name : undefined, redirectUris: uris });
    return NextResponse.json(
      {
        client_id,
        redirect_uris: uris,
        token_endpoint_auth_method: 'none',
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
      },
      { status: 201 },
    );
  } catch (e) {
    return NextResponse.json({ error: 'invalid_redirect_uri', error_description: String((e as Error).message) }, { status: 400 });
  }
}
