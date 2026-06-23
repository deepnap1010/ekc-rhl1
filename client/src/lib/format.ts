// client/src/lib/format.ts
import type { MetricValue, ThresholdMap } from '../types/api';

export interface StatusStyle {
  label: string;
  color: string;
  bg: string;
}

export const STATUS: Record<string, StatusStyle> = {
  running: { label: 'Running', color: '#0D9488', bg: 'rgba(13,148,136,0.10)' },
  idle:    { label: 'Idle',    color: '#D97706', bg: 'rgba(217,119,6,0.10)' },
  stopped: { label: 'Stopped', color: '#DC2626', bg: 'rgba(220,38,38,0.10)' },
  offline: { label: 'Offline', color: '#64748B', bg: 'rgba(100,116,139,0.10)' },
};

// Any status the factory reports that we don't have a preset for still renders cleanly.
export const statusStyle = (status?: string | null): StatusStyle =>
  (status ? STATUS[status] : undefined) ||
  { label: prettyKey(status || 'unknown'), color: '#64748B', bg: 'rgba(100,116,139,0.10)' };

export const fmtNum = (n: MetricValue): string =>
  new Intl.NumberFormat('en-IN').format(Math.round(Number(n) || 0));

export const fmtCompact = (n: MetricValue): string => {
  const v = Number(n) || 0;
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1000) return `${(v / 1000).toFixed(1)}K`;
  return `${Math.round(v)}`;
};

// Telemetry values are schema-agnostic: numbers, decimals, or strings (e.g. department).
export const fmtMetric = (v: MetricValue): string => {
  if (v === null || v === undefined || v === '') return '—';
  if (typeof v === 'number') return Number.isInteger(v) ? fmtNum(v) : v.toFixed(1);
  const n = Number(v);
  return Number.isFinite(n) ? (Number.isInteger(n) ? fmtNum(n) : n.toFixed(1)) : String(v);
};

export const isNumeric = (v: MetricValue): boolean =>
  v !== null && v !== undefined && v !== '' && Number.isFinite(Number(v));

// int16/int32 "no-signal" sentinels a disconnected sensor reports — excluded from charts.
const SENTINELS = new Set([-32768, -32767, 32767, 65535, -2147483648, 2147483647]);
export const isFault = (v: MetricValue): boolean => isNumeric(v) && SENTINELS.has(Number(v));

// A parameter breaches its threshold when machine.thresholds[`${key}Max`] is exceeded.
export const breachesThreshold = (
  key: string,
  value: MetricValue,
  thresholds?: ThresholdMap
): boolean => {
  const max = thresholds?.[`${key}Max`];
  return typeof max === 'number' && isNumeric(value) && Number(value) > max;
};

export const fmtDuration = (ms: MetricValue): string => {
  const total = Math.max(0, Math.round((Number(ms) || 0) / 60000));
  const h = Math.floor(total / 60);
  const m = total % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
};

export const fmtTime = (ts?: string | number | Date | null): string =>
  ts ? new Date(ts).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—';

export const fmtDate = (ts?: string | number | Date | null): string =>
  ts ? new Date(ts).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '—';

// Pretty-print snake_case AND camelCase keys: "hardeningTemp" -> "Hardening Temp".
export const prettyKey = (k?: string | null): string =>
  (k || '')
    .replace(/_/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/\b\w/g, (c) => c.toUpperCase());

export const prettyType = (t?: string | null): string => prettyKey(t || '');
