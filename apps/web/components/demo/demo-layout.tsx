'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { TokenSource } from 'livekit-client';
import { RoomAudioRenderer, useSession } from '@livekit/components-react';
import { AgentAudioVisualizerBar } from '@/components/agents-ui/agent-audio-visualizer-bar';
import { AgentChatTranscript } from '@/components/agents-ui/agent-chat-transcript';
import { AgentControlBar } from '@/components/agents-ui/agent-control-bar';
import { AgentSessionProvider } from '@/components/agents-ui/agent-session-provider';
import { StartAudioButton } from '@/components/agents-ui/start-audio-button';
import type {
  BenchmarkEvent,
  BenchmarkMode,
  BenchmarkRun,
  BenchmarkScenario,
  SessionTrace,
} from '@/lib/benchmark-types';

const SCENARIOS: Record<BenchmarkScenario, { label: string; prompt: string }> = {
  internet_dropout: {
    label: 'Internet Dropout',
    prompt: 'My internet keeps dropping every hour.',
  },
  billing_dispute: {
    label: 'Billing Dispute',
    prompt: 'I was overcharged this month and need this fixed today.',
  },
  phone_service_issue: {
    label: 'Phone Service Issue',
    prompt: 'My phone shows bars but calls keep failing.',
  },
};

type IntegrationStatus = {
  integrations: {
    truefoundry: {
      configured: boolean;
    };
  };
};

function fmtUsd(value: number) {
  return `$${value.toFixed(4)}`;
}

function fmtMs(value: number) {
  if (!Number.isFinite(value) || value <= 0) return '0s';
  return `${Math.round(value / 1000)}s`;
}

function pctDrop(from: number, to: number) {
  if (from <= 0) return 0;
  return ((from - to) / from) * 100;
}

function humanizeToolName(tool: string) {
  return tool.replace(/_/g, ' ');
}

function shortTs(ts: string) {
  const d = new Date(ts);
  return d.toLocaleTimeString([], { hour12: false });
}

function detailForEvent(event: BenchmarkEvent) {
  if (event.type === 'tool_call') {
    return `${humanizeToolName(String(event.data.tool ?? 'tool'))} (${event.data.outcome ?? 'ok'})`;
  }
  if (event.type === 'recall') {
    const layer = String(event.data.layer ?? 'none');
    const action = event.data.next_action ? ` -> ${String(event.data.next_action)}` : '';
    return `${layer}${action}`;
  }
  if (event.type === 'model_turn') {
    return `${event.data.input_tokens ?? 0} in / ${event.data.output_tokens ?? 0} out`;
  }
  if (event.type === 'session_end') {
    return `steps: ${(event.data.steps as string[] | undefined)?.length ?? 0}`;
  }
  return 'event';
}

function estimateTokens(text: string) {
  return Math.max(1, Math.round(text.length / 4));
}

function rebuildSession(
  base: SessionTrace | undefined,
  events: BenchmarkEvent[]
): SessionTrace | undefined {
  if (!base) return undefined;

  const stats = {
    model_calls: 0,
    tool_calls: 0,
    recall_events: 0,
    input_tokens: 0,
    output_tokens: 0,
    estimated_cost_usd: 0,
    duration_ms: 0,
  };
  const steps: string[] = [];
  let endedAt: string | undefined;

  for (const event of events) {
    const data = event.data ?? {};
    if (event.type === 'model_turn') {
      stats.model_calls += 1;
      const inTok = Number(data.input_tokens ?? estimateTokens(String(data.user_text ?? '')));
      const outTok = Number(data.output_tokens ?? Math.round(inTok * 1.1));
      stats.input_tokens += inTok;
      stats.output_tokens += outTok;
      stats.estimated_cost_usd += Number(data.estimated_cost_usd ?? (inTok + outTok) * 0.0000008);
    }
    if (event.type === 'recall') stats.recall_events += 1;
    if (event.type === 'tool_call') {
      stats.tool_calls += 1;
      const tool = data.tool;
      if (typeof tool === 'string' && !steps.includes(tool)) steps.push(tool);
    }
    if (event.type === 'session_end') {
      endedAt = event.timestamp;
      if (Array.isArray(data.steps)) {
        steps.length = 0;
        for (const step of data.steps) if (typeof step === 'string') steps.push(step);
      }
    }
  }

  if (endedAt) {
    const ms = new Date(endedAt).getTime() - new Date(base.started_at).getTime();
    stats.duration_ms = Math.max(0, ms);
  }

  return {
    ...base,
    status: endedAt ? 'complete' : 'running',
    ended_at: endedAt,
    events,
    steps,
    stats,
  };
}

function aggregateFromRuns(runs: BenchmarkRun[]) {
  const complete = runs.filter((r) => r.status === 'complete' && r.cold && r.memory);
  if (!complete.length) {
    return {
      runs: 0,
      avgTokenSavingsPct: 0,
      deadEndsAvoided: 0,
      avgColdTools: 0,
      avgMemoryTools: 0,
    };
  }

  const totalSavings = complete.reduce(
    (acc, run) => acc + (run.summary?.token_savings_pct ?? 0),
    0
  );
  const deadEndsAvoided = complete.filter((run) => run.summary?.avoided_dead_end).length;
  const avgColdTools =
    complete.reduce((acc, run) => acc + (run.cold?.stats.tool_calls ?? 0), 0) / complete.length;
  const avgMemoryTools =
    complete.reduce((acc, run) => acc + (run.memory?.stats.tool_calls ?? 0), 0) / complete.length;

  return {
    runs: complete.length,
    avgTokenSavingsPct: totalSavings / complete.length,
    deadEndsAvoided,
    avgColdTools,
    avgMemoryTools,
  };
}

function firstDivergence(coldSteps: string[], memorySteps: string[]) {
  const total = Math.max(coldSteps.length, memorySteps.length);
  for (let i = 0; i < total; i += 1) {
    const cold = coldSteps[i];
    const memory = memorySteps[i];
    if ((cold || memory) && cold !== memory) {
      return { index: i, cold: cold ?? null, memory: memory ?? null };
    }
  }
  return null;
}

function WorkflowGraph({
  coldSteps,
  memorySteps,
  divergenceIndex,
}: {
  coldSteps: string[];
  memorySteps: string[];
  divergenceIndex: number | null;
}) {
  const coldCount = Math.max(2, coldSteps.length);
  const memoryCount = Math.max(2, memorySteps.length);
  const coldNodes = Array.from({ length: coldCount }).map((_, i) => ({
    x: 74 + i * (760 / Math.max(1, coldCount - 1)),
    y: 96,
    label: coldSteps[i] ?? `cold_step_${i + 1}`,
  }));
  const memoryNodes = Array.from({ length: memoryCount }).map((_, i) => ({
    x: 74 + i * (760 / Math.max(1, memoryCount - 1)),
    y: 222,
    label: memorySteps[i] ?? `mem_step_${i + 1}`,
  }));

  return (
    <section className="mem-panel mem-workflow-graph">
      <div className="mem-graph-head">
        <p className="mem-section-label">Workflow Graph (Shared GNN Replay)</p>
        <p className="mem-graph-note">
          Cold path explores longer chain; memory path takes ranked path from retrieved graph.
        </p>
      </div>
      <svg viewBox="0 0 900 300" className="mem-graph-svg" aria-hidden>
        <text x="20" y="46" className="mem-graph-row-label cold">
          cold
        </text>
        <text x="20" y="270" className="mem-graph-row-label memory">
          memory
        </text>

        <line x1="60" y1="96" x2="840" y2="96" className="mem-graph-track cold" />
        <line x1="60" y1="222" x2="840" y2="222" className="mem-graph-track memory" />

        {coldNodes.map((node, i) => (
          <g key={`cold-${node.label}-${i}`}>
            {i > 0 && (
              <line
                x1={coldNodes[i - 1].x}
                y1={coldNodes[i - 1].y}
                x2={node.x}
                y2={node.y}
                className={`mem-graph-edge cold ${divergenceIndex !== null && i - 1 >= divergenceIndex ? 'is-divergence' : ''}`}
              />
            )}
            <rect
              x={node.x - 42}
              y={node.y - 17}
              width="84"
              height="34"
              rx="7"
              className={`mem-graph-node cold ${divergenceIndex !== null && i >= divergenceIndex ? 'is-divergence' : ''}`}
            />
            <text x={node.x} y={node.y + 4} textAnchor="middle" className="mem-graph-label">
              {humanizeToolName(node.label).slice(0, 14)}
            </text>
          </g>
        ))}

        {memoryNodes.map((node, i) => (
          <g key={`memory-${node.label}-${i}`}>
            {i > 0 && (
              <line
                x1={memoryNodes[i - 1].x}
                y1={memoryNodes[i - 1].y}
                x2={node.x}
                y2={node.y}
                className={`mem-graph-edge memory ${divergenceIndex !== null && i - 1 >= divergenceIndex ? 'is-win' : ''}`}
              />
            )}
            <rect
              x={node.x - 42}
              y={node.y - 17}
              width="84"
              height="34"
              rx="7"
              className={`mem-graph-node memory ${divergenceIndex !== null && i >= divergenceIndex ? 'is-win' : ''}`}
            />
            <text x={node.x} y={node.y + 4} textAnchor="middle" className="mem-graph-label">
              {humanizeToolName(node.label).slice(0, 14)}
            </text>
          </g>
        ))}
      </svg>
    </section>
  );
}

function SessionPanel({
  mode,
  runId,
  scenario,
  modelRoute,
  session,
  enabled,
  replayOnly,
  currentTool,
  onFinish,
}: {
  mode: BenchmarkMode;
  runId: string | null;
  scenario: BenchmarkScenario;
  modelRoute: string;
  session: BenchmarkRun['cold'] | BenchmarkRun['memory'];
  enabled: boolean;
  replayOnly?: boolean;
  currentTool?: string | null;
  onFinish: () => void;
}) {
  const tokenSource = useMemo(
    () =>
      TokenSource.custom(async () => {
        if (!runId) {
          throw new Error('Benchmark run not initialized');
        }
        const res = await fetch('/api/token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            memory_mode: mode,
            scenario_id: scenario,
            run_id: runId,
            model_route: modelRoute,
          }),
        });
        if (!res.ok) throw new Error(await res.text());
        return res.json();
      }),
    [mode, runId, scenario, modelRoute]
  );

  const sessionHook = useSession(tokenSource, { agentName: 'memorable-agent' });
  const tools = session?.steps ?? [];

  const panelTitle = mode === 'cold' ? 'Cold Session' : 'Memory Session';
  const panelHint =
    mode === 'cold'
      ? 'No shared memory. Baseline behavior.'
      : 'Shared memory + workflow replay active.';
  const memoryLocked = mode === 'full' && !!runId && !enabled && !replayOnly;

  return (
    <AgentSessionProvider session={sessionHook} key={`${mode}-${runId ?? 'none'}`}>
      <article
        className={`mem-panel mem-session ${mode === 'cold' ? 'mem-session--cold' : 'mem-session--memory'}`}
      >
        <div className="mem-session-head">
          <div>
            <h3 className="mem-session-title">{panelTitle}</h3>
            <p className="mem-session-copy">{panelHint}</p>
          </div>
          <span className={`mem-badge ${mode === 'cold' ? 'mem-badge-cold' : 'mem-badge-memory'}`}>
            {session?.status ?? 'idle'}
          </span>
        </div>

        <div className="mem-panel-muted mem-session-audio">
          {memoryLocked ? (
            <div className="mem-memory-lock">
              <p className="mem-section-label">Memory session locked</p>
              <p>Finish the cold run first, then start the memory run.</p>
            </div>
          ) : runId && !replayOnly ? (
            <div className="mem-live-stack">
              <p className="mem-live-label">Live voice scenario</p>
              <p className="mem-live-prompt">“{SCENARIOS[scenario].prompt}”</p>
              <AgentAudioVisualizerBar />
              <AgentChatTranscript className="mem-live-transcript" />
              <AgentControlBar />
              <div style={{ display: 'flex', justifyContent: 'center' }}>
                <StartAudioButton label="Enable microphone" room={sessionHook.room} />
              </div>
              <RoomAudioRenderer />
            </div>
          ) : runId && replayOnly ? (
            <div
              style={{
                minHeight: 248,
                display: 'grid',
                placeItems: 'center',
                textAlign: 'center',
                padding: '16px',
              }}
            >
              <div>
                <p
                  style={{
                    fontSize: '0.74rem',
                    letterSpacing: '0.08em',
                    color: 'var(--mem-muted)',
                  }}
                >
                  REALTIME TRACE PLAYBACK
                </p>
                <p style={{ marginTop: 8, fontFamily: 'var(--mem-serif)', fontSize: '1.45rem' }}>
                  “{SCENARIOS[scenario].prompt}”
                </p>
                <p style={{ marginTop: 10, fontSize: '0.8rem', color: 'var(--mem-muted)' }}>
                  Events and metrics are being replayed from a saved trace timeline.
                </p>
              </div>
            </div>
          ) : (
            <p className="mem-tools-empty">Start a run to open this session.</p>
          )}
        </div>

        <div className="mem-session-metrics">
          <div className="mem-panel-muted mem-metric-box">
            Model calls: {session?.stats.model_calls ?? 0}
          </div>
          <div className="mem-panel-muted mem-metric-box">
            Tokens: {(session?.stats.input_tokens ?? 0) + (session?.stats.output_tokens ?? 0)}
          </div>
          <div className="mem-panel-muted mem-metric-box">
            Cost: {fmtUsd(session?.stats.estimated_cost_usd ?? 0)}
          </div>
          <div className="mem-panel-muted mem-metric-box">
            Duration: {fmtMs(session?.stats.duration_ms ?? 0)}
          </div>
        </div>

        <div className="mem-panel-muted mem-tools">
          <p className="mem-section-label">Tool Path</p>
          <p className="mem-tool-current">
            Current action: {currentTool ? humanizeToolName(currentTool) : 'waiting...'}
          </p>
          {tools.length === 0 ? (
            <p className="mem-tools-empty">No tools executed yet.</p>
          ) : (
            <ol>
              {tools.map((tool, idx) => (
                <li key={`${tool}-${idx}`}>
                  {idx + 1}. {humanizeToolName(tool)}
                </li>
              ))}
            </ol>
          )}
        </div>

        {!replayOnly && (
          <div className="mem-session-actions">
            <button
              type="button"
              disabled={!enabled || !runId}
              onClick={() => sessionHook.start()}
              className={mode === 'cold' ? 'mem-btn-cold' : 'mem-btn-memory'}
            >
              Connect
            </button>
            <button
              type="button"
              disabled={!enabled || !runId}
              onClick={() => {
                sessionHook.end();
                onFinish();
              }}
              className="mem-btn-outline"
            >
              {mode === 'cold' ? 'End cold run' : 'End memory run'}
            </button>
          </div>
        )}
      </article>
    </AgentSessionProvider>
  );
}

export function DemoLayout() {
  const [scenario, setScenario] = useState<BenchmarkScenario>('internet_dropout');
  const [phase, setPhase] = useState<'idle' | 'cold' | 'memory' | 'done'>('idle');
  const [runId, setRunId] = useState<string | null>(null);
  const [modelRoute, setModelRoute] = useState('truefoundry-openai');
  const [runs, setRuns] = useState<BenchmarkRun[]>([]);
  const [activeRun, setActiveRun] = useState<BenchmarkRun | null>(null);
  const [integrationStatus, setIntegrationStatus] = useState<IntegrationStatus | null>(null);
  const [replayIndex, setReplayIndex] = useState(0);
  const [replayPlaying, setReplayPlaying] = useState(false);

  const refreshRuns = useCallback(async () => {
    const res = await fetch('/api/benchmark/runs?limit=25', { cache: 'no-store' });
    if (!res.ok) return;
    const data = await res.json();
    setRuns(data.runs ?? []);
  }, []);

  const refreshActiveRun = useCallback(async () => {
    if (!runId) return;
    const res = await fetch(`/api/benchmark/runs/${runId}`, { cache: 'no-store' });
    if (!res.ok) return;
    const data = await res.json();
    setActiveRun(data.run ?? null);
  }, [runId]);

  useEffect(() => {
    refreshRuns().catch(() => null);
  }, [refreshRuns]);

  useEffect(() => {
    fetch('/api/integrations/status', { cache: 'no-store' })
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (data) setIntegrationStatus(data as IntegrationStatus);
      })
      .catch(() => null);
  }, []);

  useEffect(() => {
    if (!integrationStatus) return;
    if (
      !integrationStatus.integrations.truefoundry.configured &&
      modelRoute.startsWith('truefoundry')
    ) {
      setModelRoute('direct-openai');
    }
  }, [integrationStatus, modelRoute]);

  useEffect(() => {
    if (!runId) return;
    const t = setInterval(() => {
      refreshActiveRun().catch(() => null);
      refreshRuns().catch(() => null);
    }, 1200);
    return () => clearInterval(t);
  }, [runId, refreshActiveRun, refreshRuns]);

  const startDemo = useCallback(async () => {
    const res = await fetch('/api/benchmark/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scenario_id: scenario }),
    });
    if (!res.ok) return;
    const data = await res.json();
    const nextRun = data.run as BenchmarkRun;
    setRunId(nextRun.run_id);
    setActiveRun(nextRun);
    setPhase('cold');
    refreshRuns().catch(() => null);
  }, [scenario, refreshRuns]);

  const reset = useCallback(async () => {
    await fetch('/api/benchmark/reset', { method: 'POST' });
    setRunId(null);
    setActiveRun(null);
    setPhase('idle');
    setReplayIndex(0);
    setReplayPlaying(false);
    refreshRuns().catch(() => null);
  }, [refreshRuns]);

  const loadBackup = useCallback(async () => {
    const res = await fetch('/api/benchmark/backup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scenario_id: scenario }),
    });
    if (!res.ok) return;
    const data = await res.json();
    const nextRun = data.run as BenchmarkRun;
    setRunId(nextRun.run_id);
    setActiveRun(nextRun);
    setPhase('done');
    setReplayIndex(0);
    setReplayPlaying(true);
    refreshRuns().catch(() => null);
  }, [scenario, refreshRuns]);

  const isBackupReplay = activeRun?.source === 'backup';

  const timelineEvents = useMemo(() => {
    if (!activeRun) return [] as BenchmarkEvent[];
    return [...(activeRun.cold?.events ?? []), ...(activeRun.memory?.events ?? [])].sort((a, b) =>
      a.timestamp > b.timestamp ? 1 : -1
    );
  }, [activeRun]);

  useEffect(() => {
    if (!isBackupReplay || !replayPlaying || timelineEvents.length === 0) return;
    if (replayIndex >= timelineEvents.length) {
      setReplayPlaying(false);
      return;
    }

    const t = window.setInterval(() => {
      setReplayIndex((prev) => {
        if (prev >= timelineEvents.length) return prev;
        return prev + 1;
      });
    }, 550);

    return () => window.clearInterval(t);
  }, [isBackupReplay, replayPlaying, replayIndex, timelineEvents.length]);

  const displayedRun = useMemo(() => {
    if (!activeRun) return null;
    if (!isBackupReplay) return activeRun;

    const revealed = timelineEvents.slice(0, replayIndex);
    const coldEvents = revealed.filter((event) => event.data.mode === 'cold');
    const memoryEvents = revealed.filter((event) => event.data.mode === 'full');
    const cold = rebuildSession(activeRun.cold, coldEvents);
    const memory = rebuildSession(activeRun.memory, memoryEvents);
    const coldTokens = (cold?.stats.input_tokens ?? 0) + (cold?.stats.output_tokens ?? 0);
    const memTokens = (memory?.stats.input_tokens ?? 0) + (memory?.stats.output_tokens ?? 0);
    const tokenSavingsPct = coldTokens > 0 ? ((coldTokens - memTokens) / coldTokens) * 100 : 0;
    const toolCallDelta = (cold?.stats.tool_calls ?? 0) - (memory?.stats.tool_calls ?? 0);
    const avoidedDeadEnd =
      (cold?.steps ?? []).includes('factory_reset_router') &&
      !(memory?.steps ?? []).includes('factory_reset_router');
    const totalCostUsd = Number(
      ((cold?.stats.estimated_cost_usd ?? 0) + (memory?.stats.estimated_cost_usd ?? 0)).toFixed(4)
    );

    return {
      ...activeRun,
      cold,
      memory,
      summary: {
        token_savings_pct: Number(tokenSavingsPct.toFixed(1)),
        tool_call_delta: toolCallDelta,
        avoided_dead_end: avoidedDeadEnd,
        total_cost_usd: totalCostUsd,
      },
      status:
        cold?.status === 'complete' &&
        memory?.status === 'complete' &&
        replayIndex >= timelineEvents.length
          ? ('complete' as const)
          : ('running' as const),
    };
  }, [activeRun, isBackupReplay, replayIndex, timelineEvents]);

  const allEvents = useMemo(() => {
    if (!displayedRun) return [] as BenchmarkEvent[];
    return [...(displayedRun.cold?.events ?? []), ...(displayedRun.memory?.events ?? [])].sort(
      (a, b) => (a.timestamp < b.timestamp ? 1 : -1)
    );
  }, [displayedRun]);

  const aggregate = useMemo(() => aggregateFromRuns(runs), [runs]);

  const deadEnd = displayedRun?.summary?.avoided_dead_end ? 'Yes' : 'No';
  const coldTokens =
    (displayedRun?.cold?.stats.input_tokens ?? 0) + (displayedRun?.cold?.stats.output_tokens ?? 0);
  const memTokens =
    (displayedRun?.memory?.stats.input_tokens ?? 0) +
    (displayedRun?.memory?.stats.output_tokens ?? 0);
  const tokenDelta = coldTokens - memTokens;
  const coldCost = displayedRun?.cold?.stats.estimated_cost_usd ?? 0;
  const memCost = displayedRun?.memory?.stats.estimated_cost_usd ?? 0;
  const coldDuration = displayedRun?.cold?.stats.duration_ms ?? 0;
  const memDuration = displayedRun?.memory?.stats.duration_ms ?? 0;
  const coldToolCalls = displayedRun?.cold?.stats.tool_calls ?? 0;
  const memToolCalls = displayedRun?.memory?.stats.tool_calls ?? 0;
  const tokenDropPct = pctDrop(coldTokens, memTokens);
  const costDropPct = pctDrop(coldCost, memCost);
  const timeDropPct = pctDrop(coldDuration, memDuration);
  const toolDropPct = pctDrop(coldToolCalls, memToolCalls);
  const coldComplete = displayedRun?.cold?.status === 'complete';
  const memoryRunning = phase === 'memory' || phase === 'done';
  const replayProgress =
    isBackupReplay && timelineEvents.length > 0
      ? Math.min(100, Math.round((replayIndex / timelineEvents.length) * 100))
      : 0;
  const coldCurrentTool =
    [...(displayedRun?.cold?.events ?? [])].reverse().find((event) => event.type === 'tool_call')
      ?.data.tool ?? null;
  const memoryCurrentTool =
    [...(displayedRun?.memory?.events ?? [])].reverse().find((event) => event.type === 'tool_call')
      ?.data.tool ?? null;
  const coldSteps = useMemo(() => displayedRun?.cold?.steps ?? [], [displayedRun?.cold?.steps]);
  const memorySteps = useMemo(
    () => displayedRun?.memory?.steps ?? [],
    [displayedRun?.memory?.steps]
  );
  const divergence = useMemo(
    () => firstDivergence(coldSteps, memorySteps),
    [coldSteps, memorySteps]
  );
  const compactEvents = allEvents.slice(0, 14);

  return (
    <div className="memorable-page">
      <div className="mem-grid-bg" aria-hidden="true" />
      <div className="mem-demo">
        <header>
          <p className="mem-section-label">LIVE BENCHMARK</p>
          <h1 className="mem-demo-title">Cold vs Memorable</h1>
          <p className="mem-demo-sub">
            Cold run must finish first. Then memory run starts on the same prompt and shows the
            delta in tokens, cost, duration, and tool path complexity.
          </p>

          <div className="mem-phase-track" aria-label="Run phases">
            <div
              className={`mem-phase-step ${
                phase === 'cold' || phase === 'memory' || phase === 'done' ? 'is-done' : ''
              }`}
            >
              <span>1</span>
              <strong>Run cold baseline</strong>
            </div>
            <div className={`mem-phase-step ${coldComplete ? 'is-done' : ''}`}>
              <span>2</span>
              <strong>Finish cold session</strong>
            </div>
            <div className={`mem-phase-step ${memoryRunning ? 'is-live' : ''}`}>
              <span>3</span>
              <strong>Run memory session</strong>
            </div>
          </div>

          <div className="mem-toolbar">
            <button type="button" onClick={startDemo} className="mem-btn">
              Run live: cold → memorable
            </button>
            <button type="button" onClick={loadBackup} className="mem-btn-outline">
              Play realtime traces
            </button>
            <button type="button" onClick={reset} className="mem-btn-outline">
              Reset
            </button>
            <Link href="/" className="mem-btn-outline">
              ← Landing
            </Link>
            <span className="mem-badge">run: {runId ?? 'none'}</span>
            <span className="mem-badge">phase: {phase}</span>
            {isBackupReplay && <span className="mem-badge">replay: {replayProgress}%</span>}
          </div>

          <div className="mem-inline-controls">
            <select
              className="mem-select"
              value={scenario}
              onChange={(e) => setScenario(e.target.value as BenchmarkScenario)}
            >
              {(Object.keys(SCENARIOS) as BenchmarkScenario[]).map((id) => (
                <option key={id} value={id}>
                  {SCENARIOS[id].label}
                </option>
              ))}
            </select>
            <select
              className="mem-select"
              value={modelRoute}
              onChange={(e) => setModelRoute(e.target.value)}
            >
              <option
                value="truefoundry-openai"
                disabled={!integrationStatus?.integrations.truefoundry.configured}
              >
                TrueFoundry → OpenAI
                {!integrationStatus?.integrations.truefoundry.configured ? ' (configure env)' : ''}
              </option>
              <option
                value="truefoundry-minimax"
                disabled={!integrationStatus?.integrations.truefoundry.configured}
              >
                TrueFoundry → MiniMax
                {!integrationStatus?.integrations.truefoundry.configured ? ' (configure env)' : ''}
              </option>
              <option value="direct-openai">Direct OpenAI</option>
            </select>
          </div>
        </header>

        <section className="mem-verdict mem-big-verdict">
          <div className="mem-panel mem-kpi mem-kpi-good">
            <p className="kpi-label">Tokens saved</p>
            <p className="kpi-value">-{Math.max(0, tokenDelta).toLocaleString()}</p>
            <p className="kpi-meta">{tokenDropPct.toFixed(1)}% lower than cold</p>
          </div>
          <div className="mem-panel mem-kpi mem-kpi-good">
            <p className="kpi-label">Cost saved</p>
            <p className="kpi-value">{fmtUsd(Math.max(0, coldCost - memCost))}</p>
            <p className="kpi-meta">{costDropPct.toFixed(1)}% lower than cold</p>
          </div>
          <div className="mem-panel mem-kpi mem-kpi-good">
            <p className="kpi-label">Duration saved</p>
            <p className="kpi-value">-{fmtMs(Math.max(0, coldDuration - memDuration))}</p>
            <p className="kpi-meta">{timeDropPct.toFixed(1)}% faster than cold</p>
          </div>
          <div className="mem-panel mem-kpi mem-kpi-good">
            <p className="kpi-label">Tool calls reduced</p>
            <p className="kpi-value">{Math.max(0, coldToolCalls - memToolCalls)} fewer</p>
            <p className="kpi-meta">{toolDropPct.toFixed(1)}% fewer calls</p>
          </div>
        </section>

        <section className="mem-session-grid">
          <SessionPanel
            mode="cold"
            runId={runId}
            scenario={scenario}
            modelRoute={modelRoute}
            session={displayedRun?.cold}
            enabled={!isBackupReplay && phase === 'cold'}
            replayOnly={isBackupReplay}
            currentTool={typeof coldCurrentTool === 'string' ? coldCurrentTool : null}
            onFinish={() => setPhase('memory')}
          />
          <SessionPanel
            mode="full"
            runId={runId}
            scenario={scenario}
            modelRoute={modelRoute}
            session={displayedRun?.memory}
            enabled={
              !isBackupReplay &&
              (phase === 'memory' || phase === 'done') &&
              displayedRun?.cold?.status === 'complete'
            }
            replayOnly={isBackupReplay}
            currentTool={typeof memoryCurrentTool === 'string' ? memoryCurrentTool : null}
            onFinish={() => setPhase('done')}
          />
        </section>

        <section className="mem-panel mem-diff">
          <div className="mem-diff-head">
            <p className="mem-section-label">WHY MEMORABLE IS BETTER</p>
            <p className="mem-diff-summary">
              {displayedRun?.cold?.status === 'complete' &&
              displayedRun?.memory?.status === 'complete'
                ? `Cold used ${coldSteps.length} steps, ${coldTokens.toLocaleString()} tokens, ${fmtMs(
                    displayedRun.cold.stats.duration_ms
                  )}. Memorable used ${memorySteps.length} steps, ${memTokens.toLocaleString()} tokens, ${fmtMs(
                    displayedRun.memory.stats.duration_ms
                  )}.`
                : 'Run cold and then memory to see direct speed and token gains.'}
            </p>
            {divergence && (
              <p className="mem-diff-summary">
                First behavior split happened at step {divergence.index + 1}:{' '}
                <strong>{humanizeToolName(divergence.cold ?? 'none')}</strong> vs{' '}
                <strong>{humanizeToolName(divergence.memory ?? 'none')}</strong>.
              </p>
            )}
            <div className="mem-diff-pills">
              <span className="mem-pill active">-{Math.max(0, tokenDelta)} tokens</span>
              <span className="mem-pill active">
                -{Math.max(0, coldSteps.length - memorySteps.length)} steps
              </span>
              <span className="mem-pill active">
                -
                {fmtMs(
                  Math.max(
                    0,
                    (displayedRun?.cold?.stats.duration_ms ?? 0) -
                      (displayedRun?.memory?.stats.duration_ms ?? 0)
                  )
                )}
              </span>
            </div>
          </div>
        </section>

        <WorkflowGraph
          coldSteps={coldSteps}
          memorySteps={memorySteps}
          divergenceIndex={divergence?.index ?? null}
        />

        <section className="mem-analytics">
          <article className="mem-panel" style={{ padding: '12px' }}>
            <p className="mem-section-label">Completed pairs</p>
            <p className="metric-value">{aggregate.runs}</p>
          </article>
          <article className="mem-panel" style={{ padding: '12px' }}>
            <p className="mem-section-label">Average savings</p>
            <p className="metric-value">{aggregate.avgTokenSavingsPct.toFixed(1)}%</p>
          </article>
          <article className="mem-panel" style={{ padding: '12px' }}>
            <p className="mem-section-label">Dead-end avoided</p>
            <p className="metric-value">{deadEnd}</p>
          </article>
          <article className="mem-panel" style={{ padding: '12px' }}>
            <p className="mem-section-label">Scenario prompt</p>
            <p style={{ marginTop: 6, fontSize: '0.84rem', lineHeight: 1.45 }}>
              {SCENARIOS[scenario].prompt}
            </p>
          </article>
        </section>

        <section className="mem-panel mem-log">
          <div className="mem-log-head">
            <div>
              <p className="mem-section-label">Session Log</p>
              <h3 style={{ margin: '4px 0 0', fontFamily: 'var(--mem-serif)', fontSize: '2rem' }}>
                Model + memory events
              </h3>
              <p style={{ marginTop: 4, color: 'var(--mem-muted)', fontSize: '0.78rem' }}>
                {allEvents.length} events
              </p>
              {isBackupReplay && (
                <p style={{ marginTop: 4, color: 'var(--mem-purple)', fontSize: '0.78rem' }}>
                  Playing realtime traces in timeline order ({replayProgress}%)
                </p>
              )}
            </div>
            <div className="mem-log-filters" />
          </div>

          <div className="mem-log-list">
            {compactEvents.length === 0 ? (
              <p style={{ color: 'var(--mem-muted)', fontSize: '0.78rem' }}>
                Run the benchmark to capture trace evidence.
              </p>
            ) : (
              compactEvents.map((event, i) => (
                <div
                  className={`mem-log-row ${
                    divergence &&
                    event.type === 'tool_call' &&
                    ((event.data.mode === 'cold' && event.data.tool === divergence.cold) ||
                      (event.data.mode === 'full' && event.data.tool === divergence.memory))
                      ? 'is-divergence'
                      : ''
                  }`}
                  key={`${event.timestamp}-${i}`}
                >
                  <span style={{ color: 'var(--mem-muted)' }}>{shortTs(event.timestamp)}</span>
                  <span>{event.type}</span>
                  <span>{detailForEvent(event)}</span>
                </div>
              ))
            )}
          </div>
        </section>
      </div>
    </div>
  );
}
