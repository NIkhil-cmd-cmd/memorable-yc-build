'use client';

import { useEffect, useState } from 'react';

type GraphData = {
  nodes: { id: string; label: string }[];
  edges: { id: string; source: string; target: string; rate: number }[];
};

export function MemoryGraph() {
  const [graph, setGraph] = useState<GraphData | null>(null);

  useEffect(() => {
    fetch('/api/memory/graph?task=internet_dropout')
      .then((r) => r.json())
      .then(setGraph)
      .catch(() => setGraph({ nodes: [], edges: [] }));
  }, []);

  if (!graph) {
    return (
      <div className="glass-panel flex h-64 items-center justify-center">
        <p className="text-white/40">Loading graph...</p>
      </div>
    );
  }

  return (
    <div className="glass-panel-strong p-6">
      <p className="section-label mb-4">GNN workflow graph — internet_dropout</p>
      <div className="relative h-64 overflow-hidden rounded-lg bg-black/30">
        <svg viewBox="0 0 400 240" className="h-full w-full">
          {graph.edges.map((edge, i) => {
            const fromIdx = graph.nodes.findIndex((n) => n.id === edge.source);
            const toIdx = graph.nodes.findIndex((n) => n.id === edge.target);
            const x1 = 60 + (fromIdx % 3) * 120;
            const y1 = 40 + Math.floor(fromIdx / 3) * 80;
            const x2 = 60 + (toIdx % 3) * 120;
            const y2 = 40 + Math.floor(toIdx / 3) * 80;
            const color = edge.rate > 0.6 ? '#22c55e' : edge.rate < 0.3 ? '#ef4444' : '#f59e0b';
            return (
              <line
                key={edge.id}
                x1={x1}
                y1={y1}
                x2={x2}
                y2={y2}
                stroke={color}
                strokeWidth={2 + edge.rate * 2}
                opacity={0.8}
              />
            );
          })}
          {graph.nodes.map((node, i) => {
            const x = 60 + (i % 3) * 120;
            const y = 40 + Math.floor(i / 3) * 80;
            return (
              <g key={node.id}>
                <rect
                  x={x - 40}
                  y={y - 14}
                  width={80}
                  height={28}
                  rx={6}
                  fill="#18181f"
                  stroke="#6366f1"
                  strokeWidth={1.5}
                />
                <text x={x} y={y + 4} textAnchor="middle" fill="#e2e8f0" fontSize={8}>
                  {node.label.slice(0, 14)}
                </text>
              </g>
            );
          })}
        </svg>
      </div>
      <p className="mt-3 text-xs text-white/40">
        Green = high success rate · Red = dead-end transitions
      </p>
    </div>
  );
}
