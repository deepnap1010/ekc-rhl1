// client/src/components/DowntimeReasons.tsx
// Where the downtime went — the Downtime page's reasons summary for the
// window and machine on screen. Three views over one server call
// (/downtime/reasons): totals per reason, reason × shift, reason × hour of
// the day. "No reason given" is a row like any other: the unexplained share
// is the first number a supervisor looks for.
import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ListChecks } from 'lucide-react';
import { downtimeApi } from '../api/endpoints';
import { Spinner } from './ui';
import { fmtDuration, fmtNum } from '../lib/format';

const NONE = 'No reason given';
const label = (r: string): string => r || NONE;
// The plant clock's offset from UTC, minutes east — the server buckets shifts
// and hours on it, so 14:58 IST is Shift A / hour 14, not UTC's 09.
const TZ = -new Date().getTimezoneOffset();

interface Props { from?: string; to?: string; machineId?: string; type?: string; enabled?: boolean }

export default function DowntimeReasons({ from, to, machineId, type, enabled = true }: Props): JSX.Element | null {
  const [view, setView] = useState<'reason' | 'shift' | 'hour'>('reason');
  const { data, isLoading } = useQuery({
    queryKey: ['downtime', 'reasons', from, to, machineId, type],
    queryFn: () => downtimeApi.reasons({ from, to, machineId: machineId || undefined, type: type && type !== 'all' ? type : undefined, tz: TZ }).then((r) => r.data),
    refetchInterval: 60_000,
    enabled,
  });

  // Rows in one order everywhere — by total time, the unexplained bucket
  // taking its place by size like the rest.
  const reasons = useMemo(() => (data?.byReason || []).map((r) => r.reason), [data]);
  const cell = <T extends { reason: string }>(rows: T[], reason: string, pick: (r: T) => boolean): T | undefined =>
    rows.find((r) => r.reason === reason && pick(r));

  if (!enabled) return null;
  if (isLoading) return <div className="panel p-5"><Spinner /></div>;
  if (!data || !data.byReason.length) return null;

  const total = data.totalMs || 1;
  const shifts = data.shifts.length ? [...data.shifts, ...(data.byShift.some((r) => r.shift === 'Off-shift') ? ['Off-shift'] : [])] : ['All day'];
  const hours = Array.from({ length: 24 }, (_, h) => h);
  const maxHour = Math.max(1, ...data.byHour.map((r) => r.totalMs));

  return (
    <div className="panel p-5">
      <div className="flex flex-wrap items-center justify-between gap-3 mb-3">
        <div className="flex items-center gap-2">
          <ListChecks size={15} className="text-accent" />
          <h2 className="font-semibold text-sm">Downtime by reason</h2>
          <span className="text-xs text-steel">{fmtDuration(data.totalMs)} in this window</span>
        </div>
        <div className="flex rounded-xl border border-line overflow-hidden">
          {([['reason', 'Totals'], ['shift', 'By shift'], ['hour', 'By hour']] as const).map(([v, l]) => (
            <button key={v} onClick={() => setView(v)}
              className={`px-3 py-1.5 text-xs font-medium transition-colors ${view === v ? 'bg-accent text-white' : 'bg-base text-steel hover:text-primary'}`}>{l}</button>
          ))}
        </div>
      </div>

      {view === 'reason' && (
        <table className="w-full text-sm">
          <thead className="bg-base">
            <tr className="text-steel">
              <th className="text-left label px-3 py-2">Reason</th>
              <th className="text-right label px-3 py-2">Events</th>
              <th className="text-right label px-3 py-2">Downtime</th>
              <th className="text-left label px-3 py-2 w-1/3">Share</th>
            </tr>
          </thead>
          <tbody>
            {data.byReason.map((r) => (
              <tr key={r.reason || '__none'} className="border-t border-line">
                <td className={`px-3 py-2 ${r.reason ? 'text-primary' : 'text-steel italic'}`}>{label(r.reason)}</td>
                <td className="px-3 py-2 data text-xs text-right">{fmtNum(r.events)}</td>
                <td className="px-3 py-2 data text-xs text-right text-idle">{fmtDuration(r.totalMs)}</td>
                <td className="px-3 py-2">
                  <div className="flex items-center gap-2">
                    <div className="flex-1 h-1.5 rounded-full bg-line overflow-hidden">
                      <div className="h-full rounded-full" style={{ width: `${Math.min(100, (r.totalMs / total) * 100)}%`, background: r.reason ? 'rgb(var(--c-accent, 13 148 136))' : '#94A3B8' }} />
                    </div>
                    <span className="data text-[11px] text-steel w-10 text-right">{Math.round((r.totalMs / total) * 100)}%</span>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {view === 'shift' && (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-base">
              <tr className="text-steel">
                <th className="text-left label px-3 py-2">Reason</th>
                {shifts.map((s) => <th key={s} className="text-right label px-3 py-2">{s}</th>)}
                <th className="text-right label px-3 py-2">Total</th>
              </tr>
            </thead>
            <tbody>
              {reasons.map((reason) => {
                const rowTotal = data.byReason.find((r) => r.reason === reason)?.totalMs || 0;
                return (
                  <tr key={reason || '__none'} className="border-t border-line">
                    <td className={`px-3 py-2 ${reason ? 'text-primary' : 'text-steel italic'}`}>{label(reason)}</td>
                    {shifts.map((s) => {
                      const c = cell(data.byShift, reason, (r) => r.shift === s);
                      return (
                        <td key={s} className="px-3 py-2 data text-xs text-right" title={c ? `${c.events} event${c.events === 1 ? '' : 's'}` : undefined}>
                          {c ? <>{fmtDuration(c.totalMs)}<span className="text-steel/60"> · {c.events}</span></> : <span className="text-steel/40">—</span>}
                        </td>
                      );
                    })}
                    <td className="px-3 py-2 data text-xs text-right text-idle font-semibold">{fmtDuration(rowTotal)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {view === 'hour' && (
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="bg-base">
              <tr className="text-steel">
                <th className="text-left label px-3 py-2">Reason</th>
                {hours.map((h) => <th key={h} className="label px-0.5 py-2 text-center font-normal">{String(h).padStart(2, '0')}</th>)}
              </tr>
            </thead>
            <tbody>
              {reasons.map((reason) => (
                <tr key={reason || '__none'} className="border-t border-line">
                  <td className={`px-3 py-1.5 whitespace-nowrap ${reason ? 'text-primary' : 'text-steel italic'}`}>{label(reason)}</td>
                  {hours.map((h) => {
                    const c = cell(data.byHour, reason, (r) => r.hour === h);
                    const a = c ? 0.15 + 0.85 * (c.totalMs / maxHour) : 0;
                    return (
                      <td key={h} className="px-0.5 py-1.5">
                        <div className="h-6 rounded-sm flex items-center justify-center data text-[10px]"
                          style={{ background: c ? `rgb(var(--c-accent, 13 148 136) / ${a.toFixed(2)})` : 'rgb(var(--c-line, 226 232 240) / 0.5)', color: a > 0.55 ? '#fff' : undefined }}
                          title={c ? `${String(h).padStart(2, '0')}:00 — ${fmtDuration(c.totalMs)} · ${c.events} event${c.events === 1 ? '' : 's'}` : undefined}>
                          {c ? Math.round(c.totalMs / 60000) : ''}
                        </div>
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
          <div className="text-[11px] text-steel mt-2">Minutes of downtime that <b>started</b> in each hour of the day, on the plant clock.</div>
        </div>
      )}
    </div>
  );
}
