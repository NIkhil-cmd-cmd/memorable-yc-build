import { randomUUID } from 'node:crypto';
import type {
  BenchmarkEvent,
  BenchmarkEventData,
  BenchmarkMode,
  BenchmarkRun,
  BenchmarkScenario,
  SessionStats,
  SessionTrace,
} from '@/lib/benchmark-types';

const CANONICAL_SCENARIO: BenchmarkScenario = 'flight_rebooking';
const DEAD_END_TOOLS = new Set([
  'choose_late_connection',
  'retry_booking_failed_fare_class',
  'escalate_manual_ticketing',
]);

const runs = new Map<string, BenchmarkRun>();
const runOrder: string[] = [];

function nowIso() {
  return new Date().toISOString();
}

function normalizeScenario(): BenchmarkScenario {
  return CANONICAL_SCENARIO;
}

function emptyStats(): SessionStats {
  return {
    model_calls: 0,
    tool_calls: 0,
    recall_events: 0,
    input_tokens: 0,
    output_tokens: 0,
    estimated_cost_usd: 0,
    duration_ms: 0,
  };
}

function computeSummary(run: BenchmarkRun) {
  if (!run.cold || !run.memory) return undefined;

  const coldTokens = run.cold.stats.input_tokens + run.cold.stats.output_tokens;
  const memTokens = run.memory.stats.input_tokens + run.memory.stats.output_tokens;
  const tokenSavingsPct = coldTokens > 0 ? ((coldTokens - memTokens) / coldTokens) * 100 : 0;
  const coldHasDeadEnd = run.cold.steps.some((step) => DEAD_END_TOOLS.has(step));
  const memoryHasDeadEnd = run.memory.steps.some((step) => DEAD_END_TOOLS.has(step));

  return {
    token_savings_pct: Number(tokenSavingsPct.toFixed(1)),
    tool_call_delta: run.cold.stats.tool_calls - run.memory.stats.tool_calls,
    avoided_dead_end: coldHasDeadEnd && !memoryHasDeadEnd,
    total_cost_usd: Number(
      (run.cold.stats.estimated_cost_usd + run.memory.stats.estimated_cost_usd).toFixed(4)
    ),
  };
}

function setRun(run: BenchmarkRun) {
  run.updated_at = nowIso();
  run.summary = computeSummary(run);
  if (run.cold?.status === 'complete' && run.memory?.status === 'complete') {
    run.status = 'complete';
  }
  runs.set(run.run_id, run);
}

function getSessionByMode(run: BenchmarkRun, mode: BenchmarkMode): SessionTrace | undefined {
  return mode === 'cold' ? run.cold : run.memory;
}

function setSessionByMode(run: BenchmarkRun, mode: BenchmarkMode, session: SessionTrace) {
  if (mode === 'cold') run.cold = session;
  else run.memory = session;
}

export function createRun(): BenchmarkRun {
  const run_id = randomUUID().slice(0, 8);
  const run: BenchmarkRun = {
    run_id,
    source: 'live',
    status: 'running',
    scenario_id: normalizeScenario(),
    created_at: nowIso(),
    updated_at: nowIso(),
  };
  runs.set(run_id, run);
  runOrder.unshift(run_id);
  if (runOrder.length > 100) {
    const drop = runOrder.pop();
    if (drop) runs.delete(drop);
  }
  return run;
}

export function resetRuns() {
  runs.clear();
  runOrder.length = 0;
}

export function getRun(run_id: string): BenchmarkRun | null {
  return runs.get(run_id) ?? null;
}

export function listRuns(limit = 20): BenchmarkRun[] {
  return runOrder
    .slice(0, limit)
    .map((id) => runs.get(id))
    .filter((r): r is BenchmarkRun => !!r);
}

function estimateTokens(text: string) {
  return Math.max(1, Math.round(text.length / 4));
}

function applyStats(session: SessionTrace, event: BenchmarkEvent, data: BenchmarkEventData) {
  if (event.type === 'model_turn') {
    session.stats.model_calls += 1;
    const inTok = Number(data.input_tokens ?? estimateTokens(String(data.user_text ?? '')));
    const outTok = Number(data.output_tokens ?? Math.round(inTok * 1.1));
    session.stats.input_tokens += inTok;
    session.stats.output_tokens += outTok;
    session.stats.estimated_cost_usd += Number(
      data.estimated_cost_usd ?? (inTok + outTok) * 0.0000008
    );
  }

  if (event.type === 'recall') {
    session.stats.recall_events += 1;
  }

  if (event.type === 'tool_call') {
    session.stats.tool_calls += 1;
    const tool = data.tool;
    if (typeof tool === 'string' && !session.steps.includes(tool)) {
      session.steps.push(tool);
    }
  }

  if (event.type === 'session_end') {
    session.status = 'complete';
    session.ended_at = event.timestamp;
    const ms = new Date(session.ended_at).getTime() - new Date(session.started_at).getTime();
    session.stats.duration_ms = Math.max(0, ms);
    if (Array.isArray(data.steps)) {
      session.steps = data.steps.filter((s): s is string => typeof s === 'string');
    }
  }
}

export function ingestBenchmarkEvent(event: BenchmarkEvent) {
  const data = event.data ?? {};
  const run_id = typeof data.run_id === 'string' ? data.run_id : undefined;
  const mode = data.mode === 'cold' ? 'cold' : data.mode === 'full' ? 'full' : undefined;
  const scenario = normalizeScenario();

  if (!run_id || !mode) return;

  const run = runs.get(run_id);
  if (!run) return;

  let session = getSessionByMode(run, mode);
  if (!session && event.type === 'session_start') {
    session = {
      session_id: typeof data.session_id === 'string' ? data.session_id : `${mode}-${run_id}`,
      mode,
      scenario_id: scenario,
      status: 'running',
      started_at: event.timestamp,
      events: [],
      steps: [],
      stats: emptyStats(),
    };
    setSessionByMode(run, mode, session);
  }

  if (!session) return;

  session.events.push(event);
  if (session.events.length > 500) session.events.shift();
  applyStats(session, event, data);

  setRun(run);
}

const BACKUP_SCENARIO = {
  cold: [
    'check_waiver_status',
    'search_basic_fares',
    'search_partner_flights',
    'choose_late_connection',
    'retry_booking_failed_fare_class',
    'escalate_manual_ticketing',
  ],
  memory: [
    'check_waiver_status',
    'search_basic_fares',
    'search_partner_flights',
    'apply_same_day_policy',
    'auto_rebook_and_issue_voucher',
  ],
  moss_refs: [
    'airline_irrops_waiver_policy',
    'partner_inventory_matrix',
    'restricted_fare_dead_end_patterns',
    'same_day_rebooking_playbook',
  ],
};

export function addBackupRun(_scenario_id: BenchmarkScenario): BenchmarkRun {
  const run = createRun();
  run.source = 'backup';

  const mkSession = (
    mode: BenchmarkMode,
    tools: string[],
    startedAtMs: number,
    mossRefs?: string[]
  ): SessionTrace => {
    const started = new Date(startedAtMs).toISOString();
    const stepMs = mode === 'cold' ? 1450 : 920;
    const doneAtMs = startedAtMs + tools.length * stepMs + (mode === 'cold' ? 4300 : 2500);
    const inTok = (mode === 'cold' ? 350 : 240) + tools.length * (mode === 'cold' ? 100 : 65);
    const outTok = (mode === 'cold' ? 430 : 320) + tools.length * (mode === 'cold' ? 122 : 86);
    const estCost = Number(((inTok + outTok) * 0.0000043).toFixed(4));

    const events: BenchmarkEvent[] = [
      {
        type: 'session_start',
        timestamp: started,
        data: {
          run_id: run.run_id,
          mode,
          scenario_id: CANONICAL_SCENARIO,
          session_id: `${mode}-${run.run_id}`,
        },
      },
      {
        type: 'model_turn',
        timestamp: new Date(startedAtMs + 260).toISOString(),
        data: {
          run_id: run.run_id,
          mode,
          scenario_id: CANONICAL_SCENARIO,
          user_text: 'My flight got canceled and I need to be in San Francisco tonight.',
          input_tokens: inTok,
          output_tokens: outTok,
          estimated_cost_usd: estCost,
        },
      },
      {
        type: 'recall',
        timestamp: new Date(startedAtMs + 420).toISOString(),
        data: {
          run_id: run.run_id,
          mode,
          scenario_id: CANONICAL_SCENARIO,
          layer: mode === 'cold' ? 'knowledge' : 'workflow',
          layers_active: mode === 'cold' ? ['knowledge'] : ['workflow', 'semantic', 'knowledge'],
          next_action: tools[0],
          elapsed_ms: mode === 'cold' ? 30 : 15,
          ...(mode === 'full' && mossRefs ? { moss_refs: mossRefs } : {}),
        },
      },
      ...tools.map((tool, i) => ({
        type: 'tool_call',
        timestamp: new Date(startedAtMs + 700 + i * stepMs).toISOString(),
        data: {
          run_id: run.run_id,
          mode,
          scenario_id: CANONICAL_SCENARIO,
          tool,
          steps: tools.slice(0, i + 1),
          outcome: DEAD_END_TOOLS.has(tool) ? 'failure' : 'success',
        },
      })),
      {
        type: 'session_end',
        timestamp: new Date(doneAtMs).toISOString(),
        data: {
          run_id: run.run_id,
          mode,
          scenario_id: CANONICAL_SCENARIO,
          session_id: `${mode}-${run.run_id}`,
          steps: tools,
        },
      },
    ] as BenchmarkEvent[];

    const stats = emptyStats();
    for (const ev of events) {
      applyStats(
        {
          session_id: `${mode}-${run.run_id}`,
          mode,
          scenario_id: CANONICAL_SCENARIO,
          status: 'running',
          started_at: started,
          events: [],
          steps: [],
          stats,
        },
        ev,
        ev.data
      );
    }

    return {
      session_id: `${mode}-${run.run_id}`,
      mode,
      scenario_id: CANONICAL_SCENARIO,
      status: 'complete',
      started_at: started,
      ended_at: new Date(doneAtMs).toISOString(),
      events,
      steps: tools,
      stats,
    };
  };

  const coldStartMs = Date.now();
  run.cold = mkSession('cold', BACKUP_SCENARIO.cold, coldStartMs);
  const coldEndMs = run.cold.ended_at ? new Date(run.cold.ended_at).getTime() : coldStartMs + 1000;
  run.memory = mkSession(
    'full',
    BACKUP_SCENARIO.memory,
    coldEndMs + 1200,
    BACKUP_SCENARIO.moss_refs
  );
  run.status = 'complete';
  setRun(run);
  return run;
}
