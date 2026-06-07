'use client';

import { AnimatePresence, motion } from 'motion/react';
import { useSessionContext } from '@livekit/components-react';
import type { AppConfig } from '@/app-config';
import { AgentSessionView_01 } from '@/components/agents-ui/blocks/agent-session-view-01';
import { MossResultsPanel } from '@/components/app/moss-results-panel';
import { WelcomeView } from '@/components/app/welcome-view';
import { useMossContextEvents } from '@/hooks/useMossContextEvents';

const MotionWelcomeView = motion.create(WelcomeView);
const MotionSessionView = motion.create(AgentSessionView_01);

const VIEW_MOTION_PROPS = {
  variants: {
    visible: { opacity: 1 },
    hidden: { opacity: 0 },
  },
  initial: 'hidden',
  animate: 'visible',
  exit: 'hidden',
  transition: { duration: 0.3, ease: 'linear' },
};

interface MemorableLayoutProps {
  appConfig: AppConfig;
}

export function MemorableLayout({ appConfig }: MemorableLayoutProps) {
  const { isConnected, start } = useSessionContext();
  const mossEvents = useMossContextEvents();
  const dashboardUrl = appConfig.dashboardUrl ?? 'http://localhost:8000';

  return (
    <div className="grid h-svh w-full grid-cols-1 bg-[#09090b] lg:grid-cols-[1fr_340px]">
      <div className="relative min-h-0 border-r border-white/[0.06]">
        <iframe
          src={dashboardUrl}
          title="Memorable Memory Dashboard"
          className="h-full w-full border-0 bg-[#09090b]"
          allow="clipboard-read; clipboard-write"
        />
      </div>

      <aside className="relative flex min-h-0 flex-col bg-[#0d0d12]">
        <header className="flex items-center gap-3 border-b border-white/[0.06] px-4 py-3">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-indigo-500 text-sm font-bold text-white">
            M
          </div>
          <div>
            <p className="text-sm font-semibold text-[#f1f5f9]">Voice Agent</p>
            <p className="text-[11px] text-[#64748b]">Telecom ISP support</p>
          </div>
        </header>

        <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden [&_.bg-background]:bg-transparent [&_.max-w-sm]:hidden [&_section]:!bg-transparent">
          <AnimatePresence mode="wait">
            {!isConnected ? (
              <MotionWelcomeView
                key="welcome"
                {...VIEW_MOTION_PROPS}
                startButtonText={appConfig.startButtonText}
                onStartCall={start}
                compact
              />
            ) : (
              <MotionSessionView
                key="session-view"
                {...VIEW_MOTION_PROPS}
                preConnectMessage="Try: My internet keeps dropping"
                supportsChatInput={appConfig.supportsChatInput}
                supportsVideoInput={false}
                supportsScreenShare={false}
                isPreConnectBufferEnabled={appConfig.isPreConnectBufferEnabled}
                audioVisualizerType="bar"
                audioVisualizerColor="#818cf8"
                audioVisualizerBarCount={5}
                className="relative h-full w-full [&_.absolute.inset-x-3]:inset-x-2 [&_.absolute.inset-x-3]:bottom-2 [&_.max-w-2xl]:max-w-full"
              />
            )}
          </AnimatePresence>
        </div>

        {isConnected && <MossResultsPanel events={mossEvents} compact />}
      </aside>
    </div>
  );
}
