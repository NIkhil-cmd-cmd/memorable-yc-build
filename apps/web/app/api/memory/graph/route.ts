import { NextResponse } from 'next/server';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';

export const dynamic = 'force-dynamic';
const exec = promisify(execFile);
const ROOT = path.resolve(process.cwd(), '../..');

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const task = searchParams.get('task') ?? 'flight_rebooking';

  const script = `
import json
from memorable.client import Memorable
m = Memorable.from_env()
print(json.dumps(m.get_graph("${task}")))
`;
  try {
    const { stdout } = await exec('uv', ['run', 'python', '-c', script], {
      cwd: path.join(ROOT, 'packages/memorable'),
      env: { ...process.env, PYTHONPATH: path.join(ROOT, 'packages/memorable') },
      timeout: 15_000,
    });
    return NextResponse.json(JSON.parse(stdout.trim()));
  } catch {
    return NextResponse.json({ nodes: [], edges: [] });
  }
}
