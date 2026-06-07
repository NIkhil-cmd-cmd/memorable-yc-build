type MemorableEvent = {
  type: string;
  data: Record<string, unknown>;
  timestamp: string;
};

const MAX_EVENTS = 200;
const listeners = new Set<(event: MemorableEvent) => void>();
const buffer: MemorableEvent[] = [];

export function publishEvent(event: MemorableEvent) {
  buffer.unshift(event);
  if (buffer.length > MAX_EVENTS) buffer.pop();
  listeners.forEach((fn) => fn(event));
}

export function getRecentEvents(limit = 50): MemorableEvent[] {
  return buffer.slice(0, limit);
}

export function subscribe(fn: (event: MemorableEvent) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
