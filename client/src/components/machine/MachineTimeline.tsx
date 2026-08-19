// client/src/components/machine/MachineTimeline.tsx
// Machine History — the minute-level CHANGE log: Time · Production Count ·
// Status · View parameters. One row per minute, and only minutes where the
// production counter or status actually changed (server /machines/:code/timeline
// does the bucketing + dedup, so the browser never receives telemetry spam).
// "View parameters" fetches that minute's full reading on demand.
import { useState } from 'react';
import { useQuery, keepPreviousData } from '@tanstack/react-query';
import { Download, Eye, X } from 'lucide-react';
import { machineApi } from '../../api/endpoints';
import { StatusPill, Spinner } from '../ui';
import { fmtNum, fmtMetric, fmtTime, prettyKey } from '../../lib/format';
import { isFault, isRegisterKey, isMetaKey } from '../../lib/metrics';
import type { TimelineRow, MetricValue } from '../../types/api';

export default function MachineTimeline({ code }: { code: string }): JSX.Element {
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [inspect, setInspect] = useState<TimelineRow | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ['machine-timeline', code, from, to],
    queryFn: () => machineApi.timeline(code, {
      from: from ? new Date(from).toISOString() : undefined,
      to: to ? new Date(to).toISOString() : undefined,
    }),
    refetchInterval: 30000,
    placeholderData: keepPreviousData,
  });
  const rows = data?.data || [];

  const exportCsv = () => {
    if (!rows.length) return;
    const header = 'Time,Production Count,Status';
    const lines = rows.map((r) => [new Date(r.ts).toISOString(), r.production ?? '', r.status ?? ''].join(','));
    const blob = new Blob([[header, ...lines].join('\n')], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `${code}_history.csv`; a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="space-y-4">
      {/* Range + export */}
      <div className="panel p-4 flex items-end gap-3 flex-wrap">
        <div>
          <label className="label block mb-1.5">From</label>
          <input type="datetime-local" value={from} onChange={(e) => setFrom(e.target.value)}
            className="bg-base border border-line rounded-lg px-3 py-2 text-sm outline-none focus:border-accent" />
        </div>
        <div>
          <label className="label block mb-1.5">To</label>
          <input type="datetime-local" value={to} onChange={(e) => setTo(e.target.value)}
            className="bg-base border border-line rounded-lg px-3 py-2 text-sm outline-none focus:border-accent" />
        </div>
        <button onClick={exportCsv} disabled={!rows.length}
          className="ml-auto flex items-center gap-1.5 bg-accent/10 text-accent border border-accent/20 text-sm px-3 py-2 rounded-lg hover:bg-accent/20 disabled:opacity-50">
          <Download size={14} /> Export CSV
        </button>
      </div>

      <p className="text-[11px] text-steel px-1">
        One reading per minute · unchanged minutes are hidden, so every row is a real change.
        Without a From/To range the view covers the <span className="font-medium text-primary">last 7 days</span> — pick a range for older data.
      </p>

      {/* Change log */}
      <div className="panel overflow-x-auto">
        {isLoading ? (
          <div className="p-10"><Spinner label="Loading history" /></div>
        ) : rows.length === 0 ? (
          <div className="p-10 text-center text-steel text-sm">No readings in this range.</div>
        ) : (
          <table className="w-full text-sm whitespace-nowrap">
            <thead className="bg-base">
              <tr className="text-steel">
                <th className="text-left label px-4 py-3">Time</th>
                <th className="text-right label px-4 py-3">Production Count</th>
                <th className="text-left label px-4 py-3 pl-10">Status</th>
                <th className="text-right label px-4 py-3">Action</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.ts} className="border-t border-line hover:bg-base/60">
                  <td className="px-4 py-3 data text-xs">{fmtTime(r.ts)}</td>
                  <td className="px-4 py-3 data text-sm text-right font-semibold text-primary">
                    {r.production != null ? fmtNum(r.production) : <span className="text-steel/50">—</span>}
                  </td>
                  <td className="px-4 py-3 pl-10">
                    {r.status ? <StatusPill status={r.status} /> : <span className="text-steel/50 text-xs">—</span>}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <button onClick={() => setInspect(r)}
                      className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-line text-xs text-steel hover:border-accent hover:text-accent transition-colors">
                      <Eye size={12} /> View parameters
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {inspect && <ReadingModal code={code} row={inspect} onClose={() => setInspect(null)} />}
    </div>
  );
}

// The full reading behind one timeline row — fetched on demand (the timeline
// itself stays light), rendered as the usual named/registers signal grid.
function ReadingModal({ code, row, onClose }: { code: string; row: TimelineRow; onClose: () => void }): JSX.Element {
  const ts = new Date(row.ts);
  const { data, isLoading } = useQuery({
    queryKey: ['timeline-reading', code, row.ts],
    queryFn: () => machineApi.history(code, {
      from: new Date(ts.getTime() - 60_000).toISOString(),
      to: new Date(ts.getTime() + 60_000).toISOString(),
      limit: 1,
    }),
  });
  const reading = data?.data?.[0];
  const entries = Object.entries((reading?.data || {}) as Record<string, MetricValue>).filter(([k]) => !isMetaKey(k));
  const named = entries.filter(([k]) => !isRegisterKey(k));
  const registers = entries.filter(([k]) => isRegisterKey(k));

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 backdrop-blur-sm p-4" onClick={onClose}>
      <div className="card p-5 w-full max-w-3xl max-h-[85vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-2 mb-4">
          <div className="flex-1 min-w-0">
            <h3 className="font-semibold text-sm text-primary">Parameters · {fmtTime(row.ts)}</h3>
            <div className="text-[11px] text-steel flex items-center gap-2 mt-0.5">
              {row.production != null && <span>production <span className="data font-semibold text-primary">{fmtNum(row.production)}</span></span>}
              {row.status && <StatusPill status={row.status} />}
            </div>
          </div>
          <button onClick={onClose} className="text-steel hover:text-primary transition-colors"><X size={18} /></button>
        </div>
        {isLoading ? (
          <div className="py-8"><Spinner label="Loading reading" /></div>
        ) : !reading ? (
          <div className="py-8 text-center text-steel text-sm">Reading not found for this minute.</div>
        ) : (
          <div className="space-y-4">
            <Grid title="Named signals" entries={named} />
            <Grid title="Raw registers" entries={registers} muted />
          </div>
        )}
      </div>
    </div>
  );
}

function Grid({ title, entries, muted }: { title: string; entries: [string, MetricValue][]; muted?: boolean }): JSX.Element | null {
  if (!entries.length) return null;
  return (
    <div>
      <div className="label mb-1.5">{title} <span className="text-steel/50">({entries.length})</span></div>
      <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-1.5">
        {entries.map(([k, v]) => {
          const fault = isFault(v);
          return (
            <div key={k} className={`rounded-md border px-2 py-1.5 min-w-0 ${fault ? 'border-stopped/30 bg-stopped/5' : 'border-line bg-base'}`}>
              <div className="data text-[10px] text-steel truncate" title={prettyKey(k)}>{prettyKey(k)}</div>
              <div className={`data text-sm font-semibold truncate ${fault ? 'text-stopped' : muted ? 'text-steel' : 'text-primary'}`}>{fault ? 'FAULT' : fmtMetric(v)}</div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
