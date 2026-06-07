import { NextResponse } from 'next/server';
import { getRun } from '@/lib/benchmark-store';

export const dynamic = 'force-dynamic';

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const run = getRun(id);
  if (!run) return NextResponse.json({ error: 'run not found' }, { status: 404 });
  return NextResponse.json({ run });
}
