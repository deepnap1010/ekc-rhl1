// client/src/lib/production.ts
// THE single source of truth for "which signal is this machine's production
// counter". Every surface (cards, sorting, badges, headline) must use this —
// the same tiers the server's utils/production.ts applies — or pages contradict
// each other.
//
// Rules:
//   - Tiers, most specific wins: workpiece → prod/production/output/piece →
//     parts/count. Counters are NOT additive (cycle + workpiece ≠ production),
//     so exactly one signal is picked, never a sum.
//   - Cycle counters are never production (a cycle is not a finished piece).
//   - Digital I/O bits (named.inputs.* / named.outputs.*) are never counters,
//     even though their group name contains "output".
//   - Raw PLC register addresses are never counters.
import type { MetricValue, ParameterMap } from '../types/api';
import { isRawAddress, paramLabel } from './params';
import { machineNameOf } from './machineName';

export const PROD_TIERS: RegExp[] = [/workpiece/, /\bprod\b|production|output|piece/, /\b(parts?|count)\b/];

const norm = (k: string): string =>
  paramLabel(k).toLowerCase().replace(/[._/\-]+/g, ' ').replace(/\s+/g, ' ').trim();

/** Keys that can never be a production counter, whatever they are named. */
export function excludedFromProduction(key: string): boolean {
  // active.* is the raw S7 register dump — mirrors the server's IO_GROUP_RE.
  return isRawAddress(key) || /^(named\.(inputs|outputs)|active)\./i.test(key) || /cycle/.test(norm(key));
}

/** True when this key names a production counter (any tier). */
export function isProductionKey(key: string): boolean {
  if (excludedFromProduction(key)) return false;
  const n = norm(key);
  return PROD_TIERS.some((re) => re.test(n));
}

/**
 * The machine's production counter value from a FLAT parameter map, or null when
 * it reports none. `nonZero` skips zero values (for displays where a 0 usually
 * means the counter reset or never started).
 */
export function productionValue(
  params?: ParameterMap | Record<string, MetricValue>,
  { nonZero = false }: { nonZero?: boolean } = {},
): number | null {
  const entries = Object.entries(params || {});
  for (const re of PROD_TIERS) {
    for (const [k, v] of entries) {
      if (excludedFromProduction(k)) continue;
      const n = Number(v);
      if (!Number.isFinite(n)) continue;
      if (nonZero && n === 0) continue;
      if (re.test(norm(k))) return n;
    }
  }
  return null;
}

/**
 * Where a machine's piece count came from, when it wasn't counted there.
 * BOTTOMMILLING03/04 report no counter — their number is the count of the
 * machine upstream, reaching them a couple of minutes later (server:
 * config/lineLinks). Shown wherever that number is, so it never reads as
 * something this machine measured. null on a machine that counts its own work.
 */
export function borrowedFrom(
  r?: { productionFrom?: string | null; productionLagMs?: number } | null,
): string | null {
  if (!r?.productionFrom) return null;
  const min = Math.round((r.productionLagMs || 0) / 60_000);
  // The upstream machine is named the way the rest of the UI names it.
  return `from ${machineNameOf(r.productionFrom)}${min ? ` · ${min} min behind` : ''}`;
}
