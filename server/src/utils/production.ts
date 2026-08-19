// server/src/utils/production.ts
// The ONE place that decides which telemetry key is a machine's production
// counter. Priority: a real workpiece counter beats production/output/piece,
// which beats a generic "count" (so a cycle count is never mistaken for
// production). Shared by machineActivity and the event engine — and it mirrors
// the client's headline logic (client/src/lib/headline.ts); change both together.
export const PROD_PATTERNS = [/workpiece/, /production|output|piece/, /\bcount\b/];

export const normProdKey = (k: string): string => k.toLowerCase().replace(/[._/\-]+/g, ' ');

/** The best production-counter key in a flattened payload, or null. */
export function pickProductionKey(flat: Record<string, unknown>): string | null {
  for (const re of PROD_PATTERNS) {
    const key = Object.keys(flat).find((k) => re.test(normProdKey(k)) && Number.isFinite(Number(flat[k])));
    if (key) return key;
  }
  return null;
}
