import { NextResponse } from 'next/server';
import { createRun } from '@/lib/benchmark-store';

export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({}));
    const scenario =
      body?.scenario_id === 'billing_dispute' || body?.scenario_id === 'phone_service_issue'
        ? body.scenario_id
        : 'internet_dropout';
    const run = createRun(scenario);
    return NextResponse.json({ ok: true, run });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'failed to start benchmark';
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
