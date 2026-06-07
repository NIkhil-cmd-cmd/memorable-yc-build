import { NextResponse } from 'next/server';
import { ingestBenchmarkEvent } from '@/lib/benchmark-store';
import { publishEvent } from '@/lib/events';

export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  try {
    const body = await req.json();
    publishEvent({
      type: body.type ?? 'unknown',
      data: body.data ?? {},
      timestamp: body.timestamp ?? new Date().toISOString(),
    });
    ingestBenchmarkEvent({
      type: body.type ?? 'unknown',
      data: body.data ?? {},
      timestamp: body.timestamp ?? new Date().toISOString(),
    });
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ error: 'invalid payload' }, { status: 400 });
  }
}
