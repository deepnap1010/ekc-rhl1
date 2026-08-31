// server/src/config/derivedCounters.ts
// Machines that count pieces WITHOUT a counter register: the PLC publishes a
// signal that visits a distinctive value once per piece, and the piece count is
// the number of times the signal ARRIVES at that value (a rising edge).
//
// BOTTOMMILLING03 is the case in point: its PLC publishes only speeds and
// torque. But processing_speed sits at ~3,392 between pieces and jumps to
// exactly 50,000 while one is milled — measured on the live floor, those bursts
// come a median 179s apart, which is the machine's configured 3 min/pc rate to
// within seconds. One burst, one piece. (It used to borrow HYDRAULICPRESS02's
// count via lineLinks; that source has left the fleet, and a machine that can
// count its own work never borrows.)
import { normRef } from './lineLinks.js';

export interface DerivedCounter {
  key: string;         // the flat telemetry field carrying the signal
  threshold: number;   // counting value: an edge is v >= threshold after v < threshold
}

const DERIVED: Record<string, DerivedCounter> = {
  BOTTOMMILLING03: { key: 'processing_speed', threshold: 50_000 },
};

const BY_NORM: Record<string, DerivedCounter> = Object.fromEntries(
  Object.entries(DERIVED).map(([code, d]) => [normRef(code), d]),
);

export const derivedCounterFor = (ref: string): DerivedCounter | null => BY_NORM[normRef(ref)] ?? null;

// A real burst lasts under 20s and real pieces arrive ≥87s apart (measured);
// a signal that flaps across the threshold inside this window is noise, not a
// second piece. Callers query this far BEFORE their window so the refractory
// survives a window boundary (services/derivedCounter).
// ponytail: fixed 30s refractory; make it per-machine config if a faster
// derived machine ever joins.
export const REFRACTORY_MS = 30_000;

/** Rising edges of a raw signal series (ascending by t): one event per arrival
 *  at the threshold. The first sample is baseline — a window that opens
 *  mid-burst does not count that burst, exactly as stepEvents treats its first
 *  reading, so a piece is never counted twice across adjacent windows. */
export function edgeEvents(series: { t: number; v: number }[], threshold: number): { t: number; made: number }[] {
  const out: { t: number; made: number }[] = [];
  let prevBelow: boolean | null = null;    // null until the baseline sample
  let lastEdge = -Infinity;
  for (const p of series) {
    if (!Number.isFinite(p.v)) continue;
    const below = p.v < threshold;
    if (prevBelow === true && !below && p.t - lastEdge >= REFRACTORY_MS) {
      out.push({ t: p.t, made: 1 });
      lastEdge = p.t;
    }
    prevBelow = below;
  }
  return out;
}

// Self-check: npx tsx src/config/derivedCounters.ts
if (process.argv[1]?.includes('derivedCounters')) {
  const eq = (a: unknown, b: unknown, m: string): void => {
    if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`);
  };
  const S = 1000;
  const t = (i: number) => i * 10 * S;                       // a sample every 10s
  const mk = (vals: number[]) => vals.map((v, i) => ({ t: t(i), v }));
  const count = (vals: number[]) => edgeEvents(mk(vals), 50_000).reduce((n, e) => n + e.made, 0);

  eq(derivedCounterFor('BOTTOMMILLING03')?.key, 'processing_speed', 'exact code');
  eq(derivedCounterFor('bottom-milling 03')?.threshold, 50_000, 'punctuation + case');
  eq(derivedCounterFor('BOTTOMMILLING04'), null, 'other machines untouched');

  eq(count([3392, 3392, 50000, 50000, 3392]), 1, 'one burst = one piece');
  eq(count([3392, 50000, 3392, 3392, 3392, 3392, 3392, 3392, 3392, 3392, 3392, 50000]), 2, 'two bursts far apart = two');
  eq(count([50000, 50000, 3392]), 0, 'window opening mid-burst counts nothing');
  eq(count([3392, 50000, 3392, 50000]), 1, 'a flap 20s after an edge is the SAME piece (refractory)');
  eq(count([3392, 3392]), 0, 'never at threshold = nothing');
  eq(edgeEvents([], 50_000).length, 0, 'empty series');
  eq(count([3392, 60000, 3392, 3392, 3392, 3392, 3392, 3392, 3392, 3392, 3392, 55000]), 2, 'anything AT OR ABOVE the threshold counts');
  console.log('derivedCounters: all checks passed');
}
