// client/src/pages/History.tsx
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Download, History as HistoryIcon } from 'lucide-react';
import { machineApi } from '../api/endpoints';
import { Spinner } from '../components/ui';
import PageHeader from '../components/PageHeader';
import { fmtTime, prettyKey, fmtNum, fmtMetric, prettyType } from '../lib/format';
import type { ApiMeta } from '../types/api';

export default function History() {
  const [code, setCode] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [page, setPage] = useState(1);

  const { data: machines } = useQuery({
    queryKey: ['machines', 'list-all'],
    queryFn: () => machineApi.list({ limit: 200, sort: 'name' }).then((r) => r.data),
  });

  const { data, isLoading, isFetching } = useQuery({
    queryKey: ['history', code, from, to, page],
    queryFn: () => machineApi.history(code, { from: from || undefined, to: to || undefined, page, limit: 50 }),
    enabled: !!code,
    refetchInterval: 0,
  });

  const records = data?.data || [];
  const meta = data?.meta ?? ({} as ApiMeta);
  // Columns derive from the telemetry payload itself (varies by machine type).
  const metricKeys = Object.keys(records[0]?.data || {}).slice(0, 12);

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

      <div className="px-6 pb-8 space-y-5">
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
            {meta.total > 0 && (
              <div className="flex items-center justify-between text-xs text-steel">
                <span>{fmtNum(meta.total)} readings{from || to ? ' in range' : ' total'} — page {page}</span>
                {isFetching && <span className="text-accent">Refreshing…</span>}
              </div>
            )}

            <div className="panel overflow-x-auto">
              <table className="w-full text-sm whitespace-nowrap">
                <thead className="bg-base">
                  <tr className="text-steel">
                    <th className="text-left label px-4 py-3">Timestamp</th>
                    {metricKeys.map((k) => (
                      <th key={k} className="text-left label px-4 py-3">{prettyKey(k)}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {records.length === 0 ? (
                    <tr>
                      <td colSpan={13} className="text-center text-steel py-10">No readings found for this range</td>
                    </tr>
                  ) : records.map((r) => (
                    <tr key={r._id} className="border-t border-line hover:bg-white/5">
                      <td className="px-4 py-2.5 data text-xs">{fmtTime(r.timestamp)}</td>
                      {metricKeys.map((k) => (
                        <td key={k} className="px-4 py-2.5 data text-xs">{fmtMetric(r.data?.[k])}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {meta.total > 50 && (
              <div className="flex items-center justify-between text-sm">
                <span className="text-steel">{fmtNum(meta.total)} total readings</span>
                <div className="flex gap-2">
                  <button disabled={page === 1} onClick={() => setPage(page - 1)} className="px-3 py-1.5 rounded-lg bg-surface border border-line disabled:opacity-40 hover:bg-white/5">Prev</button>
                  <span className="px-3 py-1.5 text-steel">Page {page}</span>
                  <button disabled={page * 50 >= meta.total} onClick={() => setPage(page + 1)} className="px-3 py-1.5 rounded-lg bg-surface border border-line disabled:opacity-40 hover:bg-white/5">Next</button>
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
