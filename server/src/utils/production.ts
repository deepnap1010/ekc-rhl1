// server/src/utils/production.ts
// The ONE place that decides which telemetry key is a machine's production
// counter. Priority: a real workpiece counter beats production/output/piece,
// which beats a generic "count" (so a cycle count is never mistaken for
// production). Shared by machineActivity and the event engine — and it mirrors
// the client's headline logic (client/src/lib/headline.ts); change both together.
//
// Guards (mirroring the client, which strips group prefixes and skips raw
// addresses for exactly these reasons):
//   - digital I/O groups (named.inputs.* / named.outputs.*) are never counters —
//     otherwise "named.outputs.Q0.1" would match /output/ and a flapping bit
//     would flood the event log with fake +1/reset events;
//   - matching happens on the group-STRIPPED label, so a wrapper name like
//     "named."/"active."/"data." can't create a match;
//   - raw PLC register addresses (D0, DB10.W2 …) are excluded;
//   - the value must be genuinely numeric — null / '' / booleans are rejected
//     (Number(null) === 0 would otherwise fabricate counter resets and then a
//     full-counter-value "production" delta when the real value returns).
import { isRegisterKey, isNumericValue } from './normalize.js';

export const PROD_PATTERNS = [/workpiece/, /production|output|piece/, /\bcount\b/];

export const normProdKey = (k: string): string => k.toLowerCase().replace(/[._/\-]+/g, ' ');

const IO_GROUP_RE = /^(named\.(inputs|outputs)|active)\./i;
const stripGroups = (k: string): string => k.replace(/^(named|active|data)\./i, '');

/** The best production-counter key in a flattened payload, or null. */
export function pickProductionKey(flat: Record<string, unknown>): string | null {
  const candidates = Object.keys(flat).filter((k) => {
    if (IO_GROUP_RE.test(k)) return false;               // digital I/O bits
    const label = stripGroups(k);
    if (isRegisterKey(label)) return false;              // raw PLC addresses
    return isNumericValue(flat[k]);                      // rejects null/''/booleans
  });
  for (const re of PROD_PATTERNS) {
    const key = candidates.find((k) => re.test(normProdKey(stripGroups(k))));
    if (key) return key;
  }
  return null;
}
