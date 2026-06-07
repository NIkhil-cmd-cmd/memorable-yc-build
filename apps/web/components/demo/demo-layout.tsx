'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import {
  type SimulationLinkDatum,
  type SimulationNodeDatum,
  forceCenter,
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
} from 'd3-force';
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

const SCENARIOS: Record<
  BenchmarkScenario,
  { label: string; prompt: string; coldPrompt: string; memoryPrompt: string }
> = {
  flight_rebooking: {
    label: 'Flight Rebooking During Delay',
    prompt: 'My flight got canceled, I need to get to SF tonight.',
    coldPrompt: 'My flight got canceled, I need to get to SF tonight.',
    memoryPrompt: 'Rebook my flight to San Jose tonight.',
  },
};

const MEMORY_TOOL_ALLOWLIST: Record<BenchmarkScenario, string[]> = {
  flight_rebooking: [
    'check_waiver_status',
    'search_basic_fares',
    'search_partner_flights',
    'apply_same_day_policy',
    'auto_rebook_and_issue_voucher',
  ],
};

const MOSS_REFERENCE_LABELS: Record<BenchmarkScenario, string[]> = {
  flight_rebooking: [
    'airline_irrops_waiver_policy',
    'partner_inventory_matrix',
    'restricted_fare_dead_end_patterns',
    'same_day_rebooking_playbook',
  ],
};

const STATE_FOR_TOOL: Record<string, string> = {
  ask_departure_time_again: 'trip constraints',
  ask_budget_again: 'fare constraints',
  search_basic_fares: 'fare candidate set',
  choose_late_connection: 'suboptimal route branch',
  retry_booking_failed_fare_class: 'restricted fare dead-end',
  price_recheck_restricted_fare: 'fare rules conflict',
  check_waiver_status: 'waiver eligibility',
  search_partner_flights: 'partner inventory candidates',
  apply_same_day_policy: 'policy-adjusted itinerary',
  auto_rebook_and_issue_voucher: 'rebook confirmed',
  pull_account_billing: 'billing account context',
  detect_duplicate_charge: 'duplicate charge candidate',
  apply_bill_credit: 'credit applied',
  check_outage_map: 'regional outage state',
  reset_apn_settings: 'network config reset',
  reboot_modem: 'connection restored',
  escalate_manual_ticketing: 'manual operations queue',
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
    const refs = Array.isArray(event.data.moss_refs)
      ? (event.data.moss_refs as string[]).slice(0, 2).join(', ')
      : '';
    return refs ? `${layer}${action} [moss: ${refs}]` : `${layer}${action}`;
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

const DEAD_END_TOOLS = new Set([
  'retry_booking_failed_fare_class',
  'choose_late_connection',
  'escalate_manual_ticketing',
]);

function hasDeadEnd(steps: string[]) {
  return steps.some((step) => DEAD_END_TOOLS.has(step));
}

function toolCallsWithOutcome(session: BenchmarkRun['cold'] | BenchmarkRun['memory']) {
  if (!session) return [] as { tool: string; outcome: string }[];
  return (session.events ?? [])
    .filter((event) => event.type === 'tool_call' && typeof event.data.tool === 'string')
    .map((event) => ({
      tool: String(event.data.tool),
      outcome: String(event.data.outcome ?? 'success'),
    }));
}

function WorkflowGraph({
  coldSteps,
  memorySteps,
  divergenceIndex,
  coldCalls,
  phase,
  coldCurrentTool,
  memoryCurrentTool,
}: {
  coldSteps: string[];
  memorySteps: string[];
  divergenceIndex: number | null;
  coldCalls: { tool: string; outcome: string }[];
  phase: 'idle' | 'cold' | 'memory' | 'done';
  coldCurrentTool: string | null;
  memoryCurrentTool: string | null;
}) {
  const viewW = 1320;
  const viewH = 660;
  const edgeId = (source: string, target: string, tool: string) => `${source}->${target}::${tool}`;

  type StateNode = {
    id: string;
    label: string;
    visitCount: number;
    replayScore: number;
    coldVisited: boolean;
    memoryVisited: boolean;
    deadEnd: boolean;
    degree: number;
  };

  type ToolEdge = {
    id: string;
    source: string;
    target: string;
    tool: string;
    frequency: number;
    selectedByMemory: boolean;
    coldSeen: boolean;
    memorySeen: boolean;
    deadEnd: boolean;
    coldOrders: number[];
    memoryOrders: number[];
  };

  type SimNode = StateNode &
    SimulationNodeDatum & {
      radius: number;
      fx?: number;
      fy?: number;
    };
  type SimLink = SimulationLinkDatum<SimNode> & {
    source: string | SimNode;
    target: string | SimNode;
    strength: number;
  };

  const coldCurrentIndex = coldCurrentTool ? coldSteps.lastIndexOf(coldCurrentTool) : -1;
  const memoryCurrentIndex = memoryCurrentTool ? memorySteps.lastIndexOf(memoryCurrentTool) : -1;
  const coldProgress =
    phase === 'idle' ? -1 : phase === 'cold' ? coldCurrentIndex : coldSteps.length - 1;
  const memoryProgress =
    phase === 'done' ? memorySteps.length - 1 : phase === 'memory' ? memoryCurrentIndex : -1;

  const { nodes, edges } = useMemo(() => {
    const failedByColdOrder = new Set<number>();
    coldCalls.forEach((call, idx) => {
      if (call.outcome === 'failure') failedByColdOrder.add(idx);
    });
    const memoryRankByTool = new Map<string, number>();
    memorySteps.forEach((tool, idx) => {
      const score = 1 - (idx / Math.max(memorySteps.length, 1)) * 0.42;
      memoryRankByTool.set(tool, Math.max(memoryRankByTool.get(tool) ?? 0, score));
    });

    const nodeVisits = new Map<string, number>();
    const coldNodeSet = new Set<string>();
    const memoryNodeSet = new Set<string>();
    const deadEndNodeSet = new Set<string>();
    const edgeMap = new Map<string, ToolEdge>();

    const stateId = (label: string) => label.toLowerCase().replace(/[^a-z0-9]+/g, '_');

    const addTransition = (
      fromLabel: string,
      toLabel: string,
      tool: string,
      mode: 'cold' | 'memory',
      order: number,
      isDeadEnd: boolean
    ) => {
      const from = stateId(fromLabel);
      const to = stateId(toLabel);
      const id = edgeId(from, to, tool);
      const prev = edgeMap.get(id);
      edgeMap.set(id, {
        id,
        source: from,
        target: to,
        tool,
        frequency: (prev?.frequency ?? 0) + 1,
        selectedByMemory: (prev?.selectedByMemory ?? false) || mode === 'memory',
        coldSeen: (prev?.coldSeen ?? false) || mode === 'cold',
        memorySeen: (prev?.memorySeen ?? false) || mode === 'memory',
        deadEnd: (prev?.deadEnd ?? false) || isDeadEnd,
        coldOrders:
          mode === 'cold' ? [...(prev?.coldOrders ?? []), order] : (prev?.coldOrders ?? []),
        memoryOrders:
          mode === 'memory' ? [...(prev?.memoryOrders ?? []), order] : (prev?.memoryOrders ?? []),
      });
      nodeVisits.set(from, (nodeVisits.get(from) ?? 0) + 1);
      nodeVisits.set(to, (nodeVisits.get(to) ?? 0) + 1);
      if (mode === 'cold') {
        coldNodeSet.add(from);
        coldNodeSet.add(to);
      } else {
        memoryNodeSet.add(from);
        memoryNodeSet.add(to);
      }
      if (isDeadEnd) deadEndNodeSet.add(to);
    };

    const buildPath = (steps: string[], mode: 'cold' | 'memory') => {
      let currentState = 'incoming request';
      for (let i = 0; i < steps.length; i += 1) {
        const tool = steps[i];
        const nextState = STATE_FOR_TOOL[tool] ?? humanizeToolName(tool);
        const deadEnd = mode === 'cold' ? failedByColdOrder.has(i) : false;
        addTransition(currentState, nextState, tool, mode, i, deadEnd);
        currentState = nextState;
      }
    };

    buildPath(coldSteps, 'cold');
    buildPath(memorySteps, 'memory');

    const degree = new Map<string, number>();
    edgeMap.forEach((edge) => {
      degree.set(edge.source, (degree.get(edge.source) ?? 0) + edge.frequency);
      degree.set(edge.target, (degree.get(edge.target) ?? 0) + edge.frequency);
    });

    const nodeLabels = new Map<string, string>();
    edgeMap.forEach((edge) => {
      nodeLabels.set(edge.source, edge.source.replace(/_/g, ' '));
      nodeLabels.set(edge.target, edge.target.replace(/_/g, ' '));
    });

    const builtNodes: StateNode[] = Array.from(nodeLabels.entries()).map(([id, fallback]) => ({
      id,
      label: fallback,
      visitCount: nodeVisits.get(id) ?? 1,
      replayScore: Math.max(
        0.2,
        ...Array.from(edgeMap.values())
          .filter((edge) => edge.source === id || edge.target === id)
          .map((edge) => memoryRankByTool.get(edge.tool) ?? 0.2)
      ),
      coldVisited: coldNodeSet.has(id),
      memoryVisited: memoryNodeSet.has(id),
      deadEnd: deadEndNodeSet.has(id),
      degree: degree.get(id) ?? 1,
    }));

    return { nodes: builtNodes, edges: Array.from(edgeMap.values()) };
  }, [coldCalls, coldSteps, memorySteps]);

  const positionedNodes = useMemo(() => {
    const maxVisit = Math.max(1, ...nodes.map((n) => n.visitCount));
    const simNodes: SimNode[] = nodes.map((node, idx) => ({
      ...node,
      x: viewW * 0.5 + Math.cos(idx) * 120,
      y: viewH * 0.5 + Math.sin(idx) * 120,
      vx: 0,
      vy: 0,
      radius: 14 + (node.visitCount / maxVisit) * 13,
    }));
    const byDegree = [...simNodes].sort((a, b) => b.degree - a.degree);
    if (byDegree[0]) {
      byDegree[0].fx = viewW * 0.5;
      byDegree[0].fy = viewH * 0.5;
    }
    if (byDegree[1]) {
      byDegree[1].fx = viewW * 0.44;
      byDegree[1].fy = viewH * 0.46;
    }
    if (byDegree[2]) {
      byDegree[2].fx = viewW * 0.56;
      byDegree[2].fy = viewH * 0.44;
    }

    const simLinks: SimLink[] = edges.map((edge) => ({
      source: edge.source,
      target: edge.target,
      strength: edge.memorySeen ? 0.24 : edge.coldSeen ? 0.15 : 0.1,
    }));

    const simulation = forceSimulation(simNodes)
      .force(
        'link',
        forceLink<SimNode, SimLink>(simLinks)
          .id((n) => n.id)
          .distance((link) => (link.strength > 0.2 ? 190 : 240))
          .strength((link) => link.strength)
      )
      .force('charge', forceManyBody().strength(-780))
      .force('center', forceCenter(viewW / 2, viewH / 2))
      .force(
        'collide',
        forceCollide<SimNode>()
          .radius((n) => n.radius + 30)
          .strength(0.98)
      )
      .stop();

    for (let i = 0; i < 320; i += 1) simulation.tick();
    simulation.stop();

    return simNodes.map((node) => ({
      ...node,
      x: Math.max(92, Math.min(viewW - 92, Number(node.x ?? viewW / 2))),
      y: Math.max(110, Math.min(viewH - 90, Number(node.y ?? viewH / 2))),
    }));
  }, [edges, nodes]);

  const nodeMap = useMemo(
    () => new Map(positionedNodes.map((node) => [node.id, node])),
    [positionedNodes]
  );

  const memoryPathD = useMemo(() => {
    const ordered = edges
      .filter((edge) => edge.memoryOrders.length > 0)
      .sort((a, b) => Math.min(...a.memoryOrders) - Math.min(...b.memoryOrders));
    const points: { x: number; y: number }[] = [];
    ordered.forEach((edge) => {
      const source = nodeMap.get(edge.source);
      const target = nodeMap.get(edge.target);
      if (!source || !target) return;
      if (points.length === 0) points.push({ x: source.x, y: source.y });
      points.push({ x: target.x, y: target.y });
    });
    return points.map((p, idx) => `${idx === 0 ? 'M' : 'L'} ${p.x} ${p.y}`).join(' ');
  }, [edges, nodeMap]);

  return (
    <section className="mem-panel mem-workflow-graph">
      <div className="mem-graph-head">
        <p className="mem-section-label">Shared Workflow Graph</p>
      </div>
      <svg viewBox={`0 0 ${viewW} ${viewH}`} className="mem-graph-svg" aria-hidden>
        <defs>
          <path id="mem-live-path" d={memoryPathD || 'M 0 0'} />
          <filter id="mem-node-halo">
            <feGaussianBlur stdDeviation="4" result="blur" />
            <feMerge>
              <feMergeNode in="blur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>
        {edges.map((edge) => {
          const source = nodeMap.get(edge.source);
          const target = nodeMap.get(edge.target);
          if (!source || !target) return null;
          const coldVisible =
            edge.coldOrders.length > 0 &&
            coldProgress >= 0 &&
            Math.min(...edge.coldOrders) <= coldProgress;
          const memoryVisible =
            edge.memoryOrders.length > 0 &&
            memoryProgress >= 0 &&
            Math.min(...edge.memoryOrders) <= memoryProgress;
          const visible = coldVisible || memoryVisible;
          const isDivergenceEdge =
            divergenceIndex !== null && edge.coldOrders.some((i) => i >= divergenceIndex);
          const midX = (source.x + target.x) / 2;
          const midY = (source.y + target.y) / 2;
          const edgeLabel = `${humanizeToolName(edge.tool)}()${edge.deadEnd ? ' ✕' : ''}`;
          const showEdgeLabel = visible && (edge.deadEnd || edge.memorySeen);
          return (
            <g key={edge.id}>
              <line
                x1={source.x}
                y1={source.y}
                x2={target.x}
                y2={target.y}
                className={`mem-graph-edge ${
                  edge.deadEnd
                    ? 'is-dead-end'
                    : edge.selectedByMemory
                      ? 'is-memory'
                      : edge.coldSeen
                        ? 'is-cold'
                        : 'is-neutral'
                } ${memoryVisible ? 'is-replay-live' : ''} ${isDivergenceEdge ? 'is-divergence' : ''} ${
                  visible ? 'is-visible' : ''
                }`}
                style={{
                  strokeWidth: 1.2 + Math.min(4.2, edge.frequency * 1.1),
                  opacity: visible ? undefined : 0.14,
                }}
              />
              {showEdgeLabel && (
                <text
                  className={`mem-graph-edge-label ${edge.deadEnd ? 'is-dead-end' : ''} ${memoryVisible ? 'is-memory' : ''}`}
                  x={midX}
                  y={midY - 8}
                  textAnchor="middle"
                >
                  {edgeLabel}
                </text>
              )}
            </g>
          );
        })}

        {positionedNodes.map((node) => {
          const coldSeen = node.coldVisited;
          const memorySeen = node.memoryVisited;
          const activeCold =
            phase === 'cold' &&
            edges.some((e) => e.tool === coldCurrentTool && e.target === node.id);
          const activeMemory =
            (phase === 'memory' || phase === 'done') &&
            edges.some((e) => e.tool === memoryCurrentTool && e.target === node.id);
          const replayGlow = memorySeen ? 0.3 + node.replayScore * 0.7 : 0;
          return (
            <g key={node.id} transform={`translate(${node.x}, ${node.y})`}>
              {memorySeen && (
                <circle
                  r={node.radius + 7 + node.replayScore * 8}
                  className="mem-graph-node-halo"
                  style={{ opacity: replayGlow * (phase === 'cold' ? 0.28 : 0.56) }}
                  filter="url(#mem-node-halo)"
                />
              )}
              <circle
                r={node.radius}
                className={`mem-graph-node ${
                  node.deadEnd
                    ? 'is-dead-end'
                    : memorySeen
                      ? 'is-memory'
                      : coldSeen
                        ? 'is-cold'
                        : 'is-neutral'
                } ${activeCold || activeMemory ? 'is-active' : ''}`}
                style={{ strokeWidth: 1.3 + node.replayScore * 2.4 }}
              />
              <text className="mem-graph-label" textAnchor="middle" y={4}>
                {node.label.length > 14 ? `${node.label.slice(0, 12)}..` : node.label}
              </text>
              {memorySeen && (
                <text className="mem-graph-score" textAnchor="middle" y={node.radius + 16}>
                  {`score ${node.replayScore.toFixed(2)}`}
                </text>
              )}
              {node.deadEnd && (
                <text className="mem-graph-dead-mark" textAnchor="middle" y={-node.radius - 10}>
                  dead end
                </text>
              )}
            </g>
          );
        })}

        {phase !== 'cold' && memoryPathD && memorySteps.length > 1 && (
          <circle r="6.8" className="mem-graph-travel-dot">
            <animateMotion dur="2.3s" repeatCount="indefinite">
              <mpath href="#mem-live-path" />
            </animateMotion>
          </circle>
        )}
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
  coldCompleteForGate,
  autoStart,
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
  coldCompleteForGate?: boolean;
  autoStart?: boolean;
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
  const autoStartedRef = useRef(false);
  const lastRunIdRef = useRef<string | null>(null);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const tools = session?.steps ?? [];

  const panelTitle = mode === 'cold' ? 'Cold Session Agent A' : 'Memorable Session Agent B';
  const panelHint = mode === 'cold' ? 'No shared memory.' : 'Shared memory active.';
  const memoryLocked =
    mode === 'full' &&
    !!runId &&
    ((!replayOnly && !enabled) || (replayOnly && !coldCompleteForGate));
  const promptText =
    mode === 'cold' ? SCENARIOS[scenario].coldPrompt : SCENARIOS[scenario].memoryPrompt;
  const toolTimeline = toolCallsWithOutcome(session);
  const allowedMemoryTools = MEMORY_TOOL_ALLOWLIST[scenario];
  const unexpectedMemoryCalls =
    mode === 'full' ? toolTimeline.filter((row) => !allowedMemoryTools.includes(row.tool)) : [];
  const filteredMemoryCalls =
    mode === 'full'
      ? toolTimeline.filter((row) => allowedMemoryTools.includes(row.tool))
      : toolTimeline;
  const toolRows =
    filteredMemoryCalls.length > 0
      ? filteredMemoryCalls
      : tools.map((tool) => ({ tool, outcome: mode === 'cold' ? 'failure' : 'success' }));

  useEffect(() => {
    if (runId !== lastRunIdRef.current) {
      autoStartedRef.current = false;
      lastRunIdRef.current = runId;
      setConnectionError(null);
      setConnected(false);
    }
  }, [runId]);

  useEffect(() => {
    if (sessionHook.isConnected) {
      setConnected(true);
      setConnectionError(null);
    }
  }, [sessionHook.isConnected]);

  const connectSession = useCallback(async () => {
    try {
      setConnectionError(null);
      await sessionHook.start();
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to connect';
      setConnectionError(message);
    }
  }, [sessionHook]);

  useEffect(() => {
    if (!runId) {
      autoStartedRef.current = false;
      return;
    }
    if (!autoStart || replayOnly || !enabled || autoStartedRef.current) return;
    autoStartedRef.current = true;
    connectSession().catch(() => null);
  }, [autoStart, connectSession, enabled, replayOnly, runId]);

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
              <p className="mem-section-label">
                {replayOnly ? 'Waiting for cold trace' : 'Memory session locked'}
              </p>
              <p className="mem-live-prompt">“{promptText}”</p>
            </div>
          ) : runId && !replayOnly ? (
            <div className="mem-live-stack">
              <p className="mem-live-label">Live voice scenario</p>
              <p className="mem-live-prompt">“{promptText}”</p>
              {mode === 'full' && (
                <p className="mem-live-source">
                  Moss refs: {MOSS_REFERENCE_LABELS[scenario].join(' · ')}
                </p>
              )}
              <AgentAudioVisualizerBar />
              <AgentChatTranscript className="mem-live-transcript" />
              <AgentControlBar
                controls={{
                  microphone: true,
                  leave: true,
                  chat: true,
                }}
                isChatOpen
              />
              {!connected && (
                <button
                  type="button"
                  onClick={() => connectSession()}
                  className={mode === 'cold' ? 'mem-btn-cold' : 'mem-btn-memory'}
                >
                  Connect call
                </button>
              )}
              {connectionError && (
                <p className="mem-tools-empty" style={{ color: '#8f3b2f' }}>
                  {connectionError}
                </p>
              )}
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
                  “{promptText}”
                </p>
                {mode === 'full' && (
                  <p className="mem-live-source">
                    Moss refs: {MOSS_REFERENCE_LABELS[scenario].join(' · ')}
                  </p>
                )}
                <p style={{ marginTop: 10, fontSize: '0.8rem', color: 'var(--mem-muted)' }}>
                  Realtime trace stream.
                </p>
              </div>
            </div>
          ) : (
            <p className="mem-tools-empty" />
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
          <p className="mem-section-label">Tool Trace Overlay</p>
          <p className="mem-tool-current">
            Current action: {currentTool ? humanizeToolName(currentTool) : '-'}
          </p>
          {toolRows.length === 0 ? (
            <p className="mem-tools-empty" />
          ) : (
            <p className="mem-tools-empty">
              {toolRows.length} tool calls mapped to graph edges.{' '}
              {toolRows.filter((row) => row.outcome === 'failure').length} dead-end edge
              {toolRows.filter((row) => row.outcome === 'failure').length === 1 ? '' : 's'}.
            </p>
          )}
          {mode === 'full' && unexpectedMemoryCalls.length > 0 && (
            <p className="mem-tools-empty" style={{ color: '#8f3b2f' }}>
              Blocked unexpected tool call(s):{' '}
              {unexpectedMemoryCalls.map((c) => humanizeToolName(c.tool)).join(', ')}
            </p>
          )}
        </div>

        {!replayOnly && (
          <div className="mem-session-actions">
            <button
              type="button"
              disabled={!enabled || !runId}
              onClick={() => connectSession()}
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
  const [scenario, setScenario] = useState<BenchmarkScenario>('flight_rebooking');
  const [phase, setPhase] = useState<'idle' | 'cold' | 'memory' | 'done'>('idle');
  const [runId, setRunId] = useState<string | null>(null);
  const [modelRoute, setModelRoute] = useState('truefoundry-minimax');
  const [activeRun, setActiveRun] = useState<BenchmarkRun | null>(null);
  const [integrationStatus, setIntegrationStatus] = useState<IntegrationStatus | null>(null);
  const [replayIndex, setReplayIndex] = useState(0);
  const [replayPlaying, setReplayPlaying] = useState(false);
  const isBackupReplay = activeRun?.source === 'backup';

  const refreshActiveRun = useCallback(async () => {
    if (!runId) return;
    const res = await fetch(`/api/benchmark/runs/${runId}`, { cache: 'no-store' });
    if (!res.ok) return;
    const data = await res.json();
    setActiveRun(data.run ?? null);
  }, [runId]);

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
    }, 1200);
    return () => clearInterval(t);
  }, [runId, refreshActiveRun]);

  useEffect(() => {
    if (isBackupReplay) return;
    if (phase === 'cold' && activeRun?.cold?.status === 'complete') {
      setPhase('memory');
      return;
    }
    if (phase === 'memory' && activeRun?.memory?.status === 'complete') {
      setPhase('done');
    }
  }, [activeRun?.cold?.status, activeRun?.memory?.status, isBackupReplay, phase]);

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
  }, [scenario]);

  const reset = useCallback(async () => {
    await fetch('/api/benchmark/reset', { method: 'POST' });
    setRunId(null);
    setActiveRun(null);
    setPhase('idle');
    setReplayIndex(0);
    setReplayPlaying(false);
  }, []);

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
  }, [scenario]);

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
    const avoidedDeadEnd = hasDeadEnd(cold?.steps ?? []) && !hasDeadEnd(memory?.steps ?? []);
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
  const visualPhase = isBackupReplay
    ? displayedRun?.memory?.status === 'complete'
      ? ('done' as const)
      : displayedRun?.cold?.status === 'complete'
        ? ('memory' as const)
        : ('cold' as const)
    : phase;
  const memoryRunning = visualPhase === 'memory' || visualPhase === 'done';
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
  const coldCalls = useMemo(() => toolCallsWithOutcome(displayedRun?.cold), [displayedRun?.cold]);
  const coldDeadEndCount = useMemo(
    () => coldCalls.filter((c) => c.outcome === 'failure').length,
    [coldCalls]
  );
  const estimatedDeadEndMs = coldDeadEndCount * 1200;
  const memorySteps = useMemo(
    () => displayedRun?.memory?.steps ?? [],
    [displayedRun?.memory?.steps]
  );
  const divergence = useMemo(
    () => firstDivergence(coldSteps, memorySteps),
    [coldSteps, memorySteps]
  );
  const compactEvents = allEvents.slice(0, 14);
  const currentPairComplete =
    displayedRun?.cold?.status === 'complete' && displayedRun?.memory?.status === 'complete'
      ? 1
      : 0;
  const currentSavings =
    displayedRun?.cold?.status === 'complete' && displayedRun?.memory?.status === 'complete'
      ? (displayedRun?.summary?.token_savings_pct ?? 0).toFixed(1)
      : '0.0';

  return (
    <div className="memorable-page">
      <div className="mem-grid-bg" aria-hidden="true" />
      <div className="mem-demo">
        <header>
          <h1 className="mem-demo-title">Cold vs Memorable</h1>
          <p className="mem-demo-sub">Cold first. Memory second.</p>

          <div className="mem-phase-track" aria-label="Run phases">
            <div
              className={`mem-phase-step ${
                visualPhase === 'cold' || visualPhase === 'memory' || visualPhase === 'done'
                  ? 'is-done'
                  : ''
              }`}
            >
              <span>1</span>
              <strong>Run cold</strong>
            </div>
            <div className={`mem-phase-step ${coldComplete ? 'is-done' : ''}`}>
              <span>2</span>
              <strong>Cold complete</strong>
            </div>
            <div className={`mem-phase-step ${memoryRunning ? 'is-live' : ''}`}>
              <span>3</span>
              <strong>Run memory</strong>
            </div>
          </div>

          <div className="mem-toolbar">
            <button type="button" onClick={startDemo} className="mem-btn">
              Run live: cold → memorable
            </button>
            <button type="button" onClick={loadBackup} className="mem-btn-outline">
              Run traces
            </button>
            <button type="button" onClick={reset} className="mem-btn-outline">
              Reset
            </button>
            <Link href="/" className="mem-btn-outline">
              ← Landing
            </Link>
            <span className="mem-badge">run: {runId ?? 'none'}</span>
            <span className="mem-badge">phase: {visualPhase}</span>
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
                value="truefoundry-minimax"
                disabled={!integrationStatus?.integrations.truefoundry.configured}
              >
                TrueFoundry → MiniMax
                {!integrationStatus?.integrations.truefoundry.configured ? ' (configure env)' : ''}
              </option>
              <option
                value="truefoundry-openai"
                disabled={!integrationStatus?.integrations.truefoundry.configured}
              >
                TrueFoundry → OpenAI
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
            <p className="kpi-meta">{tokenDropPct.toFixed(1)}%</p>
          </div>
          <div className="mem-panel mem-kpi mem-kpi-good">
            <p className="kpi-label">Cost saved</p>
            <p className="kpi-value">{fmtUsd(Math.max(0, coldCost - memCost))}</p>
            <p className="kpi-meta">{costDropPct.toFixed(1)}%</p>
          </div>
          <div className="mem-panel mem-kpi mem-kpi-good">
            <p className="kpi-label">Duration saved</p>
            <p className="kpi-value">-{fmtMs(Math.max(0, coldDuration - memDuration))}</p>
            <p className="kpi-meta">{timeDropPct.toFixed(1)}%</p>
          </div>
          <div className="mem-panel mem-kpi mem-kpi-good">
            <p className="kpi-label">Tool calls reduced</p>
            <p className="kpi-value">{Math.max(0, coldToolCalls - memToolCalls)} fewer</p>
            <p className="kpi-meta">{toolDropPct.toFixed(1)}%</p>
          </div>
        </section>

        <section className="mem-session-grid">
          <SessionPanel
            mode="cold"
            runId={runId}
            scenario={scenario}
            modelRoute={modelRoute}
            session={displayedRun?.cold}
            enabled={!isBackupReplay && visualPhase === 'cold'}
            replayOnly={isBackupReplay}
            autoStart={!isBackupReplay}
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
              (visualPhase === 'memory' || visualPhase === 'done') &&
              displayedRun?.cold?.status === 'complete'
            }
            replayOnly={isBackupReplay}
            coldCompleteForGate={displayedRun?.cold?.status === 'complete'}
            autoStart={!isBackupReplay && visualPhase === 'memory'}
            currentTool={typeof memoryCurrentTool === 'string' ? memoryCurrentTool : null}
            onFinish={() => setPhase('done')}
          />
        </section>

        <section className="mem-panel mem-diff">
          <div className="mem-diff-head">
            <p className="mem-section-label">DELTA</p>
            <p className="mem-diff-summary">
              {displayedRun?.cold?.status === 'complete' &&
              displayedRun?.memory?.status === 'complete'
                ? `Cold used ${coldSteps.length} steps, ${coldTokens.toLocaleString()} tokens, ${fmtMs(
                    displayedRun.cold.stats.duration_ms
                  )}. Memorable used ${memorySteps.length} steps, ${memTokens.toLocaleString()} tokens, ${fmtMs(
                    displayedRun.memory.stats.duration_ms
                  )}.`
                : 'Run cold, then memory.'}
            </p>
            {divergence && (
              <p className="mem-diff-summary">
                Split at step {divergence.index + 1}:{' '}
                <strong>{humanizeToolName(divergence.cold ?? 'none')}</strong> vs{' '}
                <strong>{humanizeToolName(divergence.memory ?? 'none')}</strong>.
              </p>
            )}
            {coldDeadEndCount > 0 && (
              <p className="mem-diff-summary">
                Cold hit <strong>{coldDeadEndCount}</strong> dead-end branch
                {coldDeadEndCount > 1 ? 'es' : ''}, adding about{' '}
                <strong>{fmtMs(estimatedDeadEndMs)}</strong>.
              </p>
            )}
            <div className="mem-diff-pills">
              <span className="mem-pill active positive">-{Math.max(0, tokenDelta)} tokens</span>
              <span className="mem-pill active positive">
                -{Math.max(0, coldSteps.length - memorySteps.length)} steps
              </span>
              <span className="mem-pill active positive">
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
          coldCalls={coldCalls}
          phase={visualPhase}
          coldCurrentTool={typeof coldCurrentTool === 'string' ? coldCurrentTool : null}
          memoryCurrentTool={typeof memoryCurrentTool === 'string' ? memoryCurrentTool : null}
        />

        <section className="mem-analytics">
          <article className="mem-panel" style={{ padding: '12px' }}>
            <p className="mem-section-label">Completed pairs</p>
            <p className="metric-value">{currentPairComplete}</p>
          </article>
          <article className="mem-panel" style={{ padding: '12px' }}>
            <p className="mem-section-label">Average savings</p>
            <p className="metric-value">{currentSavings}%</p>
          </article>
          <article className="mem-panel" style={{ padding: '12px' }}>
            <p className="mem-section-label">Dead-end avoided</p>
            <p className="metric-value">{deadEnd}</p>
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
                  Realtime traces ({replayProgress}%)
                </p>
              )}
            </div>
            <div className="mem-log-filters" />
          </div>

          <div className="mem-log-list">
            {compactEvents.length === 0 ? (
              <p style={{ color: 'var(--mem-muted)', fontSize: '0.78rem' }}>No events.</p>
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
