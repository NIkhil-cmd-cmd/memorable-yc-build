import { useEffect, useMemo, useState } from 'react';
import { RoomEvent } from 'livekit-client';
import { useRoomContext } from '@livekit/components-react';

const textDecoder = new TextDecoder();

export type MemoryHit = {
  text: string;
  score?: number;
  layer?: string;
};

export type MossContextEvent = {
  id: string;
  query: string;
  primaryLayer: string;
  layersActive: string[];
  primaryHit: MemoryHit | null;
  knowledgeHit: MemoryHit | null;
  nextAction: string | null;
  timestamp: number;
  timeTakenMs?: number | null;
};

const MAX_EVENTS_DEFAULT = 1;

function parseHit(raw: unknown): MemoryHit | null {
  if (!raw || typeof raw !== 'object') return null;
  const hit = raw as Record<string, unknown>;
  const text = typeof hit.text === 'string' ? hit.text : '';
  if (!text) return null;
  return {
    text,
    score: typeof hit.score === 'number' ? hit.score : undefined,
    layer: typeof hit.layer === 'string' ? hit.layer : undefined,
  };
}

function parsePayload(payload: Uint8Array): MossContextEvent | null {
  try {
    const raw = textDecoder.decode(payload);
    const message = JSON.parse(raw);
    if (!message || message.type !== 'moss_context' || typeof message.data !== 'object') {
      return null;
    }

    const data = message.data as Record<string, unknown>;
    const query = typeof data.query === 'string' ? data.query : '';
    if (!query) return null;

    const timestampRaw = typeof data.timestamp === 'number' ? data.timestamp : Date.now() / 1000;
    const timestampMs = timestampRaw * 1000;
    const timeTakenMs = typeof data.time_taken_ms === 'number' ? data.time_taken_ms : null;
    const primaryLayer =
      typeof data.primary_layer === 'string'
        ? data.primary_layer
        : typeof data.layer_used === 'string'
          ? data.layer_used
          : 'none';
    const layersActive = Array.isArray(data.layers_active)
      ? data.layers_active.filter((item): item is string => typeof item === 'string')
      : [];
    const nextAction = typeof data.next_action === 'string' ? data.next_action : null;

    return {
      id: `${timestampMs}-${query}`,
      query,
      primaryLayer,
      layersActive,
      primaryHit: parseHit(data.primary_hit),
      knowledgeHit: parseHit(data.knowledge_hit),
      nextAction,
      timestamp: timestampMs,
      timeTakenMs,
    };
  } catch (error) {
    console.warn('Failed to parse moss context payload', error);
    return null;
  }
}

export function useMossContextEvents(maxEvents = MAX_EVENTS_DEFAULT) {
  const room = useRoomContext();
  const [events, setEvents] = useState<MossContextEvent[]>([]);

  useEffect(() => {
    if (!room) return;

    const handleData = (payload: Uint8Array) => {
      const parsed = parsePayload(payload);
      if (!parsed) return;

      setEvents((prev) => {
        const next = [...prev, parsed];
        if (maxEvents > 0 && next.length > maxEvents) {
          return next.slice(-maxEvents);
        }
        return next;
      });
    };

    room.on(RoomEvent.DataReceived, handleData);

    return () => {
      room.off(RoomEvent.DataReceived, handleData);
    };
  }, [room, maxEvents]);

  return useMemo(() => events, [events]);
}
