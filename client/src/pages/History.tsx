// client/src/pages/History.tsx — full telemetry archive for one machine:
// stat bar · per-metric summary (sparkline + min/avg/max) · multi-line trends · raw log.
import { useState, useEffect, Fragment, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Download, History as HistoryIcon, BarChart3 } from 'lucide-react';
import { machineApi } from '../api/endpoints';
import { Spinner, StatusPill, FreshnessPill } from '../components/ui';
import TrendChart from '../components/TrendChart';
import Sparkline from '../components/Sparkline';
import PageHeader from '../components/PageHeader';
import { fmtTime, prettyKey, fmtNum, fmtMetric, prettyType } from '../lib/format';
import { isFault, isRegisterKey, isMetaKey } from '../lib/metrics';
import type { ApiMeta, MetricStat, MetricValue } from '../types/api';

const PAGE = 50;

export default function History() {
  const [code, setCode] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [page, setPage] = useState(1);
  const [expandedRow, setExpandedRow] = useState<string | null>(null);

  const { data: machines } = useQuery({
    queryKey: ['machines', 'list-all'],
    queryFn: () => machineApi.list({ limit: 200, sort: 'name' }).then((r) => r.data),
  });

  useEffect(() => {
    if (!machines?.length) return;
    setCode((prev) => prev || machines[0].code || machines[0].machineId || machines[0]._id || '');
  }, [machines]);

  const { data: machine } = useQuery({
    queryKey: ['machine', code],
    queryFn: () => machineApi.get(code).then((r) => r.data),
    enabled: !!code,
  });

  const { data: stats } = useQuery({
    queryKey: ['machine-stats', code],
    queryFn: () => machineApi.stats(code, { window: 200 }).then((r) => r.data),
    enabled: !!code,
  });

  const { data, isLoading, isFetching } = useQuery({
    queryKey: ['history', code, from, to, page],
    queryFn: () => machineApi.history(code, { from: from || undefined, to: to || undefined, page, limit: PAGE }),
    enabled: !!code,
  });

  const records = data?.data || [];
  const meta = data?.meta ?? ({} as ApiMeta);
  const metrics = stats?.metrics || [];
  // Raw-log columns derive from the (server-flattened) telemetry payload itself.
  const metricKeys = Object.keys(records[0]?.data || {}).slice(0, 12);
  const pageCount = Math.max(1, Math.ceil((meta.total || 0) / PAGE));

  const exportCsv = () => {
    if (!records.length) return;
    const header = ['Timestamp', ...metricKeys.map(prettyKey)].join(',');
    const rows = records.map((r) => [
      new Date(r.timestamp).toISOString(),
      ...metricKeys.map((k) => r.data?.[k] ?? ''),
    ].join(','));
    const blob = new Blob([[header, ...rows].join('\n')], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${code}_history.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div>
      <PageHeader
        title="History Log"
        subtitle="Full telemetry archive"
        right={records.length > 0 && (
          <button onClick={exportCsv} className="flex items-center gap-1.5 bg-accent/10 text-accent border border-accent/20 text-sm px-3 py-1.5 rounded-lg hover:bg-accent/20">
            <Download size={14} /> Export CSV
          </button>
        )}
      />

      <div className="px-4 sm:px-6 pb-8 space-y-5">
        {/* Filters */}
        <div className="panel p-4 grid md:grid-cols-3 gap-3">
          <div>
            <label className="label block mb-1.5">Machine</label>
            <select
              value={code}
              onChange={(e) => { setCode(e.target.value); setPage(1); }}
              className="w-full bg-base border border-line rounded-lg px-3 py-2 text-sm outline-none focus:border-accent"
            >
              <option value="">Select a machine…</option>
              {(machines || []).map((m) => (
                <option key={m.code || m._id} value={m.code || m.machineId || m._id}>
                  {String(m.code || m.machineId || m._id || '').toUpperCase()} — {prettyType(m.type || m.machineType)}{m.plant?.name ? ` (${m.plant.name})` : ''}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="label block mb-1.5">From</label>
            <input type="datetime-local" value={from} onChange={(e) => { setFrom(e.target.value); setPage(1); }}
              className="w-full bg-base border border-line rounded-lg px-3 py-2 text-sm outline-none focus:border-accent" />
          </div>
          <div>
            <label className="label block mb-1.5">To</label>
            <input type="datetime-local" value={to} onChange={(e) => { setTo(e.target.value); setPage(1); }}
              className="w-full bg-base border border-line rounded-lg px-3 py-2 text-sm outline-none focus:border-accent" />
          </div>
        </div>

        {!code ? (
          <div className="panel p-10 flex flex-col items-center gap-3 text-center">
            <div className="w-12 h-12 rounded-xl bg-accent/10 flex items-center justify-center">
              <HistoryIcon size={24} className="text-accent" />
            </div>
            <p className="text-sm text-steel">Select a machine above to browse its telemetry history</p>
          </div>
        ) : isLoading ? <Spinner /> : (
          <>
            {/* Machine stat bar */}
            {machine && (
              <div className="panel p-4 sm:p-5">
                <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3">
                  <div className="flex flex-wrap items-center gap-3 min-w-0">
                    <div className="min-w-0">
                      <h3 className="font-semibold text-primary truncate">{machine.name || code}</h3>
                      <div className="data text-[11px] text-steel truncate">{String(code).toUpperCase()}{machine.subtitle ? ` · ${machine.subtitle}` : ''}</div>
                    </div>
                    <StatusPill status={machine.status} />
                    <FreshnessPill lastSeenAt={machine.lastSeenAt} />
                  </div>
                  <div className="flex flex-wrap gap-x-6 gap-y-2">
                    <Stat label="Total Readings" value={fmtNum(machine.telemetryCount || 0)} />
                    <Stat label="Live Metrics" value={fmtNum(machine.latest?.namedCount || 0)} />
                    <Stat label="Registers" value={fmtNum(machine.registerCount || 0)} />
                    <Stat label="First Seen" value={fmtTime(machine.registeredAt)} />
                    <Stat label="Last Reading" value={fmtTime(machine.latest?.ts || machine.lastSeenAt)} />
                  </div>
                </div>
              </div>
            )}

            {/* Per-metric summary — current value + sparkline + min/avg/max */}
            {metrics.length > 0 && (
              <div className="panel p-4 sm:p-5">
                <div className="flex items-center gap-2 mb-3">
                  <BarChart3 size={15} className="text-accent" />
                  <h3 className="font-semibold text-sm text-primary flex-1">Metric Summary</h3>
                  <span className="text-[11px] text-steel">{metrics.length} metric{metrics.length === 1 ? '' : 's'} · last {fmtNum(stats?.window || 0)} readings</span>
                </div>
                <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
                  {metrics.slice(0, 12).map((m) => <MetricCard key={m.key} m={m} />)}
                </div>
              </div>
            )}

            {/* Multi-line trends (its own panel + Normalize toggle) */}
            {metrics.length > 0 && <TrendChart code={code} from={from} to={to} keys={metrics.map((m) => m.key)} />}

            {meta.total > 0 && (
              <div className="flex items-center justify-between text-xs text-steel">
                <span>{fmtNum(meta.total)} readings{from || to ? ' in range' : ' total'} — page {page} of {pageCount}</span>
                {isFetching && <span className="text-accent">Refreshing…</span>}
              </div>
            )}

            {/* Raw log — click a row to inspect the full payload */}
            <div className="panel overflow-x-auto">
              <table className="w-full text-sm whitespace-nowrap">
                <thead className="bg-base">
                  <tr className="text-steel">
                    <th className="text-left label px-4 py-3 sticky left-0 bg-base">Timestamp</th>
                    {metricKeys.map((k) => (
                      <th key={k} className="text-right label px-4 py-3">{prettyKey(k)}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {records.length === 0 ? (
                    <tr>
                      <td colSpan={metricKeys.length + 1} className="text-center text-steel py-10">No readings found for this range</td>
                    </tr>
                  ) : records.map((r) => (
                    <Fragment key={r._id}>
                      <tr
                        onClick={() => setExpandedRow(expandedRow === r._id ? null : r._id)}
                        className="border-t border-line hover:bg-base/60 cursor-pointer"
                      >
                        <td className="px-4 py-2.5 data text-xs sticky left-0 bg-surface">{fmtTime(r.timestamp)}</td>
                        {metricKeys.map((k) => (
                          <td key={k} className="px-4 py-2.5 data text-xs text-right">{fmtMetric(r.data?.[k])}</td>
                        ))}
                      </tr>
                      {expandedRow === r._id && (
                        <tr className="bg-base">
                          <td colSpan={metricKeys.length + 1} className="border-t border-line p-0">
                            <ReadingDetail data={(r.data || {}) as Record<string, MetricValue>} timestamp={r.timestamp} />
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  ))}
                </tbody>
              </table>
            </div>

            {pageCount > 1 && (
              <div className="flex items-center justify-between text-sm flex-wrap gap-2">
                <span className="text-steel">{fmtNum(meta.total)} total readings</span>
                <div className="flex items-center gap-2">
                  <button disabled={page <= 1} onClick={() => setPage((p) => p - 1)} className="px-3 py-1.5 rounded-lg bg-surface border border-line disabled:opacity-40 hover:bg-base">Prev</button>
                  <span className="px-2 py-1.5 text-steel">Page <span className="data">{page}</span> of <span className="data">{pageCount}</span></span>
                  <button disabled={page >= pageCount} onClick={() => setPage((p) => p + 1)} className="px-3 py-1.5 rounded-lg bg-surface border border-line disabled:opacity-40 hover:bg-base">Next</button>
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wide text-steel">{label}</div>
      <div className="data text-sm font-bold text-primary mt-0.5">{value}</div>
    </div>
  );
}

// Expanded-row detail: the full reading as a clean signal grid (no raw JSON).
function ReadingDetail({ data, timestamp }: { data: Record<string, MetricValue>; timestamp: string | Date }) {
  const entries = Object.entries(data).filter(([k]) => !isMetaKey(k));
  const named = entries.filter(([k]) => !isRegisterKey(k));
  const registers = entries.filter(([k]) => isRegisterKey(k));
  const status = data.status;
  const faults = entries.filter(([, v]) => isFault(v)).length;

  return (
    <div className="p-4 space-y-3 bg-base/40">
      <div className="flex items-center gap-2 flex-wrap text-xs">
        <span className="label">Reading</span>
        <span className="data text-primary">{fmtTime(timestamp)}</span>
        {status != null && <StatusPill status={String(status)} />}
        {faults > 0 && <span className="pill bg-stopped/10 text-stopped !text-[10px]">{faults} fault{faults > 1 ? 's' : ''}</span>}
        <span className="ml-auto text-steel">{entries.length} signals</span>
      </div>
      <SignalGrid title="Named signals" entries={named} />
      <SignalGrid title="Raw registers" entries={registers} muted />
    </div>
  );
}

function SignalGrid({ title, entries, muted }: { title: string; entries: [string, MetricValue][]; muted?: boolean }) {
  if (!entries.length) return null;
  return (
    <div>
      <div className="label mb-1.5">{title} <span className="text-steel/50">({entries.length})</span></div>
      <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-1.5">
        {entries.map(([k, v]) => {
          const fault = isFault(v);
          return (
            <div key={k} className={`rounded-md border px-2 py-1.5 min-w-0 ${fault ? 'border-stopped/30 bg-stopped/5' : 'border-line bg-surface'}`}>
              <div className="data text-[10px] text-steel truncate" title={prettyKey(k)}>{prettyKey(k)}</div>
              <div className={`data text-sm font-semibold truncate ${fault ? 'text-stopped' : muted ? 'text-steel' : 'text-primary'}`}>{fault ? 'FAULT' : fmtMetric(v)}</div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// One metric's snapshot over the window: current value, trend sparkline, min/avg/max.
function MetricCard({ m }: { m: MetricStat }) {
  return (
    <div className="rounded-lg border border-line bg-base p-3">
      <div className="label truncate" title={prettyKey(m.key)}>{prettyKey(m.key)}</div>
      <div className={`data text-xl font-bold mt-0.5 truncate ${m.faultCount && m.last === null ? 'text-stopped' : 'text-primary'}`}>
        {m.last === null ? (m.faultCount ? 'FAULT' : '—') : fmtMetric(m.last)}
      </div>
      {(m.spark?.length ?? 0) > 1 && <div className="mt-1.5"><Sparkline data={m.spark} width={260} height={32} /></div>}
      <div className="flex justify-between gap-1 text-[10px] text-steel mt-2 pt-2 border-t border-line">
        <span>min <span className="data text-primary/70">{fmtMetric(m.min)}</span></span>
        <span>avg <span className="data text-primary/70">{fmtMetric(m.avg)}</span></span>
        <span>max <span className="data text-primary/70">{fmtMetric(m.max)}</span></span>
      </div>
    </div>
  );
}
