import { NextResponse } from 'next/server';
import { addBackupRun } from '@/lib/benchmark-store';

export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  await req.json().catch(() => ({}));
  const scenario = 'flight_rebooking';
  const run = addBackupRun(scenario);
  return NextResponse.json({ ok: true, run });
}
