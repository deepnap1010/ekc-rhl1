// client/src/components/machine/MachineParameters.tsx
// The dedicated parameter view (spec: "View Parameters") — every signal the
// machine ACTUALLY sends, live: named/analog signals, digital I/O, raw PLC
// registers. Values come from the latest payload (socket-updated), stats
// (min/avg/max + trend) from /stats. Machines expose different parameter sets —
// we render exactly what each one reports, never empty placeholder fields.
import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Cpu, Database, Power, Search, Download, Factory } from 'lucide-react';
import { machineApi } from '../../api/endpoints';
import Sparkline from '../Sparkline';
import { FreshnessPill } from '../ui';
import { fmtMetric, prettyKey } from '../../lib/format';
import { flattenReading, isFault } from '../../lib/metrics';
import { paramLabel } from '../../lib/params';
import { useMachineTelemetry } from '../../hooks/useLive';
import type { Machine, MetricStat, MetricValue } from '../../types/api';

const PROD_RE = /workpiece|production|output|piece|\bcount\b/i;

interface Row {
  key: string;
  label: string;
  value: MetricValue;
  fault: boolean;
  kind: 'Analog' | 'Digital' | 'Register';
  isProd: boolean;
  stat?: MetricStat;
}

export default function MachineParameters({ machine, code }: { machine: Machine; code: string }): JSX.Element {
  const liveT = useMachineTelemetry(code);
  const [q, setQ] = useState('');

  const { data: stats } = useQuery({
    queryKey: ['machine-stats', code],
    queryFn: () => machineApi.stats(code, { window: 200 }).then((r) => r.data),
    refetchInterval: 20000,
  });
  const statBy = useMemo(() => {
    const m = new Map<string, MetricStat>();
    for (const s of stats?.metrics || []) m.set(s.key, s);
    return m;
  }, [stats]);

  const payload = (liveT?.data || machine.latestData || machine.currentParameters || {}) as Record<string, unknown>;
  const ts = liveT?.timestamp || machine.lastSeenAt || machine.lastReadingAt;

  const rows = useMemo(() => {
    const { named, registers } = flattenReading(payload);
    const mk = (key: string, value: MetricValue, kind: Row['kind']): Row => ({
      key,
      label: kind === 'Register' ? paramLabel(key).toUpperCase() : prettyKey(paramLabel(key)),
      value,
      fault: isFault(value),
      kind,
      isProd: PROD_RE.test(paramLabel(key).toLowerCase().replace(/[._/\-]+/g, ' ')),
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
  }, [payload, statBy, q]);

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
      <div className="panel p-10 text-center text-steel text-sm">
        No parameters reported yet — this view fills in as soon as the machine sends data.
      </div>
    );
  }

  return (
    <div className="space-y-5">
      {/* Toolbar */}
      <div className="panel p-3 flex items-center gap-3 flex-wrap">
        <div className="flex items-center gap-2 flex-1 min-w-[200px] bg-base border border-line rounded-xl px-3 py-2">
          <Search size={14} className="text-steel shrink-0" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search parameters…"
            className="bg-transparent outline-none text-sm text-primary w-full" />
        </div>
        <FreshnessPill lastSeenAt={ts} />
        <span className="text-xs text-steel">{rows.total} signals</span>
        <button onClick={exportCsv}
          className="flex items-center gap-1.5 bg-accent/10 text-accent border border-accent/20 text-sm px-3 py-1.5 rounded-lg hover:bg-accent/20">
          <Download size={14} /> Export CSV
        </button>
      </div>

      <ParamGroup title="Analog & process signals" icon={Cpu} rows={rows.analog} showStats />
      <ParamGroup title="Digital I/O" icon={Power} rows={rows.digital} />
      <ParamGroup title="Raw PLC registers" icon={Database} rows={rows.registers} muted showStats />
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
              <tr key={r.key} className="border-t border-line hover:bg-base/60">
                <td className="px-4 py-2.5">
                  <span className={`${muted ? 'data text-xs text-steel' : 'text-primary'} inline-flex items-center gap-2`}>
                    {r.label}
                    {r.isProd && <span className="pill bg-running/10 text-running !text-[9px] inline-flex items-center gap-0.5"><Factory size={9} /> production</span>}
                  </span>
                </td>
                <td className={`px-4 py-2.5 data text-right font-semibold ${r.fault ? 'text-stopped' : muted ? 'text-steel' : 'text-primary'}`}>
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
