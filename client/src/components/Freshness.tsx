// client/src/components/Freshness.tsx
// Data-freshness badge: a pulsing "Live" dot when a machine is streaming now, else
// a colour-coded age ("12m ago" / "5h ago"). This is the last-updated / liveness
// signal — distinct from the reported status pill.
import { freshness } from '../lib/machineStatus';

interface FreshnessProps {
  lastReadingAt?: string | null;
  /** The collector is reporting, but cannot see the machine. A teal pulsing
   *  "Live" beside a Signal Lost pill is a flat contradiction: readings ARE
   *  arriving — nine a second on SPG07 — they just carry nothing about the
   *  machine. The distinction still matters and is not dropped: a dead
   *  collector and a live one that cannot reach its PLC are different faults
   *  for different people, so this says which, quietly. */
  blind?: boolean;
  className?: string;
}

export default function Freshness({ lastReadingAt, blind, className = '' }: FreshnessProps): JSX.Element {
  const f = freshness(lastReadingAt);
  const blindLive = !!blind && f.state === 'live';
  const label = blindLive ? 'collector live' : f.label;
  const color = blindLive ? '#94A3B8' : f.color;
  const pulse = blindLive ? false : f.pulse;
  return (
    <span
      className={`inline-flex items-center gap-1.5 text-[11px] font-medium whitespace-nowrap ${className}`}
      style={{ color }}
      title={blindLive
        ? 'The collector is sending, but it cannot see the machine'
        : lastReadingAt ? `Last update: ${new Date(lastReadingAt).toLocaleString()}` : 'No data received'}
    >
      <span className="relative flex h-2 w-2">
        {pulse && (
          <span
            className="absolute inline-flex h-full w-full animate-ping rounded-full opacity-60"
            style={{ background: color }}
          />
        )}
        <span className="relative inline-flex h-2 w-2 rounded-full" style={{ background: color }} />
      </span>
      {label}
    </span>
  );
}
