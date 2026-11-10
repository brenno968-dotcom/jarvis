import { NextResponse, type NextRequest } from 'next/server';
import { metadadosServidor } from '@jarvis/core';
import { baseUrl } from '../../../lib/base';

export const dynamic = 'force-dynamic';
export function GET(req: NextRequest) {
  return NextResponse.json(metadadosServidor(baseUrl(req)));
}
