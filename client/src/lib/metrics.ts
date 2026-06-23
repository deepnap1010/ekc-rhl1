// client/src/lib/metrics.ts
// Client mirror of the server's telemetry intelligence. The list + stats endpoints
// classify/cap server-side, but the History tab + live socket readings receive RAW
// telemetry, so they need the same rules to pick columns, flag faulty sensor values,
// and separate named metrics from raw PLC registers.
import type { MetricValue } from '../types/api';

const REGISTER_RE = /^(IW|QW|IB|QB|MB|MW|MD|SM|SD|D|M|X|Y|T|C|R|L|V|Z|B|W|F|S|I|Q)\d+$/;
const DB_BLOCK_RE = /^DB\d+\.[A-Z]+\d+(\.\d+)?$/i;
const BIT_ADDR_RE = /^[IQM]\d+\.\d+$/;
const META_KEYS = new Set(['status', 'named', 'name', 'machineId', 'machineName', 'machineType', 'timestamp', 'receivedAt', 'eventId']);
const SENTINELS = new Set([-32768, -32767, 32767, 65535, -2147483648, 2147483647]);

export const isRegisterKey = (k: string): boolean => REGISTER_RE.test(k) || DB_BLOCK_RE.test(k) || BIT_ADDR_RE.test(k);
export const isMetaKey = (k: string): boolean => META_KEYS.has(k);
export const isNumeric = (v: unknown): boolean =>
  v !== null && v !== undefined && v !== '' && typeof v !== 'boolean' && Number.isFinite(Number(v));
export const isFault = (v: unknown): boolean => isNumeric(v) && SENTINELS.has(Number(v));

export interface NamedMetric { key: string; value: MetricValue; numeric: boolean; fault: boolean; }

export function classifyKeys(data: Record<string, unknown> = {}): { named: string[]; registers: string[] } {
  const named: string[] = []; const registers: string[] = [];
  for (const k of Object.keys(data || {})) {
    if (isMetaKey(k)) continue;
    if (isRegisterKey(k)) registers.push(k); else named.push(k);
  }
  return { named, registers };
}

// Expand a raw telemetry `data` map into ranked named metrics (value + flags),
// excluding raw registers + meta — used to render live values when a socket reading lands.
export function namedMetrics(data: Record<string, unknown> = {}): NamedMetric[] {
  const out: NamedMetric[] = [];
  for (const [key, value] of Object.entries(data || {})) {
    if (isMetaKey(key) || isRegisterKey(key)) continue;
    out.push({ key, value: value as MetricValue, numeric: isNumeric(value), fault: isFault(value) });
  }
  const tier = (m: NamedMetric): number => (m.numeric && !m.fault ? 0 : m.numeric ? 1 : 2);
  return out.sort((a, b) => tier(a) - tier(b) || a.key.localeCompare(b.key));
}

const isObjLike = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

// Flatten the three payload conventions (flat / data.named.{inputs,outputs} / data.active.*)
// into { named, registers } value maps; digital I/O surfaces as 0/1 so it can be plotted.
export function flattenReading(data: Record<string, unknown> = {}): { named: Record<string, MetricValue>; registers: Record<string, MetricValue> } {
  const named: Record<string, MetricValue> = {};
  const registers: Record<string, MetricValue> = {};
  const ioVal = (v: unknown): number => (v === 1 || v === true || v === '1' || v === 'on' || v === 'ON' ? 1 : 0);
  const putScalar = (k: string, v: unknown): void => {
    if (isMetaKey(k)) return;
    if (isRegisterKey(k)) registers[k] = v as MetricValue; else named[k] = v as MetricValue;
  };
  for (const [key, value] of Object.entries(data || {})) {
    if (key === 'named' && isObjLike(value)) {
      if (isObjLike(value.inputs)) for (const [k, v] of Object.entries(value.inputs)) named[k] = ioVal(v);
      if (isObjLike(value.outputs)) for (const [k, v] of Object.entries(value.outputs)) named[k] = ioVal(v);
      for (const [k, v] of Object.entries(value)) {
        if (k === 'inputs' || k === 'outputs' || isObjLike(v)) continue;
        putScalar(k, v);
      }
      continue;
    }
    if (key === 'active' && isObjLike(value)) {
      for (const [k, v] of Object.entries(value)) {
        if (isObjLike(v)) continue;
        if (/^I\d+\.\d+$/.test(k) || /^Q\d+\.\d+$/.test(k)) named[k] = ioVal(v);
        else putScalar(k, v);
      }
      continue;
    }
    if (isObjLike(value)) continue;
    putScalar(key, value);
  }
  return { named, registers };
}

interface HistoryRow { data?: Record<string, MetricValue> }
// Rank named keys (healthy numeric first) across sample rows — to choose History columns.
export function rankNamedKeys(rows: HistoryRow[], keys: string[]): string[] {
  const score = (k: string): number => {
    let numeric = false; let fault = false;
    for (const r of rows) {
      const v = r.data?.[k];
      if (v === undefined || v === null || v === '') continue;
      if (isNumeric(v)) { numeric = true; if (isFault(v)) fault = true; }
    }
    return numeric && !fault ? 0 : numeric ? 1 : 2;
  };
  return [...keys].sort((a, b) => score(a) - score(b) || a.localeCompare(b));
}

// ── Freshness (mirrors the 120s server offline window) ─────────────────────────
export interface Freshness { state: 'live' | 'recent' | 'idle' | 'stale' | 'unknown'; label: string; color: string; pulse: boolean; ageMs?: number; }
const LIVE_MS = 120_000;

export function freshness(lastSeenAt?: string | Date | null): Freshness {
  if (!lastSeenAt) return { state: 'unknown', label: 'No data', color: '#94A3B8', pulse: false };
  const age = Date.now() - new Date(lastSeenAt).getTime();
  if (Number.isNaN(age)) return { state: 'unknown', label: 'No data', color: '#94A3B8', pulse: false };
  if (age <= LIVE_MS) return { state: 'live', label: 'Live', color: '#0D9488', pulse: true, ageMs: age };
  if (age <= 30 * 60_000) return { state: 'recent', label: fmtAge(age), color: '#0D9488', pulse: false, ageMs: age };
  if (age <= 24 * 3600_000) return { state: 'idle', label: fmtAge(age), color: '#D97706', pulse: false, ageMs: age };
  return { state: 'stale', label: fmtAge(age), color: '#94A3B8', pulse: false, ageMs: age };
}

export function fmtAge(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}
