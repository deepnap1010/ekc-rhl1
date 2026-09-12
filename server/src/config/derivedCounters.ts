// server/src/config/derivedCounters.ts
// Machines that count pieces WITHOUT a counter register: the PLC publishes a
// signal that does something distinctive once per piece, and the piece count is
// the number of times it does it.
//
// This is a FALLBACK, never an override: the moment the machine's payload
// carries a real counter register, that register wins at every counting site
// (the register is the plant's number; this rule is our reading of a signal)
// and the rule only keeps answering for readings that had no register.
//
// Two kinds of rule:
//   threshold — the signal RISES across a fixed value (v >= threshold after
//               v < threshold). Fine for a speed that dips between pieces.
//   stroke    — the signal is a POSITION that climbs from the bottom to (near)
//               a travel setting published beside it, then returns. A piece is
//               the climb: from below `low` × travel to at least `high` × travel.
//               Measured against each reading's OWN travel value, because the
//               operator moves the setting mid-shift (450k → 480k → 490k in one
//               shift on the floor).
//
// BOTTOMMILLING03 is the case in point. As of Sept 2026 its PLC publishes only
// speeds, torque and pulses — no counter. It counted by processing_speed dips
// until a job held the speed constant all day (33,920, never dipping) and the
// count went to zero while the machine milled. current_stroke_pulse is the
// head's motion, program-independent: traced against a shift the floor knew
// (SPG05 made 23 on the same line), strokes gave 21 and the status signal 22.
// About 40% of pieces get a second short stroke within seconds of the first
// (an approach or re-cut) — the 30s refractory folds that into the same piece.
import { normRef } from './lineLinks.js';

export type DerivedCounter =
  | { kind: 'threshold'; key: string; threshold: number }
  | { kind: 'stroke'; key: string; travelKey: string; low: number; high: number };

const DERIVED: Record<string, DerivedCounter> = {
  BOTTOMMILLING03: { kind: 'stroke', key: 'current_stroke_pulse', travelKey: 'travel_setting_pulse', low: 0.25, high: 0.5 },
};

const BY_NORM: Record<string, DerivedCounter> = Object.fromEntries(
  Object.entries(DERIVED).map(([code, d]) => [normRef(code), d]),
);

export const derivedCounterFor = (ref: string): DerivedCounter | null => BY_NORM[normRef(ref)] ?? null;

// A real stroke lasts 2–15s and real pieces arrive ≥50s apart (measured); a
// second climb inside this window is the same piece, not a new one. Callers
// query this far BEFORE their window so the refractory survives a window
// boundary (services/derivedCounter).
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

/** Strokes of a position series (ascending by t), each sample carrying its own
 *  travel setting: one event per climb from below low×travel to ≥ high×travel.
 *  Same baseline and refractory rules as edgeEvents. This is the Node twin of
 *  the aggregation in services/derivedCounter — keep them saying the same. */
export function strokeEvents(series: { t: number; v: number; travel: number }[], low: number, high: number): { t: number; made: number }[] {
  const out: { t: number; made: number }[] = [];
  let prevLow: boolean | null = null;
  let lastEdge = -Infinity;
  for (const p of series) {
    if (!Number.isFinite(p.v) || !Number.isFinite(p.travel) || p.travel <= 0) continue;
    const isLow = p.v < p.travel * low;
    const isHigh = p.v >= p.travel * high;
    if (prevLow === true && isHigh && p.t - lastEdge >= REFRACTORY_MS) {
      out.push({ t: p.t, made: 1 });
      lastEdge = p.t;
    }
    prevLow = isLow;
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
  const count = (vals: number[]) => edgeEvents(mk(vals), 10_000).reduce((n, e) => n + e.made, 0);

  const dc = derivedCounterFor('BOTTOMMILLING03');
  eq(dc?.kind, 'stroke', 'BOTTOMMILLING03 counts strokes');
  eq(dc?.key, 'current_stroke_pulse', 'exact code');
  eq(derivedCounterFor('bottom-milling 03')?.kind, 'stroke', 'punctuation + case');
  eq(derivedCounterFor('BOTTOMMILLING04'), null, 'other machines untouched');

  // threshold kind — unchanged behaviour
  eq(count([3392, 3392, 50000, 50000, 3392]), 1, 'one burst = one piece');
  eq(count([3392, 50000, 3392, 3392, 3392, 3392, 3392, 3392, 3392, 3392, 3392, 50000]), 2, 'two bursts far apart = two');
  eq(count([50000, 50000, 3392]), 0, 'window opening mid-burst counts nothing');
  eq(count([3392, 50000, 3392, 50000]), 1, 'a flap 20s after an edge is the SAME piece (refractory)');
  eq(count([3392, 3392]), 0, 'never at threshold = nothing');
  eq(edgeEvents([], 10_000).length, 0, 'empty series');

  // stroke kind — the floor's own trace, condensed (travel 450k → 480k mid-shift)
  const T = 450_000;
  const mks = (pts: [number, number, number?][]) => pts.map(([sec, v, tr]) => ({ t: sec * S, v, travel: tr ?? T }));
  const strokes = (pts: [number, number, number?][]) => strokeEvents(mks(pts), 0.25, 0.5).reduce((n, e) => n + e.made, 0);
  eq(strokes([[0, 0], [2, 450000], [9, 0]]), 1, 'one climb and return = one piece');
  eq(strokes([[0, 0], [2, 450000], [9, 0], [15, 433000], [17, 0]]), 1, 'a second stroke 15s later is the SAME piece');
  eq(strokes([[0, 0], [2, 450000], [9, 0], [90, 450000], [98, 0]]), 2, 'a stroke 90s later is the next piece');
  eq(strokes([[0, 0], [2, 450000], [9, 0], [200, 480000, 480000], [210, 0, 480000]]), 2, 'the travel setting moving mid-shift changes nothing');
  eq(strokes([[0, 0], [2, 200000]]), 0, 'a climb to 44% of travel is not a stroke');
  eq(strokes([[0, 0], [1, 115000], [2, 300000, 480000], [3, 0, 480000]]), 0, 'the previous reading is judged against ITS OWN travel (115k is not below 450k×0.25)');
  eq(strokes([[0, 450000], [9, 0]]), 0, 'window opening mid-stroke counts nothing');
  eq(strokes([[0, 0], [2, 450000, NaN]]), 0, 'no travel on the reading = no judgement');
  eq(strokeEvents([], 0.25, 0.5).length, 0, 'empty stroke series');
  console.log('derivedCounters: all checks passed');
}
