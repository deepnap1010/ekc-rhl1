// client/src/components/TargetsReport.tsx — Reports → Targets tab.
// Target-vs-actual by production day or hour, DIA rollup cards on top, and a
// "subtract downtime" toggle that switches every figure between the plain
// target (assigned time ÷ processing time) and the downtime-adjusted one —
// both come from the server per row, so the toggle is a view, not a refetch.
import { useEffect, useState } from 'react';
import { useQuery, useQueryClient, keepPreviousData } from '@tanstack/react-query';
import { Download, Target } from 'lucide-react';
import { productionApi } from '../api/endpoints';
import { Spinner } from './ui';
import Pager, { DEFAULT_PAGE_SIZE } from './Pager';
import { fmtNum, fmtTime, fmtDate, fmtDuration } from '../lib/format';
import { fmtTarget } from '../lib/targets';
import type { TargetRow, TargetsMeta } from '../types/api';

const pct = (actual: number, target: number): number | null =>
  target > 0.01 ? Math.round((actual / target) * 1000) / 10 : null;
const pctColor = (p: number | null): string => (p == null ? '#94A3B8' : p < 60 ? '#D97706' : '#0D9488');

export default function TargetsReport({ machineId, from, to }: {
  machineId?: string; from?: string; to?: string;   // win.fromISO can be undefined for a beat
}): JSX.Element {
  if (!from || !to) return <Spinner />;
  return <TargetsReportInner machineId={machineId} from={from} to={to} />;
}

function TargetsReportInner({ machineId, from, to }: {
  machineId?: string; from: string; to: string;
}): JSX.Element {
  const qc = useQueryClient();
  const [groupBy, setGroupBy] = useState<'day' | 'hour'>('day');
  const [adjust, setAdjust] = useState(false);
  const [page, setPage] = useState(1);
  const [size, setSize] = useState(DEFAULT_PAGE_SIZE);
  useEffect(() => { setPage(1); }, [machineId, from, to, groupBy]);

  const params = { from, to, machineId: machineId || undefined, groupBy };
  const pageQ = (p: number) => ({
    queryKey: ['targets-report', machineId, from, to, groupBy, size, p],
    queryFn: () => productionApi.targets({ ...params, page: p, limit: size }),
  });
  const { data, isLoading, isFetching } = useQuery({
    ...pageQ(page),
    refetchInterval: 60_000,
    placeholderData: keepPreviousData,
  });
  const rows: TargetRow[] = data?.data || [];
  const meta = data?.meta as TargetsMeta | undefined;
  const pageCount = Math.max(1, Math.ceil((meta?.total || 0) / size));
  useEffect(() => {
    if (page < pageCount) qc.prefetchQuery({ ...pageQ(page + 1), staleTime: 30_000 });
  }, [machineId, from, to, groupBy, size, page, pageCount]);

  const tOf = (r: { target: number; targetAdj: number }): number => (adjust ? r.targetAdj : r.target);

  const [exporting, setExporting] = useState(false);
  const exportCsv = async () => {
    setExporting(true);
    try {
      const all = await productionApi.targets({ ...params, page: 1, limit: 2000 }).then((r) => r.data);
      const header = 'Bucket,Machine,DIA,Stage,Assigned (s),Downtime (s),Target,Target (downtime-adjusted),Actual,Achievement (%)';
      const lines = (all || []).map((r) => [
        r.bucket, r.machineRef, r.dia, r.stage, Math.round(r.assignedSec), Math.round(r.downtimeSec),
        r.target.toFixed(2), r.targetAdj.toFixed(2), r.actual,
        pct(r.actual, tOf(r))?.toFixed(1) ?? '',
      ].join(','));
      const blob = new Blob([[header, ...lines].join('\n')], { type: 'text/csv' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = `targets_${groupBy}.csv`; a.click();
      URL.revokeObjectURL(url);
    } finally { setExporting(false); }
  };

  if (isLoading) return <Spinner />;

  const totals = meta?.totals;
  const noData = !rows.length && !(meta?.byDia || []).length;

  return (
    <div className="space-y-5">
      {noData ? (
        <div className="panel p-10 text-center">
          <Target size={28} className="mx-auto text-steel mb-3" />
          <p className="text-sm text-steel max-w-md mx-auto">
            No machine had a DIA assignment in this window. Assign a DIA to a machine
            (its card or its Configure tab) and its target-vs-actual lands here.
          </p>
        </div>
      ) : (
        <>
          {/* DIA rollup cards — the whole window, whatever page the table shows */}
          <div className="grid sm:grid-cols-2 xl:grid-cols-3 gap-4">
            {totals && (
              <div className="panel p-5">
                <div className="flex items-center justify-between mb-1">
                  <h3 className="font-semibold text-sm">All DIA</h3>
                  <span className="label">{meta?.machines || 0} machines</span>
                </div>
                <RollupBody target={adjust ? totals.targetAdj : totals.target} actual={totals.actual} downtimeSec={totals.downtimeSec} />
              </div>
            )}
            {(meta?.byDia || []).map((d) => (
              <div key={d.dia} className="panel p-5">
                <div className="flex items-center justify-between mb-1">
                  <h3 className="font-semibold text-sm truncate">{d.dia}{d.dims ? <span className="text-steel font-normal"> · {d.dims}</span> : null}</h3>
                  <span className="label shrink-0">{d.machines} machine{d.machines === 1 ? '' : 's'}</span>
                </div>
                <RollupBody target={adjust ? d.targetAdj : d.target} actual={d.actual} downtimeSec={d.downtimeSec} />
              </div>
            ))}
          </div>

          {/* Controls */}
          <div className="panel p-3 flex items-center gap-3 flex-wrap text-xs">
            <div className="flex gap-1 bg-base rounded-lg p-0.5 border border-line">
              {(['day', 'hour'] as const).map((g) => (
                <button key={g} onClick={() => setGroupBy(g)}
                  className={`px-3 py-1.5 rounded-md capitalize transition-colors ${groupBy === g ? 'bg-accent/15 text-accent' : 'text-steel hover:bg-white/5'}`}>
                  By {g}
                </button>
              ))}
            </div>
            <label className="flex items-center gap-1.5 cursor-pointer select-none" title="Target counts only the time the machine was not idle/stopped/offline">
              <input type="checkbox" checked={adjust} onChange={(e) => setAdjust(e.target.checked)} className="accent-[#0D9488]" />
              <span className="text-steel">Subtract downtime from targets</span>
            </label>
            <span className="ml-auto flex items-center gap-3">
              {isFetching && <span className="text-accent">Refreshing…</span>}
              <button onClick={exportCsv} disabled={exporting}
                className="flex items-center gap-1.5 bg-accent/10 text-accent border border-accent/20 px-3 py-1.5 rounded-lg hover:bg-accent/20 disabled:opacity-50">
                <Download size={13} /> {exporting ? 'Preparing…' : 'Export CSV'}
              </button>
            </span>
          </div>

          {/* Rows */}
          <div className="panel overflow-x-auto">
            <table className="w-full text-sm whitespace-nowrap">
              <thead className="bg-base">
                <tr className="text-steel">
                  <th className="text-left label px-4 py-2.5">{groupBy === 'day' ? 'Day' : 'Hour'}</th>
                  <th className="text-left label px-4 py-2.5">Machine</th>
                  <th className="text-left label px-4 py-2.5">DIA · Stage</th>
                  <th className="text-right label px-4 py-2.5">Target</th>
                  <th className="text-right label px-4 py-2.5">Actual</th>
                  <th className="text-right label px-4 py-2.5">Achievement</th>
                  <th className="text-right label px-4 py-2.5">Downtime</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => {
                  const t = tOf(r);
                  const p = pct(r.actual, t);
                  return (
                    <tr key={`${r.bucket}-${r.machineRef}-${i}`} className="border-t border-line hover:bg-base/60">
                      <td className="px-4 py-2.5 data text-xs">{groupBy === 'day' ? fmtDate(r.bucket) : fmtTime(r.bucket)}</td>
                      <td className="px-4 py-2.5 data text-xs font-medium">{r.machineRef}</td>
                      <td className="px-4 py-2.5 text-xs text-steel">{r.dia} · {r.stage}</td>
                      <td className="px-4 py-2.5 data text-xs text-right">{fmtTarget(t)}</td>
                      <td className="px-4 py-2.5 data text-xs text-right font-semibold">{fmtNum(r.actual)}</td>
                      <td className="px-4 py-2.5 data text-xs text-right font-semibold" style={{ color: pctColor(p) }}>
                        {p != null ? `${p.toFixed(1)}%` : '—'}
                      </td>
                      <td className="px-4 py-2.5 data text-xs text-right text-steel">{r.downtimeSec >= 30 ? fmtDuration(r.downtimeSec * 1000) : '—'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {(meta?.total || 0) > 0 && (
            <Pager page={page} size={size} onPage={setPage} onSize={setSize}
              total={meta?.total} loading={isFetching && !isLoading} noun="rows" />
          )}
        </>
      )}
    </div>
  );
}

function RollupBody({ target, actual, downtimeSec }: { target: number; actual: number; downtimeSec: number }): JSX.Element {
  const p = pct(actual, target);
  return (
    <div>
      <div className="flex items-baseline gap-1.5 mt-2">
        <span className="data text-2xl font-bold text-primary">{fmtNum(actual)}</span>
        <span className="text-steel text-xs">of</span>
        <span className="data text-2xl font-bold text-accent">{fmtTarget(target)}</span>
        {p != null && <span className="data text-sm font-semibold ml-auto" style={{ color: pctColor(p) }}>{p.toFixed(1)}%</span>}
      </div>
      <div className="h-1.5 bg-line rounded-full overflow-hidden mt-2">
        <div className="h-full rounded-full" style={{ width: `${Math.min(p ?? 0, 100)}%`, background: pctColor(p) }} />
      </div>
      {downtimeSec >= 60 && <div className="text-[10px] text-steel mt-1.5">{fmtDuration(downtimeSec * 1000)} downtime in this window</div>}
    </div>
  );
}
