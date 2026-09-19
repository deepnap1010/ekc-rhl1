// server/src/utils/downtimeAsk.ts
// Downtime-reason popup: the admin-configurable rules for asking an operator
// WHY their machine has been idle or stopped. Same home and pattern as the
// production classification rules (utils/prodclass): the `downtimeAsk` field
// of the app_config singleton, validated here, cached briefly because every
// operator screen polls the queue.
//
// Reasons are plain words, not stable values: what lands on the span is the
// text the operator chose (or typed), exactly as the Downtime page has always
// stored a reason. Renaming a reason changes future buttons; past spans keep
// the words that were true when they were written.
import { AppConfig } from '../models/AppConfig.js';

export type DownType = 'idle' | 'stopped';
export const DOWN_TYPES: DownType[] = ['idle', 'stopped'];

export interface DowntimeReason {
  label: string;
  types: DownType[];   // which states offer this button (both by default)
}

export interface DowntimeAskConfig {
  enabled: boolean;      // master switch for the popup
  askAfterMin: number;   // ask once a span has lasted this long
  timeoutSec: number;    // 0 = the popup waits for an answer; else a countdown
  askIdle: boolean;      // ask about idle spans
  askStopped: boolean;   // ask about stopped spans (offline is never asked — nobody is at a dark machine's screen)
  allowCustom: boolean;  // the operator may type a reason of their own
  reasons: DowntimeReason[];
}

export const DEFAULT_DOWNTIME_ASK: DowntimeAskConfig = {
  enabled: true,
  askAfterMin: 10,
  timeoutSec: 0,
  askIdle: true,
  askStopped: true,
  allowCustom: true,
  // The plant's own ten idle-hour categories, as its daily review sheet
  // heads them — so the popup, the Downtime page and the exported PDWIP band
  // all speak the words the floor already uses. Admins rename freely.
  reasons: [
    { label: 'No Plan', types: ['idle'] },
    { label: 'NL / UN-LOADING JAM', types: ['idle', 'stopped'] },
    { label: 'No Opr', types: ['idle'] },
    { label: 'New Setting', types: ['idle', 'stopped'] },
    { label: 'No Power', types: ['stopped'] },
    { label: 'No Utility', types: ['stopped'] },
    { label: 'B/D', types: ['stopped'] },
    { label: 'Quality Set up', types: ['idle', 'stopped'] },
    { label: 'No Consumable', types: ['idle'] },
    { label: 'Other', types: ['idle', 'stopped'] },
  ],
};

const cloneDefaults = (): DowntimeAskConfig =>
  ({ ...DEFAULT_DOWNTIME_ASK, reasons: DEFAULT_DOWNTIME_ASK.reasons.map((r) => ({ label: r.label, types: [...r.types] })) });

/** Validate + normalize a stored or admin-submitted config. Returns the clean
 *  config, or a human-readable error string. null/undefined (nothing stored
 *  yet) normalizes to the defaults. */
export function normalizeDowntimeAsk(raw: unknown): DowntimeAskConfig | string {
  if (raw == null) return cloneDefaults();
  if (typeof raw !== 'object') return 'downtime popup settings must be an object';
  const r = raw as Record<string, unknown>;

  const askAfterMin = Math.round(Number(r.askAfterMin));
  if (!Number.isFinite(askAfterMin) || askAfterMin < 1 || askAfterMin > 240) return 'ask after must be 1–240 minutes';

  // 0 is a real choice — "stay until answered" — not a missing value. A
  // countdown that exists is bounded like the production popup's.
  const timeoutSec = Math.round(Number(r.timeoutSec));
  if (!Number.isFinite(timeoutSec) || timeoutSec < 0 || (timeoutSec > 0 && timeoutSec < 10) || timeoutSec > 3600) {
    return 'popup duration must be 0 (wait for the answer) or 10–3600 seconds';
  }

  const enabled = !!r.enabled;
  const askIdle = !!r.askIdle;
  const askStopped = !!r.askStopped;
  if (enabled && !askIdle && !askStopped) return 'choose at least one state to ask about, or turn the popup off';
  const allowCustom = r.allowCustom == null ? true : !!r.allowCustom;

  let reasons: DowntimeReason[];
  if (r.reasons == null) reasons = cloneDefaults().reasons;
  else {
    if (!Array.isArray(r.reasons)) return 'reasons must be a list';
    reasons = [];
    for (const x of r.reasons as unknown[]) {
      // Accept a bare string too (the old device-local list was one).
      const o = (typeof x === 'string' ? { label: x } : x) as Record<string, unknown> | null;
      if (!o || typeof o !== 'object') return 'invalid reason';
      const label = String(o.label ?? '').trim();
      if (!label || label.length > 60) return 'a reason must be 1–60 characters';
      if (reasons.some((y) => y.label.toLowerCase() === label.toLowerCase())) continue;   // duplicates fold
      let types: DownType[];
      if (o.types == null) types = ['idle', 'stopped'];
      else {
        if (!Array.isArray(o.types)) return `"${label}": applies-to must be a list`;
        types = DOWN_TYPES.filter((t) => (o.types as unknown[]).includes(t));
        if (!types.length) return `"${label}" must apply to idle, stopped or both`;
      }
      reasons.push({ label, types });
    }
    if (reasons.length > 30) return 'at most 30 reasons';
  }
  if (enabled && !allowCustom && !reasons.length) return 'add at least one reason, or allow operators to type their own';

  return { enabled, askAfterMin, timeoutSec, askIdle, askStopped, allowCustom, reasons };
}

/** The buttons a popup for this kind of span shows. */
export const reasonsFor = (cfg: DowntimeAskConfig, type: string): string[] =>
  cfg.reasons.filter((r) => r.types.includes(type as DownType)).map((r) => r.label);

/** Which span types the popup asks about under this config. */
export const askedTypes = (cfg: DowntimeAskConfig): DownType[] =>
  DOWN_TYPES.filter((t) => (t === 'idle' ? cfg.askIdle : cfg.askStopped));

// ── cached read ──────────────────────────────────────────────────────────────
// One config lookup per TTL instead of one per queue poll. Never throws: a
// config hiccup must read as "the defaults", not as "no popup".
const CACHE_MS = 30_000;
let cache: { at: number; cfg: DowntimeAskConfig } | null = null;

export async function getDowntimeAskConfig(): Promise<DowntimeAskConfig> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.cfg;
  let cfg = DEFAULT_DOWNTIME_ASK;
  try {
    const doc = await AppConfig.findOne({ key: 'global' }).select({ downtimeAsk: 1 }).lean();
    const norm = normalizeDowntimeAsk(doc?.downtimeAsk);
    if (typeof norm !== 'string') cfg = norm;   // a corrupt doc falls back to defaults
  } catch { /* DB hiccup → defaults */ }
  cache = { at: Date.now(), cfg };
  return cfg;
}

/** Call after the admin saves — the next poll sees the new rules. */
export function invalidateDowntimeAskCache(): void { cache = null; }

// ── shift bucketing for the reasons summary ──────────────────────────────────
// The plant's shifts are HH:MM on the plant clock; a span's shift is decided
// by its start minute-of-day. Built as a $switch so the summary stays one
// index-backed aggregation pass instead of a per-span JS walk. Overnight
// shifts (23:00–07:00) wrap: start ≥ 23:00 OR start < 07:00.
const toMin = (hhmm: string): number => {
  const [h, m] = String(hhmm || '').split(':').map(Number);
  return (Number.isFinite(h) ? h : 0) * 60 + (Number.isFinite(m) ? m : 0);
};

export function shiftSwitchExpr(shifts: { name: string; start: string; end: string }[], minuteOfDay: unknown): unknown {
  const branches = shifts.map((s) => {
    const a = toMin(s.start);
    const b = toMin(s.end);
    const cond = a < b
      ? { $and: [{ $gte: [minuteOfDay, a] }, { $lt: [minuteOfDay, b] }] }
      : { $or: [{ $gte: [minuteOfDay, a] }, { $lt: [minuteOfDay, b] }] };
    return { case: cond, then: s.name };
  });
  return branches.length ? { $switch: { branches, default: 'Off-shift' } } : 'All day';
}

/** JS twin of shiftSwitchExpr, for the self-check and anyone bucketing in Node. */
export function shiftNameAt(shifts: { name: string; start: string; end: string }[], minuteOfDay: number): string {
  for (const s of shifts) {
    const a = toMin(s.start);
    const b = toMin(s.end);
    if (a < b ? (minuteOfDay >= a && minuteOfDay < b) : (minuteOfDay >= a || minuteOfDay < b)) return s.name;
  }
  return shifts.length ? 'Off-shift' : 'All day';
}
