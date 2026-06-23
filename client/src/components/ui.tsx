// client/src/components/ui.tsx
import type { ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import { statusStyle } from '../lib/format';
import { freshness } from '../lib/metrics';

interface StatusPillProps {
  status?: string | null;
}

export function StatusPill({ status }: StatusPillProps) {
  const s = statusStyle(status);
  return (
    <span className="pill" style={{ background: s.bg, color: s.color }}>
      <span className="w-1.5 h-1.5 rounded-full" style={{ background: s.color }} />
      {s.label}
    </span>
  );
}

interface FreshnessPillProps {
  lastSeenAt?: string | Date | null;
  className?: string;
}

// Data-freshness indicator derived from the last reading time. Pulses while live.
export function FreshnessPill({ lastSeenAt, className = '' }: FreshnessPillProps) {
  const f = freshness(lastSeenAt);
  return (
    <span
      className={`inline-flex items-center gap-1.5 text-[11px] font-medium ${className}`}
      style={{ color: f.color }}
      title={lastSeenAt ? new Date(lastSeenAt).toLocaleString('en-IN') : 'No readings yet'}
    >
      <span className={`w-2 h-2 rounded-full ${f.pulse ? 'live-dot' : ''}`} style={{ background: f.color }} />
      {f.label}
    </span>
  );
}

interface LiveDotProps {
  active?: boolean;
}

export function LiveDot({ active }: LiveDotProps) {
  return (
    <span
      className={`w-2 h-2 rounded-full ${active ? 'live-dot' : ''}`}
      style={{ background: active ? '#0D9488' : '#CBD5E1' }}
    />
  );
}

interface StatCardProps {
  label: ReactNode;
  value: ReactNode;
  sub?: ReactNode;
  accent?: string;
  icon?: LucideIcon;
}

export function StatCard({ label, value, sub, accent = '#64748B', icon: Icon }: StatCardProps) {
  return (
    <div className="card p-4">
      <div className="flex items-start justify-between">
        <span className="label">{label}</span>
        {Icon && <Icon size={15} className="text-steel" />}
      </div>
      <div className="data text-2xl font-bold mt-2" style={{ color: accent }}>{value}</div>
      {sub && <div className="text-xs text-steel mt-1">{sub}</div>}
    </div>
  );
}

interface SpinnerProps {
  label?: ReactNode;
}

export function Spinner({ label = 'Loading' }: SpinnerProps) {
  return (
    <div className="flex items-center gap-2 text-steel text-sm py-8 justify-center">
      <span className="w-4 h-4 border-2 border-line border-t-accent rounded-full animate-spin" />
      {label}…
    </div>
  );
}

type BadgeColor = 'accent' | 'idle' | 'stopped' | 'steel';

interface BadgeProps {
  children: ReactNode;
  color?: BadgeColor;
}

export function Badge({ children, color = 'accent' }: BadgeProps) {
  const map: Record<BadgeColor, string> = {
    accent: 'bg-accent/10 text-accent',
    idle: 'bg-idle/10 text-idle',
    stopped: 'bg-stopped/10 text-stopped',
    steel: 'bg-line text-steel',
  };
  return <span className={`pill ${map[color] || map.steel}`}>{children}</span>;
}
