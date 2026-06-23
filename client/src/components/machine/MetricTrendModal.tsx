// client/src/components/machine/MetricTrendModal.tsx
// Drill-down for a metric tile on the machine Overview. Opens a real trend graph
// + evaluated stats (last/min/max/avg/samples/faults) for the clicked signal, or a
// multi-line compare when several keys are passed (e.g. all temperature zones).
//
// The graph plots the machine's real /history readings on a TIME x-axis, resolving
// each key with flattenReading (the same extractor the History tab uses — so it
// matches the displayed tile for flat AND nested machines). While history loads (or
// if a key has no history series) it falls back to the MetricStat.spark by sample
// index. Stat tiles come from the already-fetched /stats. Real data only; never written.
import { useMemo, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  AreaChart, Area, LineChart, Line, XAxis, YAxis, Tooltip, CartesianGrid, ResponsiveContainer, Legend,
} from 'recharts';
import { TrendingUp, ArrowRight } from 'lucide-react';
import Modal from '../Modal';
import { machineApi } from '../../api/endpoints';
import { fmtMetric, fmtNum, prettyKey } from '../../lib/format';
import { flattenReading, isNumeric, isFault } from '../../lib/metrics';
import type { MetricStat } from '../../types/api';

const COLORS = ['#0D9488', '#6366F1', '#EC4899', '#D97706', '#3B82F6', '#8B5CF6', '#10B981', '#F43F5E'];

export interface DrillEntry { key: string; label: string; stat?: MetricStat; }

interface Props {
  machineId: string;
  machineTitle: string;
  title: string;
  unit?: string;
  entries: DrillEntry[];
  onClose: () => void;
  onOpenHistory?: () => void;
}

type ChartRow = Record<string, number | null>;

export default function MetricTrendModal({ machineId, machineTitle, title, unit, entries, onClose, onOpenHistory }: Props): JSX.Element {
  const multi = entries.length > 1;
  const single = entries.length === 1 ? entries[0] : null;
  const singleKey = single?.key ?? '';
  const st = single?.stat;
  const u = unit ? unit : '';
  const fmtV = (v: number | null | undefined): string => (v === null || v === undefined || !Number.isFinite(Number(v)) ? '—' : `${fmtMetric(v)}${u}`);

  // Real readings on a time axis — resolve each key with flattenReading (matches the tiles).
  const { data: hist, isLoading } = useQuery({
    queryKey: ['metric-trend-history', machineId],
    queryFn: () => machineApi.history(machineId, { page: 1, limit: 200 }).then((r) => r.data),
    enabled: !!machineId,
    refetchInterval: 15000,
  });

  const timeData = useMemo<ChartRow[]>(() => {
    const rows = [...(hist || [])].reverse(); // API returns newest-first → chronological
    return rows.map((r) => {
      const flat = flattenReading((r.data || {}) as Record<string, unknown>).named;
      const o: ChartRow = { t: new Date(r.timestamp).getTime() };
      for (const e of entries) {
        const v = flat[e.key];
        o[e.key] = isNumeric(v) && !isFault(v) ? Number(v) : null;
      }
      return o;
    });
  }, [hist, entries]);

  const hasTimeSeries = timeData.length >= 2 && entries.some((e) => timeData.some((r) => r[e.key] != null));

  // Fallback: MetricStat.spark by sample index (instant, while history loads).
  const sparkData = useMemo<ChartRow[]>(() => {
    const maxLen = Math.max(0, ...entries.map((e) => e.stat?.spark?.length || 0));
    return Array.from({ length: maxLen }, (_, i) => {
      const row: ChartRow = { t: i };
      entries.forEach((e) => {
        const s = e.stat?.spark;
        const v = s && i < s.length ? Number(s[i]) : NaN;
        row[e.key] = Number.isFinite(v) ? v : null;
      });
      return row;
    });
  }, [entries]);

  const timeAxis = hasTimeSeries;
  const chartData = hasTimeSeries ? timeData : sparkData;
  const plottable = chartData.length >= 2 && entries.some((e) => chartData.some((r) => r[e.key] != null));

  const fmtTs = (t: number): string => new Date(t).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });

  return (
    <Modal title={title} subtitle={machineTitle} icon={TrendingUp} onClose={onClose} maxW="max-w-3xl">
      {/* Evaluated stats — single metric */}
      {single && st && (
        <div className="grid grid-cols-3 sm:grid-cols-6 gap-2 mb-4">
          <StatTile label="Current" value={fmtV(st.last)} accent="#0D9488" big />
          <StatTile label="Average" value={fmtV(st.avg)} accent="#2563EB" />
          <StatTile label="Minimum" value={fmtV(st.min)} accent="#0D9488" />
          <StatTile label="Maximum" value={fmtV(st.max)} accent="#DC2626" />
          <StatTile label="Samples" value={fmtNum(st.samples)} accent="#64748B" />
          <StatTile label="Faults" value={fmtNum(st.faultCount)} accent={st.faultCount ? '#DC2626' : '#059669'} />
        </div>
      )}

      {/* Trend graph */}
      <div className="rounded-lg border border-line bg-base p-4">
        <div className="flex items-center justify-between mb-3">
          <span className="label flex items-center gap-1.5"><TrendingUp size={13} className="text-accent" /> {multi ? `${entries.length} signals` : 'Trend'}{u ? ` · ${unit}` : ''}</span>
          <span className="text-[11px] text-steel">
            {timeAxis ? `${chartData.length} readings over time` : `recent ${chartData.length} sample${chartData.length === 1 ? '' : 's'}`}
          </span>
        </div>

        {!plottable ? (
          <div className="h-[260px] flex items-center justify-center text-sm text-steel/60 text-center px-4">
            {isLoading ? 'Loading readings…'
              : single?.stat ? 'Not enough readings to chart this signal yet — it needs at least two.'
              : 'No trend series available for this signal (raw register or single reading).'}
          </div>
        ) : (
          <ResponsiveContainer width="100%" height={280}>
            {multi ? (
              <LineChart data={chartData} margin={{ top: 5, right: 12, left: -6, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#E2E8F0" vertical={false} />
                <XAxis dataKey="t" type="number" scale={timeAxis ? 'time' : 'linear'} domain={['dataMin', 'dataMax']}
                  tickFormatter={timeAxis ? fmtTs : undefined} tick={timeAxis ? { fill: '#64748B', fontSize: 9 } : false}
                  axisLine={false} tickLine={false} minTickGap={50} height={timeAxis ? 18 : 6} />
                <YAxis tick={{ fill: '#64748B', fontSize: 10 }} axisLine={false} tickLine={false} width={48} tickFormatter={(v: number) => fmtMetric(v)} />
                <Tooltip content={<Tip entries={entries} unit={u} timeAxis={timeAxis} />} />
                <Legend wrapperStyle={{ fontSize: 11 }} iconType="plainline" />
                {entries.slice(0, 8).map((e, i) => (
                  <Line key={e.key} type="monotone" dataKey={e.key} name={e.label} stroke={COLORS[i % COLORS.length]}
                    strokeWidth={1.6} dot={false} connectNulls isAnimationActive={false} />
                ))}
              </LineChart>
            ) : (
              <AreaChart data={chartData} margin={{ top: 5, right: 12, left: -6, bottom: 0 }}>
                <defs>
                  <linearGradient id="metricGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#0D9488" stopOpacity={0.28} />
                    <stop offset="100%" stopColor="#0D9488" stopOpacity={0.02} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="#E2E8F0" vertical={false} />
                <XAxis dataKey="t" type="number" scale={timeAxis ? 'time' : 'linear'} domain={['dataMin', 'dataMax']}
                  tickFormatter={timeAxis ? fmtTs : undefined} tick={timeAxis ? { fill: '#64748B', fontSize: 9 } : false}
                  axisLine={false} tickLine={false} minTickGap={50} height={timeAxis ? 18 : 6} />
                <YAxis tick={{ fill: '#64748B', fontSize: 10 }} axisLine={false} tickLine={false} width={48} tickFormatter={(v: number) => fmtMetric(v)} domain={['auto', 'auto']} />
                <Tooltip content={<Tip entries={entries} unit={u} timeAxis={timeAxis} />} />
                <Area type="monotone" dataKey={singleKey} name={single?.label ?? singleKey} stroke="#0D9488" strokeWidth={1.8} fill="url(#metricGrad)" dot={false} connectNulls isAnimationActive={false} />
              </AreaChart>
            )}
          </ResponsiveContainer>
        )}
        <div className="text-[10px] text-steel/60 mt-1.5">
          {timeAxis ? 'Real reading timestamps · ' : 'Oldest → newest · '}Sentinel/fault values are skipped.
        </div>
      </div>

      {onOpenHistory && (
        <div className="flex justify-end pt-4">
          <button onClick={onOpenHistory} className="flex items-center gap-1.5 text-sm text-accent border border-accent/20 bg-accent/5 hover:bg-accent/10 rounded-lg px-3 py-2 font-medium transition-colors">
            Open in History <ArrowRight size={14} />
          </button>
        </div>
      )}
    </Modal>
  );
}

function StatTile({ label, value, accent, big }: { label: string; value: ReactNode; accent: string; big?: boolean }): JSX.Element {
  return (
    <div className="rounded-lg border border-line bg-surface px-3 py-2 text-center">
      <div className="text-[10px] text-steel uppercase tracking-wide truncate">{label}</div>
      <div className={`data font-bold mt-0.5 truncate ${big ? 'text-lg' : 'text-sm'}`} style={{ color: accent }}>{value}</div>
    </div>
  );
}

interface TipEntry { dataKey?: string; value?: number | null; color?: string; name?: string }
function Tip({ active, payload, label, entries, unit, timeAxis }: { active?: boolean; payload?: TipEntry[]; label?: number; entries: DrillEntry[]; unit: string; timeAxis: boolean }): JSX.Element | null {
  if (!active || !payload?.length) return null;
  return (
    <div className="bg-surface border border-line rounded-lg px-3 py-2 text-xs shadow-lg max-w-[260px]">
      {timeAxis && label != null && (
        <div className="text-steel mb-1.5">{new Date(label).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit' })}</div>
      )}
      <div className="space-y-0.5">
        {payload.map((e) => {
          if (e.value === null || e.value === undefined) return null;
          const lbl = entries.find((x) => x.key === e.dataKey)?.label || prettyKey(e.dataKey || '');
          return (
            <div key={e.dataKey} className="flex items-center justify-between gap-3">
              <span className="flex items-center gap-1.5 text-steel truncate"><span className="w-2 h-2 rounded-full shrink-0" style={{ background: e.color }} />{lbl}</span>
              <span className="data text-primary shrink-0">{fmtMetric(e.value)}{unit}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
