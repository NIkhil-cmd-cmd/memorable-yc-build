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

const runs = new Map<string, BenchmarkRun>();
const runOrder: string[] = [];

function nowIso() {
  return new Date().toISOString();
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

  return {
    token_savings_pct: Number(tokenSavingsPct.toFixed(1)),
    tool_call_delta: run.cold.stats.tool_calls - run.memory.stats.tool_calls,
    avoided_dead_end:
      run.cold.steps.includes('factory_reset_router') &&
      !run.memory.steps.includes('factory_reset_router'),
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

export function createRun(scenario_id: BenchmarkScenario): BenchmarkRun {
  const run_id = randomUUID().slice(0, 8);
  const run: BenchmarkRun = {
    run_id,
    source: 'live',
    status: 'running',
    scenario_id,
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
  const chars = text.length;
  return Math.max(1, Math.round(chars / 4));
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
  const scenario =
    data.scenario_id === 'billing_dispute' ||
    data.scenario_id === 'phone_service_issue' ||
    data.scenario_id === 'internet_dropout'
      ? data.scenario_id
      : 'internet_dropout';

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

const BACKUP_SCENARIOS: Record<BenchmarkScenario, { cold: string[]; memory: string[] }> = {
  internet_dropout: {
    cold: [
      'run_speed_test',
      'check_wifi_channel',
      'check_dns_resolver',
      'power_cycle_router',
      'factory_reset_router',
      'reprovision_router',
      'reconnect_all_devices',
      'escalate_field_tech',
    ],
    memory: ['check_outage_map', 'check_line_signal', 'reboot_modem'],
  },
  billing_dispute: {
    cold: [
      'pull_invoice_history',
      'check_payment_processor',
      'verify_plan_entitlements',
      'reapply_promo_codes',
      'escalate_tier2',
      'request_manual_adjustment',
      'reopen_ticket',
    ],
    memory: ['pull_account_billing', 'detect_duplicate_charge', 'apply_bill_credit'],
  },
  phone_service_issue: {
    cold: [
      'check_sim_registration',
      'verify_tower_handshake',
      'toggle_roaming_mode',
      'factory_reset_router',
      'reset_network_stack',
      'escalate_network_ops',
    ],
    memory: ['check_outage_map', 'reset_apn_settings', 'reboot_modem'],
  },
};

export function addBackupRun(scenario_id: BenchmarkScenario): BenchmarkRun {
  const run = createRun(scenario_id);
  run.source = 'backup';

  const steps = BACKUP_SCENARIOS[scenario_id];

  const mkSession = (mode: BenchmarkMode, tools: string[]): SessionTrace => {
    const startedAtMs = Date.now() + (mode === 'cold' ? 0 : 800);
    const started = new Date(startedAtMs).toISOString();
    const stepMs = mode === 'cold' ? 880 : 360;
    const doneAtMs = startedAtMs + tools.length * stepMs + (mode === 'cold' ? 3200 : 1200);
    const baseIn = mode === 'cold' ? 260 : 140;
    const baseOut = mode === 'cold' ? 340 : 185;
    const inTok = baseIn + tools.length * (mode === 'cold' ? 90 : 35);
    const outTok = baseOut + tools.length * (mode === 'cold' ? 120 : 44);
    const estCost = Number(((inTok + outTok) * 0.0000043).toFixed(4));
    const events: BenchmarkEvent[] = [
      {
        type: 'session_start',
        timestamp: started,
        data: { run_id: run.run_id, mode, scenario_id, session_id: `${mode}-${run.run_id}` },
      },
      {
        type: 'model_turn',
        timestamp: new Date(startedAtMs + 260).toISOString(),
        data: {
          run_id: run.run_id,
          mode,
          scenario_id,
          user_text: 'Customer support request received',
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
          scenario_id,
          layer: mode === 'cold' ? 'knowledge' : 'workflow',
          layers_active: mode === 'cold' ? ['knowledge'] : ['workflow', 'semantic', 'knowledge'],
          next_action: tools[0],
          elapsed_ms: mode === 'cold' ? 32 : 18,
        },
      },
      ...tools.map((tool, i) => ({
        type: 'tool_call',
        timestamp: new Date(startedAtMs + 700 + i * stepMs).toISOString(),
        data: {
          run_id: run.run_id,
          mode,
          scenario_id,
          tool,
          steps: tools.slice(0, i + 1),
          outcome:
            mode === 'cold' && (tool.includes('factory_reset') || tool.includes('escalate'))
              ? 'failure'
              : 'success',
        },
      })),
      {
        type: 'session_end',
        timestamp: new Date(doneAtMs).toISOString(),
        data: {
          run_id: run.run_id,
          mode,
          scenario_id,
          session_id: `${mode}-${run.run_id}`,
          steps: tools,
        },
      },
    ] as BenchmarkEvent[];

    const stats = emptyStats();
    for (const ev of events)
      applyStats(
        {
          session_id: `${mode}-${run.run_id}`,
          mode,
          scenario_id,
          status: 'running',
          started_at: started,
          events: [],
          steps: [],
          stats,
        },
        ev,
        ev.data
      );

    return {
      session_id: `${mode}-${run.run_id}`,
      mode,
      scenario_id,
      status: 'complete',
      started_at: started,
      ended_at: new Date(doneAtMs).toISOString(),
      events,
      steps: tools,
      stats,
    };
  };

  run.cold = mkSession('cold', steps.cold);
  run.memory = mkSession('full', steps.memory);
  run.status = 'complete';
  setRun(run);
  return run;
}
