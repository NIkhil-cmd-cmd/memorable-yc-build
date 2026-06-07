# Memorable

**Self-adapting memory for flight rebooking voice agents.**

Memorable gives LiveKit agents institutional memory so they stop repeating dead-end booking steps and replay what already worked.

Built for the **YC Conversational AI Hackathon 2026**.

![Memorable demo](apps/web/public/demo.gif)

## What judges see in the demo

Same prompt, two runs:

- **Cold run**: `search_basic_fares -> choose_late_connection -> retry_booking_failed_fare_class -> escalate_manual_ticketing`
- **Memory run**: `check_waiver_status -> search_partner_flights -> apply_same_day_policy -> auto_rebook_and_issue_voucher`

This is shown side-by-side in `/demo` with trace logs, tool path divergence, and summary metrics.

## Sponsor stack used

- **LiveKit**: realtime voice transport, token minting, agent dispatch metadata.
- **Moss**: retrieval + embeddings across `knowledge`, `memory`, and `workflows` indexes.
- **TrueFoundry**: model routing gateway.
- **MiniMax**: primary model route via `truefoundry-minimax`.

## 3-command quick start

```bash
pnpm setup
pnpm memorable:init
pnpm dev:all
```

Then open:

- `http://localhost:3000` (landing)
- `http://localhost:3000/demo` (benchmark)

## Environment

Copy and fill:

```bash
cp .env.example .env.local
cp apps/web/.env.example apps/web/.env.local
```

Minimum required:

```env
LIVEKIT_URL=
LIVEKIT_API_KEY=
LIVEKIT_API_SECRET=
AGENT_NAME=memorable-agent

MOSS_PROJECT_ID=
MOSS_PROJECT_KEY=
MOSS_INDEX_NAME=knowledge
MOSS_MEMORY_INDEX_NAME=memory

MEMORABLE_EVENTS_URL=http://localhost:3000/api/events/publish

# For routed MiniMax in demo
TRUEFOUNDRY_ENDPOINT=
TRUEFOUNDRY_API_KEY=
TRUEFOUNDRY_MINIMAX_MODEL=MiniMax-Text-01
```

For hosted hackathon demos (without full auth), allow token route explicitly:

```env
ALLOW_PUBLIC_DEMO=true
```

## Integration (5 lines)

```python
from memorable import Memorable
from memorable.livekit import attach

memory = Memorable.from_env()
await memory.ensure_loaded()
hook = attach(agent, memory, mode="full")
```

## Project layout

- `apps/web`: Next.js landing + benchmark + APIs.
- `worker/agent.py`: LiveKit agent runtime and tool execution.
- `packages/memorable`: Python memory SDK (traces, semantic patterns, GNN workflow export).
- `data/knowledge_base.json`: flight disruption knowledge docs indexed to Moss.

## Key APIs

- `POST /api/token`: LiveKit token + dispatch metadata (`memory_mode`, `scenario_id`, `model_route`).
- `POST /api/benchmark/start`: start a benchmark run.
- `POST /api/benchmark/backup`: generate replay fallback run.
- `GET /api/events`: SSE trace stream.
- `GET /api/integrations/status`: integration readiness.

## Dev commands

```bash
pnpm dev:all
pnpm dev:web
pnpm dev:worker
pnpm build
pnpm memorable:init
pnpm worker:download-files
```
