// server/src/utils/prodclass.ts
// Production-event classification: the admin-configurable rules for the
// operator popup (OK / Dry Cycle / Defective Piece / Sample).
//
// The INTERNAL values are a closed, stable set — reports and history hang off
// them, so an admin renames only the display label ("Defective Piece" →
// "Reject"), never the value. Everything configurable lives in the app_config
// singleton under `prodClass`; this module owns its shape, validation and a
// small cache so the 30s sweep doesn't read config once per production event.
import { AppConfig } from '../models/AppConfig.js';

export const CLASS_VALUES = ['OK', 'DRY_CYCLE', 'DEFECTIVE', 'SAMPLE'] as const;
export type ClassValue = (typeof CLASS_VALUES)[number];

export interface ProdClassOption {
  value: ClassValue;   // stable internal value — never edited
  label: string;       // what the operator's button says
  enabled: boolean;    // disabled options never reach the popup
  order: number;       // button order, 1-based after normalization
}

export interface ProdClassConfig {
  enabled: boolean;        // master switch for the popup itself
  timeoutSec: number;      // how long the popup waits for the operator
  defaultValue: ClassValue;// what a production event is born as (and stays on timeout)
  options: ProdClassOption[];
}

export const DEFAULT_PROD_CLASS: ProdClassConfig = {
  enabled: true,
  timeoutSec: 20,
  defaultValue: 'OK',
  options: [
    { value: 'OK', label: 'OK', enabled: true, order: 1 },
    { value: 'DRY_CYCLE', label: 'Dry Cycle', enabled: true, order: 2 },
    { value: 'DEFECTIVE', label: 'Defective Piece', enabled: true, order: 3 },
    { value: 'SAMPLE', label: 'Sample', enabled: true, order: 4 },
  ],
};

const isClassValue = (v: unknown): v is ClassValue => CLASS_VALUES.includes(v as ClassValue);

/** Validate + normalize a stored or admin-submitted config.
 *  Returns the clean config, or a human-readable error string.
 *  null/undefined (nothing stored yet) normalizes to the defaults. */
export function normalizeProdClass(raw: unknown): ProdClassConfig | string {
  if (raw == null) return { ...DEFAULT_PROD_CLASS, options: DEFAULT_PROD_CLASS.options.map((o) => ({ ...o })) };
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
    if (!isClassValue(o.value)) return `unknown classification option "${String(o?.value)}"`;
    if (byValue.has(o.value)) return `duplicate classification option "${o.value}"`;
    const label = String(o.label ?? '').trim();
    if (!label || label.length > 40) return 'option labels must be 1–40 characters';
    const order = Number(o.order);
    if (!Number.isFinite(order)) return 'option order must be a number';
    byValue.set(o.value, { value: o.value, label, enabled: !!o.enabled, order });
  }
  // Every canonical value must be present exactly once — an option can be
  // disabled, never dropped (history keeps resolving its label).
  for (const v of CLASS_VALUES) if (!byValue.has(v)) return `missing classification option "${v}"`;

  // Ties broken by canonical position, then reindexed 1..N — order stays
  // unique by construction instead of by rejection.
  const options = [...byValue.values()]
    .sort((a, b) => (a.order - b.order) || (CLASS_VALUES.indexOf(a.value) - CLASS_VALUES.indexOf(b.value)))
    .map((o, i) => ({ ...o, order: i + 1 }));

  if (!options.some((o) => o.enabled)) return 'enable at least one classification option';

  const defaultValue = r.defaultValue;
  if (!isClassValue(defaultValue)) return 'default classification is not a known option';
  if (!options.find((o) => o.value === defaultValue)?.enabled) {
    return 'default classification must be an enabled option';
  }

  return { enabled: !!r.enabled, timeoutSec, defaultValue, options };
}

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
