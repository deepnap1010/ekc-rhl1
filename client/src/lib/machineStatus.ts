// client/src/lib/machineStatus.ts
// Status model — two INDEPENDENT signals, never conflated:
//   1. Reported status (the pill + the running/idle/stopped/offline counts): the
//      server/PLC `status` field, trusted as-is. If a machine last reported
//      "running" we show Running; if the feed reports "disconnected"/"offline",
//      we show that. We do NOT flip it based on a client-side staleness guess.
//   2. Data freshness ("Reporting now" KPI + per-card last-seen time): whether the
//      machine is actively streaming right now, via isStale(). This informs, but
//      never overrides, the reported status.
import type { Machine } from '../types/api';

/** Live window for the data-freshness ("reporting now") signal — NOT the status pill. */
export const STALE_MS = 120_000;

export function isStale(lastReadingAt?: string | null, now = Date.now()): boolean {
  if (!lastReadingAt) return true;
  const t = new Date(lastReadingAt).getTime();
  return Number.isNaN(t) || now - t > STALE_MS;
}

/** Displayed status = the reported `status` field, trusted (lowercased). */
export function effectiveStatus(m: Pick<Machine, 'status' | 'lastReadingAt'>): string {
  return (m.status || 'offline').toLowerCase();
}

export interface StatusTally {
  total: number;
  running: number;
  idle: number;
  stopped: number;
  offline: number;
}

/** Status counts driven by the reported status field. */
export function statusCounts(machines: Machine[]): StatusTally {
  const c: StatusTally = { total: machines.length, running: 0, idle: 0, stopped: 0, offline: 0 };
  for (const m of machines) {
    const s = effectiveStatus(m);
    if (s === 'running') c.running += 1;
    else if (s === 'idle') c.idle += 1;
    else if (s === 'stopped') c.stopped += 1;
    else c.offline += 1;
  }
  return c;
}

// ── Data freshness — the live / last-updated signal (separate from status) ──────
export interface Freshness {
  state: 'live' | 'recent' | 'idle' | 'stale' | 'unknown';
  label: string;
  color: string;
  pulse: boolean;
}

function fmtAge(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

/** Liveness of the last reading: Live (≤2m) → recent → idle → stale, with colour. */
export function freshness(lastReadingAt?: string | null, now = Date.now()): Freshness {
  if (!lastReadingAt) return { state: 'unknown', label: 'No data', color: '#94A3B8', pulse: false };
  const age = now - new Date(lastReadingAt).getTime();
  if (!Number.isFinite(age)) return { state: 'unknown', label: 'No data', color: '#94A3B8', pulse: false };
  if (age <= STALE_MS) return { state: 'live', label: 'Live', color: '#0D9488', pulse: true };
  if (age <= 30 * 60_000) return { state: 'recent', label: fmtAge(age), color: '#0D9488', pulse: false };
  if (age <= 24 * 3_600_000) return { state: 'idle', label: fmtAge(age), color: '#D97706', pulse: false };
  return { state: 'stale', label: fmtAge(age), color: '#94A3B8', pulse: false };
}
