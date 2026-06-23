// client/src/components/TrendChart.tsx
// Multi-line metric trends: plots a larger window (last 200 readings in range), a
// real time X-axis, an optional Normalize (0–100%) so a 60,000-scale metric and a
// 0/1 bit are both readable on one axis, legend, fault values skipped, line cap.
import { useState, useMemo } from 'react';
import { useQuery, keepPreviousData } from '@tanstack/react-query';
import { LineChart, Line, XAxis, YAxis, Tooltip, CartesianGrid, ResponsiveContainer, Legend } from 'recharts';
import { TrendingUp } from 'lucide-react';
import { machineApi } from '../api/endpoints';
import { prettyKey, fmtMetric, isNumeric, isFault } from '../lib/format';
import type { MetricValue } from '../types/api';

const COLORS = ['#0D9488', '#6366F1', '#EC4899', '#D97706', '#3B82F6', '#8B5CF6', '#10B981', '#F43F5E'];
const MAX_LINES = 8;

interface TrendChartProps { code?: string; from?: string; to?: string; keys?: string[]; }
interface Row { timestamp: string; data?: Record<string, unknown> }
type ChartRow = Record<string, number | null>;

const val = (r: Row, k: string): MetricValue => (r.data?.[k] as MetricValue);

export default function TrendChart({ code, from, to, keys = [] }: TrendChartProps): JSX.Element {
  const [normalize, setNormalize] = useState(false);

  const { data, isFetching } = useQuery({
    queryKey: ['trend', code, from, to],
    queryFn: () => machineApi.history(code as string, { from: from || undefined, to: to || undefined, page: 1, limit: 200 }),
    enabled: !!code,
    refetchInterval: 15000,
    placeholderData: keepPreviousData,
  });

  const rows = useMemo<Row[]>(() => [...((data?.data as Row[]) || [])].reverse(), [data]);

  const plotKeys = useMemo(
    () => keys.filter((k) => rows.some((r) => isNumeric(val(r, k)) && !isFault(val(r, k)))).slice(0, MAX_LINES),
    [keys, rows],
  );
  const numericCount = useMemo(
    () => keys.filter((k) => rows.some((r) => isNumeric(val(r, k)) && !isFault(val(r, k)))).length,
    [keys, rows],
  );

  const ranges = useMemo(() => {
    const m: Record<string, { min: number; max: number }> = {};
    for (const k of plotKeys) {
      let mn = Infinity, mx = -Infinity;
      for (const r of rows) {
        const v = val(r, k);
        if (isNumeric(v) && !isFault(v)) { const n = Number(v); if (n < mn) mn = n; if (n > mx) mx = n; }
      }
      m[k] = { min: mn, max: mx };
    }
    return m;
  }, [plotKeys, rows]);

  const chartData = useMemo<ChartRow[]>(() => rows.map((r) => {
    const o: ChartRow = { t: new Date(r.timestamp).getTime() };
    for (const k of plotKeys) {
      const v = val(r, k);
      if (isNumeric(v) && !isFault(v)) {
        const n = Number(v);
        o[`${k}__raw`] = n;
        if (normalize) { const { min, max } = ranges[k]; o[k] = max > min ? ((n - min) / (max - min)) * 100 : 50; }
        else o[k] = n;
      } else { o[k] = null; o[`${k}__raw`] = null; }
    }
    return o;
  }), [rows, plotKeys, normalize, ranges]);

  const fmtTs = (t: number): string => new Date(t).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

  return (
    <div className="panel p-5">
      <div className="flex items-center justify-between flex-wrap gap-3 mb-4">
        <div className="flex items-center gap-2">
          <TrendingUp size={15} className="text-accent" />
          <span className="label">Metric Trends</span>
          <span className="text-[11px] text-steel">latest {chartData.length} readings · {plotKeys.length} metric{plotKeys.length === 1 ? '' : 's'}</span>
        </div>
        <label className="flex items-center gap-1.5 text-xs text-steel cursor-pointer select-none">
          <input type="checkbox" checked={normalize} onChange={(e) => setNormalize(e.target.checked)} className="accent-accent" />
          Normalize (0–100%)
        </label>
      </div>

      {chartData.length < 2 || plotKeys.length === 0 ? (
        <div className="h-[280px] flex items-center justify-center text-sm text-steel/60 text-center px-4">
          {plotKeys.length === 0 ? 'No numeric columns to plot for this machine.' : 'Not enough readings to chart yet.'}
        </div>
      ) : (
        <div className={isFetching ? 'opacity-70 transition-opacity' : 'transition-opacity'}>
          <ResponsiveContainer width="100%" height={300}>
            <LineChart data={chartData} margin={{ top: 5, right: 12, left: -6, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#E2E8F0" vertical={false} />
              <XAxis dataKey="t" type="number" scale="time" domain={['dataMin', 'dataMax']}
                tickFormatter={fmtTs} tick={{ fill: '#64748B', fontSize: 9 }} axisLine={false} tickLine={false} minTickGap={56} />
              <YAxis tick={{ fill: '#64748B', fontSize: 9 }} axisLine={false} tickLine={false}
                width={normalize ? 42 : 56} domain={normalize ? [0, 100] : ['auto', 'auto']}
                tickFormatter={normalize ? (v: number) => `${Math.round(v)}%` : (v: number) => fmtMetric(v)} />
              <Tooltip content={<MultiTip normalize={normalize} />} />
              <Legend wrapperStyle={{ fontSize: 11 }} iconType="plainline" />
              {plotKeys.map((k, i) => (
                <Line key={k} type="monotone" dataKey={k} name={prettyKey(k)} stroke={COLORS[i % COLORS.length]}
                  strokeWidth={1.6} dot={false} connectNulls isAnimationActive={false} />
              ))}
            </LineChart>
          </ResponsiveContainer>
          {numericCount > MAX_LINES && (
            <div className="text-[10px] text-steel/60 mt-1.5">Showing the first {MAX_LINES} of {numericCount} numeric columns.</div>
          )}
        </div>
      )}
    </div>
  );
}

interface TipEntry { dataKey?: string; value?: number | null; color?: string; name?: string; payload?: ChartRow }
function MultiTip({ active, payload, label, normalize }: { active?: boolean; payload?: TipEntry[]; label?: number; normalize?: boolean }): JSX.Element | null {
  if (!active || !payload?.length) return null;
  return (
    <div className="bg-surface border border-line rounded-lg px-3 py-2 text-xs shadow-lg max-w-[240px]">
      <div className="text-steel mb-1.5">{new Date(label ?? 0).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit' })}</div>
      <div className="space-y-0.5">
        {payload.map((e) => {
          const raw = e.dataKey ? e.payload?.[`${e.dataKey}__raw`] : null;
          if (raw === null || raw === undefined) return null;
          return (
            <div key={e.dataKey} className="flex items-center justify-between gap-3">
              <span className="flex items-center gap-1.5 text-steel truncate"><span className="w-2 h-2 rounded-full shrink-0" style={{ background: e.color }} />{e.name}</span>
              <span className="data text-primary shrink-0">{fmtMetric(raw)}{normalize && e.value != null ? ` · ${Math.round(e.value)}%` : ''}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
