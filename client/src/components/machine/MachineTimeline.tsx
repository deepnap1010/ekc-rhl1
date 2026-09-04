// client/src/components/machine/MachineTimeline.tsx
// Machine History — the minute-level CHANGE log: Time · Production Count ·
// Status · View parameters. One row per minute, and only minutes where the
// production counter or status actually changed (server /machines/:code/timeline
// does the bucketing + dedup, so the browser never receives telemetry spam).
// "View parameters" opens the shared, searchable parameters module scoped to
// that minute's reading.
import { useState, useEffect } from 'react';
import { useQuery, keepPreviousData, useQueryClient } from '@tanstack/react-query';
import { Download, Eye } from 'lucide-react';
import { machineApi } from '../../api/endpoints';
import { StatusPill, Spinner } from '../ui';
import ParametersModal from './MachineParameters';
import RangeFilter from '../RangeFilter';
import Pager, { DEFAULT_PAGE_SIZE } from '../Pager';
import { useRangeFilter } from '../../hooks/useRangeFilter';
import { fmtNum, fmtTime } from '../../lib/format';
import type { Machine, TimelineRow } from '../../types/api';

export default function MachineTimeline({ machine, code }: { machine: Machine; code: string }): JSX.Element {
  // The same window control as the dashboard, history log and downtime archive —
  // presets plus the custom date+time popup — instead of two bare datetime boxes
  // that only this page had.
  const win = useRangeFilter('week');
  const from = win.fromISO;
  const to = win.toISO;
  const [page, setPage] = useState(1);
  const [size, setSize] = useState(DEFAULT_PAGE_SIZE);
  const [inspectAt, setInspectAt] = useState<string | null>(null);
  const qc = useQueryClient();

  // A new window starts at page 1 — page 7 of the last range means nothing here.
  useEffect(() => { setPage(1); }, [from, to, code]);

  const timelinePage = (p: number) => ({
    queryKey: ['machine-timeline', code, from, to, size, p],
    queryFn: () => machineApi.timeline(code, { from, to, page: p, limit: size }),
  });
  const { data, isLoading, isFetching } = useQuery({
    ...timelinePage(page),
    refetchInterval: 30000,
    placeholderData: keepPreviousData,
  });
  const rows: TimelineRow[] = data?.data || [];
  // A minute holding more readings than a machine can physically produce is a
  // collector REPLAY: on reconnect it flushes its buffer stamped with the current
  // time, so hours of history land in minutes. The counter column already shows
  // each minute's highest value so it stays truthful, but the reader still
  // deserves to know why a chunk of time is missing above those rows.
  const meta = data?.meta as {
    replayMinutes?: number; productionKey?: string | null; total?: number; capped?: boolean;
  } | undefined;
  const replayMinutes = meta?.replayMinutes || 0;
  const total = meta?.total || 0;
  const pageCount = Math.max(1, Math.ceil(total / size));

  // Warm the next page while this one is being read.
  useEffect(() => {
    if (page < pageCount) qc.prefetchQuery({ ...timelinePage(page + 1), staleTime: 30_000 });
  }, [code, from, to, size, page, pageCount]);
  // No counter + a status that never changes = a change log with nothing to
  // show. BOTTOMMILLING04 sends 74,642 readings that all say "running" and no
  // production signal at all, which collapsed a whole week into a single row
  // dated three days ago — technically a change, practically a bug report.
  const noCounter = !isLoading && meta != null && !meta.productionKey;

  // The CSV covers the window, not the page on screen — a 25-row export from a
  // 4,000-change range would be a trap. Capped at the endpoint's 2,000.
  const [exporting, setExporting] = useState(false);
  const exportCsv = async () => {
    if (!rows.length) return;
    setExporting(true);
    const full = await machineApi.timeline(code, { from, to, page: 1, limit: 2000 })
      .then((r) => r.data)
      .catch(() => rows)
      .finally(() => setExporting(false));
    const header = 'Time,Produced (window),Made,Counter,Status';
    const lines = full.map((r) => [new Date(r.ts).toISOString(), r.total ?? '', r.made ?? '', r.production ?? '', r.status ?? ''].join(','));
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
          <label className="label block mb-1.5">Window</label>
          <RangeFilter value={win.value} onChange={win.setValue} range={win.range}
            title="Which period this history covers" />
        </div>
        <button onClick={exportCsv} disabled={!rows.length || exporting}
          className="ml-auto flex items-center gap-1.5 bg-accent/10 text-accent border border-accent/20 text-sm px-3 py-2 rounded-lg hover:bg-accent/20 disabled:opacity-50">
          <Download size={14} /> {exporting ? 'Preparing…' : 'Export CSV'}
        </button>
      </div>

      <p className="text-[11px] text-steel px-1">
        One reading per minute · a row appears when the count <em>or the status</em> changes, so a
        row with no <span className="text-accent font-medium">+n</span> is a status change, not a
        missing piece. Unchanged minutes are hidden.
        {meta?.capped ? ' Showing the most recent 20,000 changes in this window.' : ''}
      </p>

      {noCounter && (
        <p className="text-[11px] text-steel bg-base border border-line rounded-lg px-3 py-2">
          This machine reports <span className="font-semibold text-primary">no production counter</span>, so the log below tracks
          status changes only{rows.length <= 1 ? ' — and its status has not changed in this range' : ''}. Use
          <span className="font-medium text-primary"> View parameters</span> to see what it does send.
        </p>
      )}

      {replayMinutes > 0 && (
        <p className="text-[11px] text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
          <span className="font-semibold">{replayMinutes} minute{replayMinutes === 1 ? '' : 's'}</span> in this range hold far more
          readings than this machine normally sends — usually a collector that reconnected and flushed a buffered batch stamped
          with the current time, so those pieces were really made earlier. Produced still counts each confirmed step once, and
          Counter shows the minute's highest value, so both stay correct — only the timing of those rows is approximate.
        </p>
      )}

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
                {/* The window's own arithmetic leads — 0 up to the card's total.
                    The machine's raw counter stays visible but steps aside: it
                    is a lifetime number on its own reset schedule, and 1,102
                    answers no question that "17 so far today" is asking. */}
                <th className="text-right label px-4 py-3">Produced</th>
                <th className="text-right label px-4 py-3">Counter</th>
                <th className="text-left label px-4 py-3 pl-10">Status</th>
                <th className="text-right label px-4 py-3">Action</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.ts} className="border-t border-line hover:bg-base/60">
                  <td className="px-4 py-3 data text-xs">{fmtTime(r.ts)}</td>
                  <td className="px-4 py-3 data text-sm text-right font-semibold text-primary">
                    {/* A machine that reports no counter has nothing to total. It
                        used to print a confident "0" on every row while the note
                        above said the log tracks status only. */}
                    {noCounter ? <span className="text-steel/50">—</span> : fmtNum(r.total)}
                    {r.made > 0 && <span className="text-accent text-xs font-medium ml-1.5">+{r.made}</span>}
                  </td>
                  <td className="px-4 py-3 data text-xs text-right text-steel/70">
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

      {total > 0 && (
        <Pager page={page} size={size} onPage={setPage} onSize={setSize}
          total={total} loading={isFetching && !isLoading} noun="changes" />
      )}

      {inspectAt && (
        <ParametersModal machine={machine} code={code} at={inspectAt} onClose={() => setInspectAt(null)} />
      )}
    </div>
  );
}
