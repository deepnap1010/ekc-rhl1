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

export const PROD_PATTERNS = [/workpiece/, /\bprod\b|production|output|piece/, /\b(parts?|count)\b/];

export const normProdKey = (k: string): string => k.toLowerCase().replace(/[._/\-]+/g, ' ');

const IO_GROUP_RE = /^(named\.(inputs|outputs)|active)\./i;
const stripGroups = (k: string): string => k.replace(/^(named|active|data)\./i, '');

/** The best production-counter key in a flattened payload, or null. */
export function pickProductionKey(flat: Record<string, unknown>): string | null {
  const candidates = Object.keys(flat).filter((k) => {
    if (IO_GROUP_RE.test(k)) return false;               // digital I/O bits
    const label = stripGroups(k);
    if (isRegisterKey(label)) return false;              // raw PLC addresses
    if (/cycle/.test(normProdKey(label))) return false;  // a cycle is not a piece
    return isNumericValue(flat[k]);                      // rejects null/''/booleans
  });
  for (const re of PROD_PATTERNS) {
    const key = candidates.find((k) => re.test(normProdKey(stripGroups(k))));
    if (key) return key;
  }
  return null;
}

// ── The machine's OWN run signal ─────────────────────────────────────────────
// Several PLCs here publish whether they are running, and that beats the
// `status` field the collector attaches: ISB02 never sends a status at all, so
// its stored status sat at "idle" all day while its RUN_FLAG and its production
// counter both moved (verified: the counter rose 26 times, every one of them
// with RUN_FLAG=1, and never otherwise).
//
// Two shapes exist in this fleet, in order of preference:
//   • cumulative seconds — run_sec_today
//   • a boolean flag     — RUN_FLAG, RUNNING_FLAG
// Patterns are ANCHORED on purpose, and deliberately narrow:
//   • CNCLATHE04 publishes cycle_run_1..3 and op_active_1..2, one per spindle,
//     and no single one of them means "the machine is running" — a loose /run/
//     would have picked one and quietly lied;
//   • QUENCHINGFURNACE02 publishes plcRunSec AND totalRunSec, and neither is the
//     machine's run time: totalRunSec climbed 4,481 hours in a 14.65-hour day
//     (wrong unit or a wrapping register), which a "total run seconds" pattern
//     would have swallowed and reported as a fully-utilised furnace.
const RUN_SECONDS_RE = /^run(ning)? (sec|secs|seconds|time)( today)?$/;
const RUN_FLAG_RE = /^(is )?run(ning)?( flag| state)?$/;

// Same normalisation as the production keys, plus camelCase splitting so
// `plcRunSec` reads as "plc run sec".
const normRunKey = (k: string): string =>
  k.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().replace(/[._/\-]+/g, ' ').trim();

export type RunSignal = { key: string; kind: 'seconds' | 'flag' };

/** The machine's own run signal in a flattened payload, or null. */
export function pickRunKey(flat: Record<string, unknown>): RunSignal | null {
  const candidates = Object.keys(flat).filter((k) => {
    if (IO_GROUP_RE.test(k)) return false;
    const label = stripGroups(k);
    if (isRegisterKey(label)) return false;
    return isNumericValue(flat[k]);
  });
  const seconds = candidates.find((k) => RUN_SECONDS_RE.test(normRunKey(stripGroups(k))));
  if (seconds) return { key: seconds, kind: 'seconds' };
  const flag = candidates.find((k) => RUN_FLAG_RE.test(normRunKey(stripGroups(k))));
  return flag ? { key: flag, kind: 'flag' } : null;
}
