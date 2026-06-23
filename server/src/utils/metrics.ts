// server/src/utils/metrics.ts
// Per-metric statistics over a window of telemetry readings: last / min / max / avg
// plus a downsampled spark series for trend sparklines. Operates on FLATTENED data,
// excludes raw PLC register addresses (so we never chart thousands of registers) and
// int16/int32 "no-signal" sentinels (so a disconnected sensor can't wreck the scale).
// Faults are excluded from the aggregates but counted.
import { flattenData } from './flatten.js';

const SENTINELS = new Set([-32768, -32767, 32767, 65535, -2147483648, 2147483647]);
const META = new Set(['status', 'machineid', 'machinename', 'machinetype', 'name', 'timestamp', 'receivedat']);

// Raw PLC register/address keys (D0, T3, M120, DB21.DW0, I0.0, IW0 …) — kept in sync
// with the client's lib/params isRawAddress.
function isRawAddress(key: string): boolean {
  const b = key.replace(/^(named\.(inputs|outputs)\.|active\.|data\.)/i, '');
  return (
    /^(dw?|t|m|dm|mb|ib|qb|iw|qw|w|r)\d+$/i.test(b) ||
    /^[iqm]\d+\.\d+$/i.test(b) ||
    /^db\d+(\.(d?w|r)\d+)?$/i.test(b)
  );
}
const isMeta = (k: string): boolean => META.has(k.toLowerCase());

export interface MetricStat {
  key: string;
  last: number | null;
  min: number | null;
  max: number | null;
  avg: number | null;
  samples: number;
  faultCount: number;
  spark: number[];
}

interface ReadingRow {
  timestamp?: Date | string | null;
  data?: Record<string, unknown>;
}

/** Reduce a series to at most n points (last value per even bucket). */
function downsample(arr: number[], n: number): number[] {
  if (arr.length <= n) return arr;
  const step = arr.length / n;
  const out: number[] = [];
  for (let i = 0; i < n; i += 1) out.push(arr[Math.min(arr.length - 1, Math.floor((i + 1) * step) - 1)]);
  return out;
}

export function computeStats(
  readings: ReadingRow[],
  opts: { sparkPoints?: number; maxMetrics?: number } = {},
): { metrics: MetricStat[]; metricCount: number } {
  const sparkPoints = opts.sparkPoints ?? 32;
  const maxMetrics = opts.maxMetrics ?? 48;

  // oldest → newest so sparklines read left-to-right in time
  const ordered = [...readings].sort(
    (a, b) => new Date(a.timestamp ?? 0).getTime() - new Date(b.timestamp ?? 0).getTime(),
  );
  const flatRows = ordered.map((r) => flattenData(r.data));

  // discover the numeric, named (non-register, non-meta) metric keys in the window
  const keys = new Set<string>();
  for (const flat of flatRows) {
    for (const [k, v] of Object.entries(flat)) {
      if (isMeta(k) || isRawAddress(k)) continue;
      if (Number.isFinite(Number(v))) keys.add(k);
    }
  }

  const metrics: MetricStat[] = [];
  for (const key of keys) {
    const series: number[] = [];
    let faultCount = 0;
    let last: number | null = null;
    for (const flat of flatRows) {
      const raw = flat[key];
      if (raw === undefined || raw === null || raw === '') continue;
      const n = Number(raw);
      if (!Number.isFinite(n)) continue;
      if (SENTINELS.has(n)) { faultCount += 1; last = n; continue; }
      series.push(n);
      last = n;
    }
    if (!series.length && last === null) continue;
    const min = series.length ? Math.min(...series) : null;
    const max = series.length ? Math.max(...series) : null;
    const avg = series.length
      ? Math.round((series.reduce((s, v) => s + v, 0) / series.length) * 100) / 100
      : null;
    metrics.push({ key, last, min, max, avg, samples: series.length, faultCount, spark: downsample(series, sparkPoints) });
  }

  // most-sampled metrics first (then alphabetical) so the richest trends lead.
  metrics.sort((a, b) => b.samples - a.samples || a.key.localeCompare(b.key));
  return { metrics: metrics.slice(0, maxMetrics), metricCount: metrics.length };
}
