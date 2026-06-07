'use client';

type Props = {
  coldTools: string[];
  memoryTools: string[];
};

const ROWS = [
  { label: 'First tool', coldKey: 0, memoryKey: 0 },
  { label: 'Second tool', coldKey: 1, memoryKey: 1 },
  { label: 'Outcome', cold: 'Likely failure', memory: 'Likely success' },
];

export function ComparisonPanel({ coldTools, memoryTools }: Props) {
  return (
    <div className="glass-panel-strong p-6">
      <p className="section-label mb-4">Side-by-side proof</p>
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-white/10 text-left">
            <th className="pb-3 text-white/40">Step</th>
            <th className="pb-3 text-red-400">Cold</th>
            <th className="pb-3 text-cyan-400">Memory</th>
          </tr>
        </thead>
        <tbody>
          {ROWS.map((row) => (
            <tr key={row.label} className="border-b border-white/5">
              <td className="py-3 text-white/50">{row.label}</td>
              <td className="py-3">
                {'cold' in row ? row.cold : (coldTools[row.coldKey!] ?? '—')}
              </td>
              <td className="py-3">
                {'memory' in row ? row.memory : (memoryTools[row.memoryKey!] ?? '—')}
              </td>
            </tr>
          ))}
          <tr>
            <td className="py-3 text-white/50">Restricted fare retry</td>
            <td className="py-3 text-red-300">
              {coldTools.includes('retry_booking_failed_fare_class') ? 'Yes ✗' : 'Maybe'}
            </td>
            <td className="py-3 text-cyan-300">
              {memoryTools.includes('retry_booking_failed_fare_class') ? 'Yes ✗' : 'Blocked ✓'}
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}
