import { NextResponse, type NextRequest } from 'next/server';
import { metadadosRecurso } from '@jarvis/core';
import { baseUrl } from '../../../../lib/base';

export const dynamic = 'force-dynamic';
export function GET(req: NextRequest) {
  return NextResponse.json(metadadosRecurso(baseUrl(req)));
}
