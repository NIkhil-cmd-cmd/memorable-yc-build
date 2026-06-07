export type BenchmarkMode = 'cold' | 'full';

export type BenchmarkScenario = 'internet_dropout' | 'billing_dispute' | 'phone_service_issue';

export type BenchmarkEventType =
  | 'session_start'
  | 'model_turn'
  | 'recall'
  | 'tool_call'
  | 'tool_blocked'
  | 'session_end'
  | 'benchmark_summary';

export type BenchmarkEventData = {
  run_id?: string;
  session_id?: string;
  mode?: BenchmarkMode;
  scenario_id?: BenchmarkScenario;
  user_text?: string;
  tool?: string;
  outcome?: 'success' | 'failure';
  summary?: string;
  steps?: string[];
  layer?: string;
  layers_active?: string[];
  next_action?: string | null;
  elapsed_ms?: number;
  latency_ms?: number;
  input_tokens?: number;
  output_tokens?: number;
  estimated_cost_usd?: number;
  [key: string]: unknown;
};

export type BenchmarkEvent = {
  type: BenchmarkEventType | string;
  timestamp: string;
  data: BenchmarkEventData;
};

export type SessionStats = {
  model_calls: number;
  tool_calls: number;
  recall_events: number;
  input_tokens: number;
  output_tokens: number;
  estimated_cost_usd: number;
  duration_ms: number;
};

export type SessionTrace = {
  session_id: string;
  mode: BenchmarkMode;
  scenario_id: BenchmarkScenario;
  status: 'running' | 'complete';
  started_at: string;
  ended_at?: string;
  events: BenchmarkEvent[];
  steps: string[];
  stats: SessionStats;
};

export type BenchmarkRun = {
  run_id: string;
  source: 'live' | 'backup';
  status: 'running' | 'complete';
  scenario_id: BenchmarkScenario;
  created_at: string;
  updated_at: string;
  cold?: SessionTrace;
  memory?: SessionTrace;
  summary?: {
    token_savings_pct: number;
    tool_call_delta: number;
    avoided_dead_end: boolean;
    total_cost_usd: number;
  };
};
