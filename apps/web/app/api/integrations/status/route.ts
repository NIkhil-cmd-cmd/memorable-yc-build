import { NextResponse } from 'next/server';
import fs from 'node:fs';
import path from 'node:path';

export const dynamic = 'force-dynamic';

function configured(keys: string[]) {
  return keys.every((key) => Boolean(process.env[key]?.trim()));
}

export async function GET() {
  const root = path.resolve(process.cwd(), '../..');
  const dbPath = path.join(root, 'data', 'memorable.db');

  const livekitKeys = ['LIVEKIT_URL', 'LIVEKIT_API_KEY', 'LIVEKIT_API_SECRET'];
  const mossKeys = ['MOSS_PROJECT_ID', 'MOSS_PROJECT_KEY'];
  const truefoundryKeys = ['TRUEFOUNDRY_ENDPOINT', 'TRUEFOUNDRY_API_KEY'];

  const payload = {
    generated_at: new Date().toISOString(),
    integrations: {
      livekit: {
        configured: configured(livekitKeys),
        required_env: livekitKeys,
        used_for: 'Realtime voice transport + room token minting',
      },
      moss: {
        configured: configured(mossKeys),
        required_env: mossKeys,
        indexes: ['knowledge', 'memory', 'workflows'],
        used_for: 'Layered retrieval (knowledge, episodic/semantic memory, workflows)',
      },
      truefoundry: {
        configured: configured(truefoundryKeys),
        required_env: truefoundryKeys,
        routes: ['truefoundry-openai', 'truefoundry-minimax'],
        used_for: 'Optional OpenAI-compatible model gateway routing',
      },
    },
    capabilities: {
      benchmark_api: true,
      sse_events: true,
      python_sdk: true,
      typescript_sdk: false,
      go_sdk: false,
      grpc_api: false,
      memory_db_present: fs.existsSync(dbPath),
    },
  };

  return NextResponse.json(payload, {
    headers: { 'Cache-Control': 'no-store' },
  });
}
