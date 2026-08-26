// client/src/components/TargetDrilldown.tsx
// Click a Targets-board tile → this modal, right on the dashboard: how THIS
// machine performed against its DIA's rate across the PAGE'S filter window —
// the big produced-of-target figure, the machine's whole time story (runtime /
// idle / stopped / downtime / availability), and a bucket-by-bucket chart of
// actual vs target (hours for short windows, production days for long ones).
//
// The chart asks the server for basis=window rows: the machine's CURRENT rate
// held over the whole window, actuals from the same confirmed-counter-step
// engine as everything else. That matches the live model the tiles use, so the
// modal never contradicts the tile that opened it.
import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, keepPreviousData } from '@tanstack/react-query';
import { Target, ArrowRight } from 'lucide-react';
import { productionApi } from '../api/endpoints';
import Modal from './Modal';
import { Spinner } from './ui';
import { fmtNum, fmtDuration, fmtDate } from '../lib/format';
import { fmtTarget, fmtProcessing, hourlyRate } from '../lib/targets';
import type { MachineActivityRow, MachineAssignment } from '../types/api';

const TEAL = '#0D9488', AMBER = '#D97706', RED = '#DC2626', SLATE = '#94A3B8';
const DAY_MS = 24 * 3_600_000;

export default function TargetDrilldown({ code, row, assignment, from, to, windowMs, produced, target, pct, onClose }: {
  code: string;
  row: MachineActivityRow;
  assignment: MachineAssignment;
  from: string;
  to: string;
  windowMs: number;
  produced: number | null;
  target: number;
  pct: number | null;
  onClose: () => void;
}): JSX.Element {
  const spanMs = new Date(to).getTime() - new Date(from).getTime();
  // Hours read well up to a few days; beyond that, one bar per production day.
  const groupBy = spanMs > 3 * DAY_MS ? 'day' : 'hour';

  const { data, isLoading } = useQuery({
    queryKey: ['targets-drill', code, from, to, groupBy],
    queryFn: () => productionApi.targets({ from, to, machineId: code, groupBy, basis: 'window', limit: 2000 }),
    placeholderData: keepPreviousData,
    refetchInterval: 60_000,
  });

  // One bar per bucket — operator handovers split server rows, so merge back.
  const buckets = useMemo(() => {
    const by = new Map<string, { t: number; actual: number; target: number; downSec: number }>();
    for (const r of data?.data || []) {
      const acc = by.get(r.bucket) || { t: new Date(r.bucket).getTime(), actual: 0, target: 0, downSec: 0 };
      acc.actual += r.actual; acc.target += r.target; acc.downSec += r.downtimeSec;
      by.set(r.bucket, acc);
    }
    return [...by.values()].sort((a, b) => a.t - b.t);
  }, [data]);

  const color = pct == null ? SLATE : pct >= 100 ? TEAL : pct >= 50 ? AMBER : RED;
  const snap = assignment.snapshot;
  const avail = windowMs ? Math.round((row.runningMs / windowMs) * 100) : 0;

  return (
    <Modal
      title={code}
      subtitle={`${snap.diaName}${snap.dims ? ` · ${snap.dims}` : ''} — ${snap.stageName} · ${fmtProcessing(snap.processingSec)}/unit → ${fmtTarget(hourlyRate(snap.processingSec))}/hr`}
      icon={Target} onClose={onClose} maxW="max-w-2xl"
    >
      <div className="space-y-5">
        {/* The verdict for the window */}
        <div>
          <div className="flex items-baseline gap-2 flex-wrap">
            <span className="data text-3xl font-bold text-primary">{produced != null ? fmtNum(produced) : '—'}</span>
            <span className="text-steel text-sm">of</span>
            <span className="data text-3xl font-bold text-accent">{fmtTarget(target)}</span>
            <span className="text-steel text-sm">pcs in this window</span>
            {pct != null && <span className="data text-lg font-bold ml-auto" style={{ color }}>{pct.toFixed(1)}%</span>}
          </div>
          <div className="h-2 bg-line rounded-full overflow-hidden mt-2">
            <div className="h-full rounded-full transition-all" style={{ width: `${Math.min(pct ?? 0, 100)}%`, background: color }} />
          </div>
          {row.productionFrom && (
            <p className="text-[11px] text-steel mt-1.5">Pieces counted at {row.productionFrom} · 2 min behind</p>
          )}
        </div>

        {/* The machine's whole time story for the same window */}
        <div className="grid grid-cols-3 sm:grid-cols-6 gap-2">
          <Stat label="Runtime" value={fmtDuration(row.runningMs)} color={TEAL} />
          <Stat label="Idle" value={fmtDuration(row.idleMs)} color={row.idleMs ? AMBER : SLATE} />
          <Stat label="Stopped" value={fmtDuration(row.stoppedMs)} color={row.stoppedMs ? RED : SLATE} />
          <Stat label="Downtime" value={fmtDuration(row.idleMs + row.stoppedMs)} color={row.idleMs + row.stoppedMs ? '#991B1B' : SLATE} />
          <Stat label="Availability" value={`${avail}%`} color={avail >= 60 ? TEAL : AMBER} />
          <Stat label="Readings" value={fmtNum(row.readings)} color={SLATE} />
        </div>

        {/* Bucket by bucket against the rate */}
        <div>
          <div className="text-[10px] uppercase tracking-wide text-steel mb-2">
            {groupBy === 'hour' ? 'Hour by hour' : 'Day by day'} · bar = made, dashed line = target
          </div>
          {isLoading ? <Spinner /> : buckets.length < 1 ? (
            <p className="text-xs text-steel py-4">No production data in this window.</p>
          ) : (() => {
            const max = Math.max(...buckets.map((b) => Math.max(b.actual, b.target)), 1);
            return (
              <div className="flex items-end gap-1.5 h-28 overflow-x-auto pb-1">
                {buckets.map((b) => {
                  const made = b.actual >= b.target * 0.999;
                  const label = groupBy === 'hour'
                    ? new Date(b.t).toLocaleTimeString([], { hour: 'numeric' }).replace(' ', '').toLowerCase()
                    : fmtDate(new Date(b.t)).slice(0, 6);
                  return (
                    <div key={b.t} className="flex flex-col items-center gap-1 min-w-[36px] flex-1 h-full"
                      title={`${b.actual} of ${fmtTarget(b.target)}${b.downSec >= 60 ? ` · ${fmtDuration(b.downSec * 1000)} down` : ''}`}>
                      <span className="data text-[10px] leading-none" style={{ color: made ? TEAL : AMBER }}>{b.actual}</span>
                      <div className="w-full flex-1 relative">
                        <div className="absolute bottom-0 left-0 right-0 rounded-t" style={{
                          height: `${Math.max((b.actual / max) * 100, 2)}%`,
                          background: made ? TEAL : AMBER, opacity: 0.85,
                        }} />
                        {b.target > 0 && (
                          <div className="absolute left-0 right-0 border-t border-dashed border-steel/70"
                            style={{ bottom: `${Math.min((b.target / max) * 100, 100)}%` }} />
                        )}
                      </div>
                      <span className="text-[9px] text-steel leading-none whitespace-nowrap">{label}</span>
                    </div>
                  );
                })}
              </div>
            );
          })()}
        </div>

        <div className="flex justify-end pt-1">
          <Link to={`/machines/${encodeURIComponent(code)}`}
            className="inline-flex items-center gap-1.5 text-sm text-accent border border-accent/20 bg-accent/5 hover:bg-accent/10 rounded-lg px-3.5 py-2 font-medium transition-colors">
            Open machine <ArrowRight size={14} />
          </Link>
        </div>
      </div>
    </Modal>
  );
}

function Stat({ label, value, color }: { label: string; value: string; color: string }): JSX.Element {
  return (
    <div className="rounded-lg border border-line bg-base px-2.5 py-2 text-center">
      <div className="label truncate">{label}</div>
      <div className="data text-sm font-bold mt-0.5" style={{ color }}>{value}</div>
    </div>
  );
}
