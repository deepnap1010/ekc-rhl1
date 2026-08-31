// client/src/components/machine/MachineParameters.tsx
// THE parameters module — one searchable, grouped view of every signal the
// machine sends (analog / digital I/O / raw registers), used in two modes:
//   live      — current values (socket-updated), opened from the machine page
//   snapshot  — one specific minute's reading, opened from a History row
// Always presented as a MODAL (ParametersModal); machines expose different
// parameter sets and we render exactly what each one reports.
import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Cpu, Database, Power, Search, Download, Factory, X, Clock } from 'lucide-react';
import { machineApi } from '../../api/endpoints';
import Sparkline from '../Sparkline';
import { FreshnessPill, Spinner } from '../ui';
import { fmtMetric, fmtTime, prettyKey, breachesThreshold } from '../../lib/format';
import { flattenReading, isFault } from '../../lib/metrics';
import { paramLabel } from '../../lib/params';
import { isProductionKey } from '../../lib/production';
import { useMachineTelemetry } from '../../hooks/useLive';
import type { Machine, MetricStat, MetricValue } from '../../types/api';
import { useMachineName } from '../../lib/machineName';

interface Row {
  key: string;
  label: string;
  value: MetricValue;
  fault: boolean;
  breach: boolean;               // outside the machine's configured threshold
  kind: 'Analog' | 'Digital' | 'Register';
  isProd: boolean;
  stat?: MetricStat;
}

interface Snapshot { ts: string | Date; data: Record<string, unknown> }

export function MachineParameters({ machine, code, snapshot }: { machine: Machine; code: string; snapshot?: Snapshot }): JSX.Element {
  const liveT = useMachineTelemetry(snapshot ? undefined : code);
  const [q, setQ] = useState('');

  const { data: stats } = useQuery({
    queryKey: ['machine-stats', code],
    queryFn: () => machineApi.stats(code, { window: 200 }).then((r) => r.data),
    refetchInterval: snapshot ? false : 20000,
  });
  const statBy = useMemo(() => {
    const m = new Map<string, MetricStat>();
    for (const s of stats?.metrics || []) m.set(s.key, s);
    return m;
  }, [stats]);

  // Snapshot mode pins the payload to that reading; live mode prefers the
  // socket, then the machine doc, then the normalized contract arrays (mirror
  // docs return metrics/inputs/outputs/registers instead of latestData).
  const payload = useMemo(() => {
    if (snapshot) return snapshot.data;
    const raw = (liveT?.data || machine.latestData || machine.currentParameters || machine.liveParameters || {}) as Record<string, unknown>;
    if (Object.keys(raw).length) return raw;
    const out: Record<string, unknown> = {};
    for (const m of machine.metrics || []) out[m.key] = m.value;
    for (const io of machine.inputs || []) out[io.key] = io.on ? 1 : 0;
    for (const io of machine.outputs || []) out[io.key] = io.on ? 1 : 0;
    for (const r of machine.registers || []) out[r.key] = r.value;
    return out;
  }, [snapshot, liveT, machine]);
  const ts = snapshot ? snapshot.ts : (liveT?.timestamp || machine.lastSeenAt || machine.lastReadingAt);

  const rows = useMemo(() => {
    const thresholds = machine.thresholds || {};
    const { named, registers } = flattenReading(payload as Record<string, unknown>);
    const mk = (key: string, value: MetricValue, kind: Row['kind']): Row => ({
      key,
      label: kind === 'Register' ? paramLabel(key).toUpperCase() : prettyKey(paramLabel(key)),
      value,
      fault: isFault(value),
      breach: breachesThreshold(key, value, thresholds),
      kind,
      isProd: isProductionKey(key),
      stat: statBy.get(key),
    });
    const namedRows: Row[] = Object.entries(named)
      .filter(([k]) => k.toLowerCase() !== 'status')
      .map(([k, v]) => mk(k, v, (v === 0 || v === 1) && Number.isInteger(Number(v)) ? 'Digital' : 'Analog'));
    const regRows: Row[] = Object.entries(registers).map(([k, v]) => mk(k, v, 'Register'));
    const ql = q.trim().toLowerCase();
    const match = (r: Row) => !ql || r.label.toLowerCase().includes(ql) || r.key.toLowerCase().includes(ql);
    return {
      analog: namedRows.filter((r) => r.kind === 'Analog' && match(r)),
      digital: namedRows.filter((r) => r.kind === 'Digital' && match(r)),
      registers: regRows.filter(match),
      total: namedRows.length + regRows.length,
    };
  }, [payload, statBy, q, machine]);

  const exportCsv = () => {
    const all = [...rows.analog, ...rows.digital, ...rows.registers];
    if (!all.length) return;
    const header = 'Parameter,Key,Type,Value,Min,Avg,Max';
    const lines = all.map((r) => [
      `"${r.label}"`, r.key, r.kind, r.fault ? 'FAULT' : r.value ?? '',
      r.stat?.min ?? '', r.stat?.avg ?? '', r.stat?.max ?? '',
    ].join(','));
    const blob = new Blob([[header, ...lines].join('\n')], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `${code}_parameters.csv`; a.click();
    URL.revokeObjectURL(url);
  };

  if (!rows.total) {
    return (
      <div className="p-10 text-center text-steel text-sm">
        {snapshot ? 'This reading carries no parameters.' : 'No parameters reported yet — this view fills in as soon as the machine sends data.'}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Toolbar — search-by-filter + freshness/snapshot time + CSV */}
      <div className="flex items-center gap-3 flex-wrap">
        <div className="flex items-center gap-2 flex-1 min-w-[180px] bg-base border border-line rounded-xl px-3 py-2">
          <Search size={14} className="text-steel shrink-0" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search parameters…"
            className="bg-transparent outline-none text-sm text-primary w-full" autoFocus />
        </div>
        {snapshot
          ? <span className="inline-flex items-center gap-1.5 pill bg-accent/10 text-accent !text-[10px]"><Clock size={11} /> {fmtTime(snapshot.ts)}</span>
          : <FreshnessPill lastSeenAt={ts} />}
        <span className="text-xs text-steel">{rows.total} signals</span>
        <button onClick={exportCsv}
          className="flex items-center gap-1.5 bg-accent/10 text-accent border border-accent/20 text-sm px-3 py-1.5 rounded-lg hover:bg-accent/20">
          <Download size={14} /> CSV
        </button>
      </div>

      <ParamGroup title="Analog & process signals" icon={Cpu} rows={rows.analog} showStats={!snapshot} />
      <ParamGroup title="Digital I/O" icon={Power} rows={rows.digital} />
      <ParamGroup title="Raw PLC registers" icon={Database} rows={rows.registers} muted showStats={!snapshot} />
    </div>
  );
}

// The modal shell. `at` set → fetch that minute's reading (snapshot mode);
// omitted → live parameters.
export default function ParametersModal({ machine, code, at, onClose }: { machine: Machine; code: string; at?: string; onClose: () => void }): JSX.Element {
  const mName = useMachineName();
  const ts = at ? new Date(at) : null;
  const { data, isLoading } = useQuery({
    queryKey: ['timeline-reading', code, at],
    // Window ENDS at the row's timestamp — history returns newest-first, so a
    // window past ts would fetch the NEXT minute's reading, not this row's.
    queryFn: () => machineApi.history(code, {
      from: new Date((ts as Date).getTime() - 1000).toISOString(),
      to: new Date((ts as Date).getTime()).toISOString(),
      limit: 1,
    }),
    enabled: !!at,
  });
  const reading = data?.data?.[0];
  const snapshot = at
    ? (reading ? { ts: reading.timestamp, data: (reading.data || {}) as Record<string, unknown> } : null)
    : undefined;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 backdrop-blur-sm p-4" onClick={onClose}>
      <div className="card p-5 w-full max-w-4xl max-h-[85vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-2 mb-4">
          <div className="flex-1 min-w-0">
            <h3 className="font-semibold text-sm text-primary truncate">
              {mName(String(machine.code || machine.machineId || code))} · Parameters{at ? ' — snapshot' : ' — live'}
            </h3>
          </div>
          <button onClick={onClose} className="text-steel hover:text-primary transition-colors shrink-0"><X size={18} /></button>
        </div>
        {at && isLoading ? (
          <div className="py-10"><Spinner label="Loading reading" /></div>
        ) : at && !snapshot ? (
          <div className="py-10 text-center text-steel text-sm">Reading not found for this minute.</div>
        ) : (
          <MachineParameters machine={machine} code={code} snapshot={snapshot || undefined} />
        )}
      </div>
    </div>
  );
}

function ParamGroup({ title, icon: Icon, rows, muted, showStats }: {
  title: string; icon: typeof Cpu; rows: Row[]; muted?: boolean; showStats?: boolean;
}): JSX.Element | null {
  if (!rows.length) return null;
  return (
    <div className="panel overflow-hidden">
      <div className="flex items-center gap-2 px-4 sm:px-5 pt-4 pb-3">
        <span className="w-7 h-7 rounded-lg bg-accent/10 flex items-center justify-center"><Icon size={15} className="text-accent" /></span>
        <h3 className="font-semibold text-sm text-primary flex-1">{title}</h3>
        <span className="text-[11px] text-steel">{rows.length} signal{rows.length === 1 ? '' : 's'}</span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm whitespace-nowrap">
          <thead className="bg-base">
            <tr className="text-steel">
              <th className="text-left label px-4 py-2.5">Parameter</th>
              <th className="text-right label px-4 py-2.5">Value</th>
              {showStats && <th className="text-right label px-4 py-2.5 hidden sm:table-cell">Min</th>}
              {showStats && <th className="text-right label px-4 py-2.5 hidden sm:table-cell">Avg</th>}
              {showStats && <th className="text-right label px-4 py-2.5 hidden sm:table-cell">Max</th>}
              {showStats && <th className="text-right label px-4 py-2.5 hidden md:table-cell">Trend</th>}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.key} className={`border-t border-line hover:bg-base/60 ${r.breach ? 'bg-stopped/5' : ''}`}>
                <td className="px-4 py-2.5">
                  <span className={`${muted ? 'data text-xs text-steel' : 'text-primary'} inline-flex items-center gap-2`}>
                    {r.label}
                    {r.isProd && <span className="pill bg-running/10 text-running !text-[9px] inline-flex items-center gap-0.5"><Factory size={9} /> production</span>}
                    {r.breach && <span className="pill bg-stopped/10 text-stopped !text-[9px]">threshold</span>}
                  </span>
                </td>
                <td className={`px-4 py-2.5 data text-right font-semibold ${r.fault || r.breach ? 'text-stopped' : muted ? 'text-steel' : 'text-primary'}`}>
                  {r.fault ? 'FAULT' : fmtMetric(r.value)}
                </td>
                {showStats && <td className="px-4 py-2.5 data text-xs text-right text-steel hidden sm:table-cell">{r.stat ? fmtMetric(r.stat.min) : '—'}</td>}
                {showStats && <td className="px-4 py-2.5 data text-xs text-right text-steel hidden sm:table-cell">{r.stat ? fmtMetric(r.stat.avg) : '—'}</td>}
                {showStats && <td className="px-4 py-2.5 data text-xs text-right text-steel hidden sm:table-cell">{r.stat ? fmtMetric(r.stat.max) : '—'}</td>}
                {showStats && (
                  <td className="px-4 py-2.5 hidden md:table-cell">
                    <div className="flex justify-end">
                      {r.stat && (r.stat.spark?.length ?? 0) > 1
                        ? <Sparkline data={r.stat.spark} width={110} height={24} />
                        : <span className="text-steel/40 text-xs">—</span>}
                    </div>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
