// client/src/components/PressureRing.tsx
// Circular gauge — efficiency / fill percentage, status-colored arc.
import type { ReactNode } from 'react';
import { STATUS } from '../lib/format';

interface PressureRingProps {
  value?: number;
  status?: string;
  size?: number;
  stroke?: number;
  label?: ReactNode;
}

export default function PressureRing({
  value = 0,
  status = 'offline',
  size = 64,
  stroke = 6,
  label,
}: PressureRingProps) {
  const v = Math.max(0, Math.min(100, Math.round(value)));
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const offset = c - (v / 100) * c;
  const color = STATUS[status]?.color || '#64748B';

  return (
    <div className="relative inline-flex items-center justify-center" style={{ width: size, height: size }}>
      <svg width={size} height={size} className="-rotate-90">
        {/* Track ring — light gray on light bg */}
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="#E2E8F0" strokeWidth={stroke} />
        <circle
          cx={size / 2} cy={size / 2} r={r} fill="none"
          stroke={color} strokeWidth={stroke} strokeLinecap="round"
          strokeDasharray={c} strokeDashoffset={offset}
          style={{ transition: 'stroke-dashoffset 0.6s ease, stroke 0.3s' }}
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className="data text-sm font-bold" style={{ color }}>{v}<span className="text-[9px]">%</span></span>
        {label && <span className="text-[8px] text-steel uppercase tracking-wide">{label}</span>}
      </div>
    </div>
  );
}
