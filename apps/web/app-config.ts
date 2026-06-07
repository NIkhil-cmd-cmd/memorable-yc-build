export interface AppConfig {
  pageTitle: string;
  pageDescription: string;
  companyName: string;

  supportsChatInput: boolean;
  supportsVideoInput: boolean;
  supportsScreenShare: boolean;
  isPreConnectBufferEnabled: boolean;

  logo: string;
  startButtonText: string;
  accent?: string;
  logoDark?: string;
  accentDark?: string;

  audioVisualizerType?: 'bar' | 'wave' | 'grid' | 'radial' | 'aura';
  audioVisualizerColor?: `#${string}`;
  audioVisualizerColorDark?: `#${string}`;
  audioVisualizerColorShift?: number;
  audioVisualizerBarCount?: number;
  audioVisualizerGridRowCount?: number;
  audioVisualizerGridColumnCount?: number;
  audioVisualizerRadialBarCount?: number;
  audioVisualizerRadialRadius?: number;
  audioVisualizerWaveLineWidth?: number;

  agentName?: string;
  sandboxId?: string;
  dashboardUrl?: string;
}

export const APP_CONFIG_DEFAULTS: AppConfig = {
  companyName: 'Memorable',
  pageTitle: 'Memorable — 3-Layer Shared Memory',
  pageDescription:
    'Enterprise voice AI memory for telecom. Every support call makes every future agent smarter.',

  supportsChatInput: true,
  supportsVideoInput: false,
  supportsScreenShare: false,
  isPreConnectBufferEnabled: true,

  logo: '/lk-logo.svg',
  accent: '#818cf8',
  logoDark: '/lk-logo-dark.svg',
  accentDark: '#818cf8',
  startButtonText: 'Start support call',

  audioVisualizerType: 'bar',
  audioVisualizerColor: '#818cf8',
  audioVisualizerColorDark: '#818cf8',
  audioVisualizerBarCount: 5,

  agentName: process.env.AGENT_NAME ?? undefined,
  sandboxId: undefined,
  dashboardUrl: process.env.NEXT_PUBLIC_DASHBOARD_URL ?? 'http://localhost:8000',
};
