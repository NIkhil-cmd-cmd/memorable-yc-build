import { NextResponse } from 'next/server';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

export const dynamic = 'force-dynamic';
const exec = promisify(execFile);
const ROOT = path.resolve(process.cwd(), '../..');
const DB = path.join(ROOT, 'data/memorable.db');

export async function GET() {
  try {
    if (!fs.existsSync(DB)) {
      return NextResponse.json({
        layers: [],
        metrics: {},
        trace_count: 0,
        initialized: false,
      });
    }

    const script = `
import json, sqlite3
conn = sqlite3.connect("${DB.replace(/\\/g, '/')}")
layers = conn.execute("SELECT layer, status, detail, last_used FROM layer_status").fetchall()
metrics = dict(conn.execute("SELECT key, value FROM metrics").fetchall())
traces = conn.execute("SELECT COUNT(*) FROM traces").fetchone()[0]
conn.close()
print(json.dumps({"layers":[{"layer":l,"status":s,"detail":d,"last_used":u} for l,s,d,u in layers],"metrics":metrics,"trace_count":traces,"initialized":True}))
`;
    const { stdout } = await exec('uv', ['run', 'python', '-c', script], {
      cwd: path.join(ROOT, 'packages/memorable'),
      timeout: 10_000,
    });
    return NextResponse.json(JSON.parse(stdout.trim()));
  } catch {
    return NextResponse.json({ initialized: false, error: 'status unavailable' });
  }
}
