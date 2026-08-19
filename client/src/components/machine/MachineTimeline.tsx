// client/src/components/machine/MachineTimeline.tsx
// Machine History — the minute-level CHANGE log: Time · Production Count ·
// Status · View parameters. One row per minute, and only minutes where the
// production counter or status actually changed (server /machines/:code/timeline
// does the bucketing + dedup, so the browser never receives telemetry spam).
// "View parameters" opens the shared, searchable parameters module scoped to
// that minute's reading.
import { useState } from 'react';
import { useQuery, keepPreviousData } from '@tanstack/react-query';
import { Download, Eye } from 'lucide-react';
import { machineApi } from '../../api/endpoints';
import { StatusPill, Spinner } from '../ui';
import ParametersModal from './MachineParameters';
import { fmtNum, fmtTime } from '../../lib/format';
import type { Machine, TimelineRow } from '../../types/api';

export default function MachineTimeline({ machine, code }: { machine: Machine; code: string }): JSX.Element {
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [inspectAt, setInspectAt] = useState<string | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ['machine-timeline', code, from, to],
    queryFn: () => machineApi.timeline(code, {
      from: from ? new Date(from).toISOString() : undefined,
      to: to ? new Date(to).toISOString() : undefined,
    }),
    refetchInterval: 30000,
    placeholderData: keepPreviousData,
  });
  const rows: TimelineRow[] = data?.data || [];

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
                    <button onClick={() => setInspectAt(r.ts)}
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

      {inspectAt && (
        <ParametersModal machine={machine} code={code} at={inspectAt} onClose={() => setInspectAt(null)} />
      )}
    </div>
  );
}
