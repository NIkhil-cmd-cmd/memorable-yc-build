import { NextResponse } from 'next/server';
import { createRun } from '@/lib/benchmark-store';

export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  try {
    await req.json().catch(() => ({}));
    const run = createRun();
    return NextResponse.json({ ok: true, run });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'failed to start benchmark';
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
