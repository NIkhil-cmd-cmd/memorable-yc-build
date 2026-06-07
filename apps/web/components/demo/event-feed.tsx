'use client';

import { useEffect, useState } from 'react';

type Event = {
  type: string;
  data: Record<string, unknown>;
  timestamp: string;
};

export function EventFeed() {
  const [events, setEvents] = useState<Event[]>([]);

  useEffect(() => {
    const es = new EventSource('/api/events');
    es.onmessage = (ev) => {
      try {
        const parsed = JSON.parse(ev.data);
        if (parsed.type === 'connected') return;
        setEvents((prev) => [parsed, ...prev].slice(0, 12));
      } catch {
        /* ignore */
      }
    };
    return () => es.close();
  }, []);

  if (!events.length) return null;

  return (
    <div className="glass-panel mt-8 p-4">
      <p className="section-label mb-3">Live events</p>
      <div className="space-y-2 font-mono text-xs">
        {events.map((e, i) => (
          <div key={i} className="flex gap-3 text-white/50">
            <span className="text-white/30">{e.type}</span>
            <span>{JSON.stringify(e.data)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
