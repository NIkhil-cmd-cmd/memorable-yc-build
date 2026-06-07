import { NextResponse } from 'next/server';
import { addBackupRun } from '@/lib/benchmark-store';

export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const scenario =
    body?.scenario_id === 'billing_dispute' || body?.scenario_id === 'phone_service_issue'
      ? body.scenario_id
      : 'internet_dropout';
  const run = addBackupRun(scenario);
  return NextResponse.json({ ok: true, run });
}
