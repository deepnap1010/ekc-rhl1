// client/src/components/Freshness.tsx
// Data-freshness badge: a pulsing "Live" dot when a machine is streaming now, else
// a colour-coded age ("12m ago" / "5h ago"). This is the last-updated / liveness
// signal — distinct from the reported status pill.
import { freshness } from '../lib/machineStatus';

interface FreshnessProps {
  lastReadingAt?: string | null;
  className?: string;
}

export default function Freshness({ lastReadingAt, className = '' }: FreshnessProps): JSX.Element {
  const f = freshness(lastReadingAt);
  return (
    <span
      className={`inline-flex items-center gap-1.5 text-[11px] font-medium whitespace-nowrap ${className}`}
      style={{ color: f.color }}
      title={lastReadingAt ? `Last update: ${new Date(lastReadingAt).toLocaleString()}` : 'No data received'}
    >
      <span className="relative flex h-2 w-2">
        {f.pulse && (
          <span
            className="absolute inline-flex h-full w-full animate-ping rounded-full opacity-60"
            style={{ background: f.color }}
          />
        )}
        <span className="relative inline-flex h-2 w-2 rounded-full" style={{ background: f.color }} />
      </span>
      {f.label}
    </span>
  );
}
