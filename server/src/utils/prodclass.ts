// server/src/utils/prodclass.ts
// Production-event classification: the admin-configurable rules for the
// operator popup. What an option is — and the one thing that is fixed — is
// spelled out above BUILTIN_VALUES below. Everything configurable lives in
// the app_config singleton under `prodClass`; this module owns its shape,
// validation and a small cache so the 30s sweep doesn't read config once per
// production event.
import { AppConfig } from '../models/AppConfig.js';
import { MachineEvent } from '../models/MachineEvent.js';
import { refCandidates } from './machineRef.js';
import { invalidate } from './cache.js';

// The options are the ADMIN's: add, rename, disable, reorder. Each carries a
// stable internal value minted once from its label (REWORK, TRIAL_PIECE…) —
// history and reports key on the value, so a rename changes buttons, never
// records. OK is the one fixed point: it is what "good production" means,
// always counts, and cannot be removed. The four shipped here are only the
// defaults a fresh plant starts with.
export const BUILTIN_VALUES = ['OK', 'DRY_CYCLE', 'DEFECTIVE', 'SAMPLE'] as const;
export type ClassValue = string;
export const VALUE_RE = /^[A-Z][A-Z0-9_]{0,31}$/;

/** A stable internal value from a label: "Trial piece" → TRIAL_PIECE. */
export const valueFromLabel = (label: string): string =>
  label.trim().toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '').replace(/^[0-9]/, 'X$&').slice(0, 32) || 'OPTION';

export interface ProdClassOption {
  value: ClassValue;   // stable internal value — never edited
  label: string;       // what the operator's button says
  enabled: boolean;    // disabled options never reach the popup
  order: number;       // button order, 1-based after normalization
  // Whether a piece so classified is PRODUCTION. A dry cycle made nothing; a
  // sample is not for sale. Pieces whose class does not count are subtracted
  // from every production figure the app shows. OK always counts.
  counts: boolean;
}

export interface ProdClassConfig {
  enabled: boolean;        // master switch for the popup itself
  timeoutSec: number;      // how long the popup waits for the operator
  defaultValue: ClassValue;// what a production event is born as (and stays on timeout)
  options: ProdClassOption[];
  // Why a past event's classification was changed — the operator picks one
  // of these (or writes their own). Admin-editable.
  reasons: string[];
}

export const DEFAULT_PROD_CLASS: ProdClassConfig = {
  enabled: true,
  timeoutSec: 20,
  defaultValue: 'OK',
  options: [
    { value: 'OK', label: 'OK', enabled: true, order: 1, counts: true },
    { value: 'DRY_CYCLE', label: 'Dry Cycle', enabled: true, order: 2, counts: false },
    { value: 'DEFECTIVE', label: 'Defective Piece', enabled: true, order: 3, counts: false },
    { value: 'SAMPLE', label: 'Sample', enabled: true, order: 4, counts: false },
  ],
  reasons: ['Missed the popup', 'Pressed the wrong button', 'Checked the piece afterwards'],
};

/** What a stored option's `counts` means when the field is absent (configs
 *  saved before it existed): OK counts, nothing else does. */
const countsDefault = (v: ClassValue): boolean => v === 'OK';

const isClassValue = (v: unknown): v is ClassValue => typeof v === 'string' && VALUE_RE.test(v);

/** Validate + normalize a stored or admin-submitted config.
 *  Returns the clean config, or a human-readable error string.
 *  null/undefined (nothing stored yet) normalizes to the defaults. */
export function normalizeProdClass(raw: unknown): ProdClassConfig | string {
  if (raw == null) return { ...DEFAULT_PROD_CLASS, options: DEFAULT_PROD_CLASS.options.map((o) => ({ ...o })), reasons: [...DEFAULT_PROD_CLASS.reasons] };
  if (typeof raw !== 'object') return 'classification settings must be an object';
  const r = raw as Record<string, unknown>;

  const timeoutSec = Math.round(Number(r.timeoutSec));
  if (!Number.isFinite(timeoutSec) || timeoutSec < 3 || timeoutSec > 600) {
    return 'popup duration must be 3–600 seconds';
  }

  if (!Array.isArray(r.options)) return 'classification options must be a list';
  const byValue = new Map<ClassValue, ProdClassOption>();
  for (const o of r.options as Record<string, unknown>[]) {
    if (!o || typeof o !== 'object') return 'invalid classification option';
    if (!isClassValue(o.value)) return `invalid classification value "${String(o?.value)}" — letters, digits and _ only`;
    if (byValue.has(o.value)) return `duplicate classification option "${o.value}"`;
    const label = String(o.label ?? '').trim();
    if (!label || label.length > 40) return 'option labels must be 1–40 characters';
    const order = Number(o.order);
    if (!Number.isFinite(order)) return 'option order must be a number';
    // OK is production by definition — an admin cannot make it not count.
    const counts = o.value === 'OK' ? true : (o.counts == null ? countsDefault(o.value) : !!o.counts);
    byValue.set(o.value, { value: o.value, label, enabled: !!o.enabled, order, counts });
  }
  // OK is what "good production" means and is the only option that must exist.
  if (!byValue.has('OK')) return 'the OK option cannot be removed';
  if (byValue.size > 20) return 'at most 20 classification options';

  // Ties broken by the order given, then reindexed 1..N — order stays unique
  // by construction instead of by rejection.
  const given = [...byValue.values()];
  const options = given
    .map((o, i) => ({ o, i }))
    .sort((a, b) => (a.o.order - b.o.order) || (a.i - b.i))
    .map(({ o }, i) => ({ ...o, order: i + 1 }));

  if (!options.some((o) => o.enabled)) return 'enable at least one classification option';

  const defaultValue = r.defaultValue;
  const def = options.find((o) => o.value === defaultValue);
  if (!def) return 'default classification is not a known option';
  if (!def.enabled) return 'default classification must be an enabled option';

  // Reasons: a short, trimmed, de-duplicated list; absent = the defaults.
  let reasons: string[];
  if (r.reasons == null) reasons = [...DEFAULT_PROD_CLASS.reasons];
  else {
    if (!Array.isArray(r.reasons)) return 'edit reasons must be a list';
    reasons = [];
    for (const x of r.reasons) {
      const s = String(x ?? '').trim();
      if (!s) continue;
      if (s.length > 60) return 'an edit reason must be 60 characters or fewer';
      if (!reasons.some((y) => y.toLowerCase() === s.toLowerCase())) reasons.push(s);
    }
    if (reasons.length > 30) return 'at most 30 edit reasons';
  }

  return { enabled: !!r.enabled, timeoutSec, defaultValue: def.value, options, reasons };
}

// ── pieces that are not production ───────────────────────────────────────────
/** Per machine (upper-cased ref), the classified-away pieces inside [from, to]:
 *  each as {t, n} — when the counter moved and how many pieces that advance
 *  was. Every production figure subtracts these. Empty when every option
 *  counts (the admin's "count everything" switch), or on any error — a
 *  broken lookup must not turn every card blank. */
export async function excludedPiecesBy(
  refs: string[], from: Date, to: Date,
): Promise<Map<string, { t: number; n: number }[]>> {
  const out = new Map<string, { t: number; n: number }[]>();
  try {
    const cfg = await getProdClassConfig();
    const skip = cfg.options.filter((o) => !o.counts).map((o) => o.value);
    if (!skip.length || !refs.length) return out;
    const ids = [...new Set(refs.flatMap(refCandidates))];
    // A climb the counting engine never credited (a garbage sample, a
    // commissioning preload — meta.implausible) must never be subtracted
    // either: classifying a "+887" away would otherwise zero the real day.
    const rows = await MachineEvent.find({
      kind: 'production', delta: { $gt: 0 }, classification: { $in: skip },
      machineId: { $in: ids }, startedAt: { $gte: from, $lte: to },
      'meta.reset': { $ne: true }, 'meta.implausible': { $ne: true },
    }).select({ machineId: 1, startedAt: 1, delta: 1 }).sort({ startedAt: 1 }).lean();
    for (const r of rows) {
      const k = String(r.machineId).toUpperCase();
      const list = out.get(k) || [];
      list.push({ t: new Date(r.startedAt).getTime(), n: Number(r.delta) || 0 });
      out.set(k, list);
    }
  } catch { /* fail open: the count is the raw count */ }
  return out;
}
export const excludedTotal = (list: { t: number; n: number }[] | undefined): number =>
  (list || []).reduce((n, x) => n + x.n, 0);

// ── cached read for the sweep ────────────────────────────────────────────────
// One config lookup per TTL instead of one per production event. Never throws:
// classification must never be the reason a production event fails to record.
const CACHE_MS = 30_000;
let cache: { at: number; cfg: ProdClassConfig } | null = null;

export async function getProdClassConfig(): Promise<ProdClassConfig> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.cfg;
  let cfg = DEFAULT_PROD_CLASS;
  try {
    const doc = await AppConfig.findOne({ key: 'global' }).select({ prodClass: 1 }).lean();
    const norm = normalizeProdClass(doc?.prodClass);
    if (typeof norm !== 'string') cfg = norm;   // a corrupt doc falls back to defaults
  } catch { /* DB hiccup → defaults; the popup would rather be generic than absent */ }
  cache = { at: Date.now(), cfg };
  return cfg;
}

/** Call after the admin saves — the next sweep/read sees the new rules. */
export function invalidateProdClassCache(): void { cache = null; }

/** Every server-side cached read that subtracts classified-away pieces. Call
 *  after any write that moves a classification or changes which classes
 *  count — otherwise the list updates and the cards hold the old figure for
 *  the rest of a TTL, which reads as "the edit did not work". */
export function invalidateProductionReads(): void {
  for (const p of ['activity', 'hourly:', 'timeline:', 'targets:', 'diatrace:', 'orderprog:', 'snap:']) invalidate(p);
}
