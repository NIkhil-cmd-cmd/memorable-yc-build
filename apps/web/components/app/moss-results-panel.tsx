import * as React from 'react';
import type { MossContextEvent } from '@/hooks/useMossContextEvents';
import { cn } from '@/lib/shadcn/utils';

interface MossResultsPanelProps extends React.HTMLAttributes<HTMLDivElement> {
  events: MossContextEvent[];
  hidden?: boolean;
  compact?: boolean;
}

const LAYERS = [
  { id: 'episodic', label: 'L1 Episodic', short: 'L1' },
  { id: 'semantic', label: 'L2 Semantic', short: 'L2' },
  { id: 'workflow', label: 'L3 Workflow', short: 'L3' },
] as const;

function truncate(text: string, max: number) {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (clean.length <= max) return clean;
  return `${clean.slice(0, max - 1).trim()}…`;
}

export function MossResultsPanel({
  events,
  hidden = false,
  compact = false,
  className,
  ...props
}: MossResultsPanelProps) {
  const latest = events.at(-1);

  if (hidden) return null;

  return (
    <div
      className={cn(
        'border-t border-white/[0.06] bg-[#0d0d12]',
        compact ? 'px-3 py-3' : 'px-4 py-4',
        className
      )}
      {...props}
    >
      <div className="mb-2 flex items-center justify-between gap-2">
        <p className="text-[11px] font-semibold tracking-wide text-[#94a3b8] uppercase">
          Memory → Action
        </p>
        {latest?.timeTakenMs != null && (
          <span className="font-mono text-[10px] text-[#64748b]">
            {latest.timeTakenMs.toFixed(0)}ms
          </span>
        )}
      </div>

      <div className="mb-3 grid grid-cols-3 gap-1.5">
        {LAYERS.map(({ id, label, short }) => {
          const active = latest?.layersActive.includes(id);
          const winner = latest?.primaryLayer === id;
          return (
            <div
              key={id}
              title={label}
              className={cn(
                'rounded-md border px-1.5 py-1.5 text-center transition-colors',
                winner
                  ? 'border-[#818cf8] bg-[#818cf8]/15 text-[#c7d2fe]'
                  : active
                    ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300'
                    : 'border-white/[0.06] bg-[#111116] text-[#64748b]'
              )}
            >
              <p className="text-[10px] font-semibold">{short}</p>
            </div>
          );
        })}
      </div>

      {!latest ? (
        <p className="text-[11px] leading-relaxed text-[#64748b]">
          Memory picks a playbook step before the agent speaks — not after.
        </p>
      ) : (
        <div className="space-y-2">
          {latest.nextAction ? (
            <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 p-2.5">
              <p className="mb-1 text-[10px] font-semibold text-emerald-400 uppercase">
                Agent will do this
              </p>
              <p className="text-[12px] leading-snug font-medium text-[#ecfdf5]">
                {latest.nextAction}
              </p>
            </div>
          ) : (
            <p className="text-[11px] text-[#64748b] italic">No confident playbook step.</p>
          )}
          {latest.primaryHit && (
            <p className="text-[10px] leading-relaxed text-[#64748b]">
              <span className="text-[#94a3b8]">
                From L
                {latest.primaryLayer === 'episodic'
                  ? '1'
                  : latest.primaryLayer === 'semantic'
                    ? '2'
                    : '3'}
                :
              </span>{' '}
              {truncate(
                latest.primaryHit.text
                  .replace(/^RECOMMENDED for [^:]+:\s*/, '')
                  .replace(/^AVOID for [^:]+:\s*/, 'Avoid: '),
                100
              )}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
