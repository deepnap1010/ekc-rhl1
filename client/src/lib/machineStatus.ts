// client/src/lib/machineStatus.ts
// Status model — the reported server/PLC `status` field, trusted while the
// machine is actually SENDING (a machine streaming "stopped" shows Stopped).
// ONE exception (explicit product decision): whatever the last status claimed
// (running / idle / stopped), if the machine has sent NOTHING for 10+ minutes
// the SIGNAL is lost — we show "Signal Lost" instead of a misleading stale
// status + "2h ago". A feed-reported offline stays Offline. Data freshness
// (the last-seen time / "reporting now" KPI) stays separate via isStale().
import type { Machine } from '../types/api';
import { normalizeStatus } from './format';

/** Live window for the data-freshness ("reporting now") signal — NOT the status pill. */
export const STALE_MS = 120_000;

/** Silence threshold after which any machine is shown as Signal Lost. */
export const NETWORK_LOST_MS = 10 * 60_000;

export function isStale(lastReadingAt?: string | null, now = Date.now()): boolean {
  if (!lastReadingAt) return true;
  const t = new Date(lastReadingAt).getTime();
  return Number.isNaN(t) || now - t > STALE_MS;
}

/** Displayed status: the reported field while data flows — silence 10+ min
 *  becomes 'network' (Signal Lost), whatever the last status claimed. */
export function effectiveStatus(m: Pick<Machine, 'status' | 'lastReadingAt'>, now = Date.now()): string {
  // Normalised, not merely lower-cased. Collectors disagree on spelling — PC04
  // posts "Stop" — and this one value decides the pill, the KPI tiles, the
  // status filter and the sort order. Lower-casing alone left them disagreeing
  // with each other: a card whose pill read "Stopped" that the Stopped filter
  // hid and the Stopped tile counted as offline.
  const s = normalizeStatus(m.status || 'offline').toLowerCase();
  if (s !== 'offline' && m.lastReadingAt) {
    const t = new Date(m.lastReadingAt).getTime();
    if (!Number.isNaN(t) && now - t > NETWORK_LOST_MS) return 'network';
  }
  return s;
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
