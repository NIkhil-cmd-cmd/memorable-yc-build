import { NextResponse } from 'next/server';
import { resetRuns } from '@/lib/benchmark-store';

export const dynamic = 'force-dynamic';

export async function POST() {
  resetRuns();
  return NextResponse.json({ ok: true });
}
