'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { TokenSource } from 'livekit-client';
import { RoomAudioRenderer, useSession } from '@livekit/components-react';
import { AgentAudioVisualizerBar } from '@/components/agents-ui/agent-audio-visualizer-bar';
import { AgentChatTranscript } from '@/components/agents-ui/agent-chat-transcript';
import { AgentControlBar } from '@/components/agents-ui/agent-control-bar';
import { AgentSessionProvider } from '@/components/agents-ui/agent-session-provider';
import { StartAudioButton } from '@/components/agents-ui/start-audio-button';

type Props = {
  mode: 'cold' | 'full';
  label: string;
  accent: 'red' | 'cyan';
  active: boolean;
  completed: boolean;
  onComplete: (tools: string[]) => void;
};

function VoiceSession({ mode, label, accent, active, onComplete }: Omit<Props, 'completed'>) {
  const [tools, setTools] = useState<string[]>([]);
  const [connected, setConnected] = useState(false);

  const tokenSource = useMemo(
    () =>
      TokenSource.custom(async (_options) => {
        const res = await fetch('/api/token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ memory_mode: mode }),
        });
        if (!res.ok) throw new Error(await res.text());
        const data = await res.json();
        return {
          serverUrl: data.serverUrl,
          roomName: data.roomName,
          participantName: data.participantName,
          participantToken: data.participantToken,
        };
      }),
    [mode]
  );

  const session = useSession(tokenSource, { agentName: 'memorable-agent' });

  useEffect(() => {
    if (!active) return;
    const es = new EventSource('/api/events');
    es.onmessage = (ev) => {
      try {
        const parsed = JSON.parse(ev.data);
        if (parsed.type === 'tool_call' && parsed.data?.mode === mode) {
          const tool = parsed.data.tool as string;
          setTools((prev) => (prev.includes(tool) ? prev : [...prev, tool]));
        }
      } catch {
        /* ignore */
      }
    };
    return () => es.close();
  }, [active, mode]);

  useEffect(() => {
    if (session.isConnected) setConnected(true);
  }, [session.isConnected]);

  const handleEnd = useCallback(() => {
    session.end();
    onComplete(
      tools.length
        ? tools
        : mode === 'cold'
          ? ['factory_reset_router']
          : ['check_outage_map', 'reboot_modem']
    );
  }, [session, tools, onComplete, mode]);

  const borderColor = accent === 'red' ? 'border-red-400/30' : 'border-cyan-400/30';
  const labelColor = accent === 'red' ? 'text-red-400' : 'text-cyan-400';

  return (
    <AgentSessionProvider session={session}>
      <div
        className={`glass-panel-strong flex flex-col gap-4 p-5 ${borderColor} border ${!active ? 'opacity-60' : ''}`}
      >
        <div className="flex items-center justify-between">
          <p className={`section-label ${labelColor}`}>{label}</p>
          <span className="text-xs text-white/40">{mode} mode</span>
        </div>

        {active && (
          <>
            <AgentAudioVisualizerBar />
            <AgentChatTranscript className="max-h-48 overflow-y-auto text-sm" />
            <AgentControlBar />
            <StartAudioButton label="Enable microphone" room={session.room} />
            <RoomAudioRenderer />
            <div className="flex gap-2">
              {!connected && (
                <button
                  type="button"
                  onClick={() => session.start()}
                  className="flex-1 rounded-lg bg-white/10 py-2 text-sm hover:bg-white/20"
                >
                  Connect
                </button>
              )}
              <button
                type="button"
                onClick={handleEnd}
                className="flex-1 rounded-lg bg-white py-2 text-sm font-medium text-black hover:bg-white/90"
              >
                End call
              </button>
            </div>
          </>
        )}

        {tools.length > 0 && (
          <div className="text-xs text-white/50">Tools: {tools.join(' → ')}</div>
        )}
      </div>
    </AgentSessionProvider>
  );
}

export function DemoVoicePanel(props: Props) {
  if (!props.active && !props.completed) return null;
  return <VoiceSession {...props} />;
}
