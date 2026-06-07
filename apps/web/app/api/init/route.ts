import { NextResponse } from 'next/server';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';

export const dynamic = 'force-dynamic';
const exec = promisify(execFile);
const ROOT = path.resolve(process.cwd(), '../..');

export async function POST() {
  try {
    const { stdout } = await exec('uv', ['run', 'python', '-m', 'memorable.client'], {
      cwd: path.join(ROOT, 'packages/memorable'),
      env: { ...process.env, PYTHONPATH: path.join(ROOT, 'packages/memorable') },
      timeout: 120_000,
    });
    return NextResponse.json({ ok: true, output: stdout });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'init failed';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function GET() {
  return POST();
}
