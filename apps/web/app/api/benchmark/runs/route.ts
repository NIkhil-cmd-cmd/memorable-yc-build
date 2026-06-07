import { NextResponse } from 'next/server';
import { listRuns } from '@/lib/benchmark-store';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const url = new URL(req.url);
  const limit = Number(url.searchParams.get('limit') ?? 20);
  return NextResponse.json({ runs: listRuns(Number.isFinite(limit) ? limit : 20) });
}
