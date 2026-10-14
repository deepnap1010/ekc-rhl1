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
// Each reading is judged on its own — LOW, HIGH, or NEITHER — and a NEITHER
// reading (the head mid-climb, between the two bands) says nothing about the
// cycle. A cycle is the first HIGH reading after a LOW one, however many
// readings fell between. Asking for the LOW reading to be the one IMMEDIATELY
// before the HIGH one counted NOTHING on BOTTOMMILLING03 through a 69-piece
// shift on 14 Oct 2026: with travel at 650,000 and a reading every ~2 s the
// head climbs ~94,000 pulses per reading, so every climb read 0 → 245,766 →
// 339,844 — the middle reading in the dead band, every time.
//
// A machine may carry a second rule on another signal (`also`). A piece is then
// counted when EITHER rule completes a cycle, and the two share one refractory,
// so a piece both of them see is one piece — each covers the other's blind spot.
//
// BOTTOMMILLING03 is the case in point. As of Sept 2026 its PLC publishes only
// speeds, torque and pulses — no counter. It counted by processing_speed dips
// until a job held the speed constant all day (33,920, never dipping) and the
// count went to zero while the machine milled. current_stroke_pulse is the
// head's motion, program-independent: traced against a shift the floor knew
// (SPG05 made 23 on the same line), strokes gave 21 and the status signal 22.
// About 40% of pieces get a second short stroke within seconds of the first
// (an approach or re-cut) — the 30s refractory folds that into the same piece.
// Speed is back as the SECOND signal: on 14 Oct the two agreed within a piece
// (strokes 57, speed 58), and together they still count a constant-speed job
// (speed blind, strokes see it) and a short-stroke job (strokes blind, speed
// sees it). Speed rests at 3,392 between pieces and cuts at 15,000–50,000 by
// job, so its threshold sits just above rest — at 39,000 the slower-feed jobs
// vanished (34 pieces).
// ponytail: switching ONTO a constant-feed program while the head rests reads
// as one rise of speed, so it adds one piece at the switch. Bounded — once per
// switch, and the one such program seen so far ran from the shift's first
// reading, which is baseline and counts nothing.
import { normRef } from './lineLinks.js';

/** One way of seeing a piece in a signal. */
export type CountRule =
  | { kind: 'threshold'; key: string; threshold: number }
  | { kind: 'stroke'; key: string; travelKey: string; low: number; high: number };

/** A machine's derived counter: its rule, and optionally a second one on
 *  another signal (`also`) — a piece counts when either completes a cycle.
 *  `key`, the first rule's signal, is what screens name the count after. */
export type DerivedCounter = CountRule & { also?: CountRule };

const DERIVED: Record<string, DerivedCounter> = {
  BOTTOMMILLING03: {
    kind: 'stroke', key: 'current_stroke_pulse', travelKey: 'travel_setting_pulse', low: 0.25, high: 0.5,
    also: { kind: 'threshold', key: 'processing_speed', threshold: 10_000 },
  },
};

const BY_NORM: Record<string, DerivedCounter> = Object.fromEntries(
  Object.entries(DERIVED).map(([code, d]) => [normRef(code), d]),
);

export const derivedCounterFor = (ref: string): DerivedCounter | null => BY_NORM[normRef(ref)] ?? null;

/** Every rule a counter applies — its own, then its `also`. */
export const rulesOf = (dc: DerivedCounter): CountRule[] => (dc.also ? [dc, dc.also] : [dc]);

// A real stroke lasts 2–15s and real pieces arrive ≥50s apart (measured); a
// second climb inside this window is the same piece, not a new one — and so is
// the other signal seeing the same piece a few seconds apart. Callers query
// this far BEFORE their window so the refractory survives a window boundary
// (services/derivedCounter).
// ponytail: fixed 30s refractory; make it per-machine config if a faster
// derived machine ever joins.
export const REFRACTORY_MS = 30_000;

// ── the Node twin of services/derivedCounter ─────────────────────────────────
// The service finds the cycles in the database; these say the same over an
// in-memory series, for the self-check below. Keep the two saying the same.

/** Rises of a threshold signal: every reading is LOW (below) or HIGH; a rise is
 *  a HIGH reading right after a LOW one. The first reading is baseline. */
export function thresholdEdges(series: { t: number; v: number }[], threshold: number): number[] {
  const out: number[] = [];
  let prevLow: boolean | null = null;      // null until the baseline sample
  for (const p of series) {
    if (!Number.isFinite(p.v)) continue;
    const low = p.v < threshold;
    if (prevLow === true && !low) out.push(p.t);
    prevLow = low;
  }
  return out;
}

/** Climbs of a position signal, each reading judged against its OWN travel:
 *  LOW below low×travel, HIGH at or above high×travel, NEITHER in between —
 *  and NEITHER is skipped, so a climb is the first HIGH reading after a LOW
 *  one however many readings the head took to get there. */
export function strokeEdges(series: { t: number; v: number; travel: number }[], low: number, high: number): number[] {
  const out: number[] = [];
  let prev: 'low' | 'high' | null = null;  // the last JUDGED reading; null = baseline
  for (const p of series) {
    if (!Number.isFinite(p.v) || !Number.isFinite(p.travel) || p.travel <= 0) continue;
    const z = p.v < p.travel * low ? 'low' : p.v >= p.travel * high ? 'high' : null;
    if (z === null) continue;              // mid-climb: says nothing
    if (z === 'high' && prev === 'low') out.push(p.t);
    prev = z;
  }
  return out;
}

/** Edges → pieces, whichever rule found them: an edge inside the refractory of
 *  the last counted one is the same piece. */
export function withRefractory(edges: number[]): { t: number; made: number }[] {
  const out: { t: number; made: number }[] = [];
  let lastEdge = -Infinity;
  for (const t of [...edges].sort((a, b) => a - b)) {
    if (t - lastEdge < REFRACTORY_MS) continue;
    lastEdge = t;
    out.push({ t, made: 1 });
  }
  return out;
}

/** One threshold signal. The first sample is baseline — a window that opens
 *  mid-burst does not count that burst, exactly as stepEvents treats its first
 *  reading, so a piece is never counted twice across adjacent windows. */
export const edgeEvents = (series: { t: number; v: number }[], threshold: number): { t: number; made: number }[] =>
  withRefractory(thresholdEdges(series, threshold));

/** One stroke signal. Same baseline and refractory rules as edgeEvents. */
export const strokeEvents = (series: { t: number; v: number; travel: number }[], low: number, high: number): { t: number; made: number }[] =>
  withRefractory(strokeEdges(series, low, high));

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
  eq(dc?.also, { kind: 'threshold', key: 'processing_speed', threshold: 10_000 }, '…and its processing speed beside them');
  eq(dc ? rulesOf(dc).map((r) => r.key) : [], ['current_stroke_pulse', 'processing_speed'], 'two rules, strokes first');
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
  eq(strokes([[0, 130000], [2, 300000, 480000]]), 0, 'each reading is judged against ITS OWN travel: 130k is not low against 450k');
  eq(strokes([[0, 130000, 600000], [2, 300000, 480000]]), 1, '…and the same 130k IS low against a 600k travel');
  eq(strokes([[0, 450000], [9, 0]]), 0, 'window opening mid-stroke counts nothing');
  eq(strokes([[0, 0], [2, 450000, NaN]]), 0, 'no travel on the reading = no judgement');
  eq(strokeEvents([], 0.25, 0.5).length, 0, 'empty stroke series');

  // 14 Oct 2026, the floor exactly: travel 650k, a reading every ~2s, the head
  // stepping ~94k per reading — every climb has a reading in the dead band.
  const B = 650_000;
  const at = (pts: [number, number][]) => pts.map(([sec, v]) => [sec, v, B] as [number, number, number]);
  eq(strokes(at([[0, 0], [2, 245766], [4, 339844], [6, 433965], [8, 528344], [10, 622439], [12, 650000], [14, 443589], [16, 208253], [18, 0]])), 1,
    'a climb with a reading in the 25-50% band is still one piece (13:30)');
  eq(strokes(at([[0, 0], [2, 220478], [4, 314598], [6, 408718], [8, 502855], [10, 650000], [60, 0], [62, 220478], [64, 314598], [66, 408718]])), 2,
    'two climbs a minute apart, two readings each in the band, are two pieces (13:26)');

  // both signals — a piece when EITHER completes a cycle, one refractory.
  // Points are [second, stroke, speed].
  const both = (pts: [number, number, number][]) => withRefractory([
    ...strokeEdges(pts.map(([sec, v]) => ({ t: sec * S, v, travel: B })), 0.25, 0.5),
    ...thresholdEdges(pts.map(([sec, , sp]) => ({ t: sec * S, v: sp })), 10_000),
  ]).length;
  const cycle = (t0: number, cut = 40_000, rest = 3_392, peak = B): [number, number, number][] => [
    [t0, 0, rest], [t0 + 2, Math.min(245_766, peak), cut], [t0 + 4, Math.min(339_844, peak), cut], [t0 + 6, Math.min(528_344, peak), cut],
    [t0 + 8, peak, rest], [t0 + 10, Math.min(208_253, peak), rest], [t0 + 12, 0, rest],
  ];
  eq(both(cycle(0)), 1, 'stroke and speed see the same piece 2s apart: one piece');
  eq(both([...cycle(0), ...cycle(80)]), 2, 'two cycles 80s apart: two pieces');
  eq(both([...cycle(0, 33_920, 33_920), ...cycle(80, 33_920, 33_920)]), 2, 'speed held constant all along (the job that zeroed the old speed rule): strokes still count');
  eq(both([...cycle(0, 40_000, 3_392, 280_000), ...cycle(80, 40_000, 3_392, 280_000)]), 2, 'strokes that never reach half travel: speed still counts');
  eq(both([...cycle(0), ...cycle(16)]), 1, 'a re-cut 16s later, seen by both signals: still one piece');
  eq(both([[0, 0, 3_392], [10, 0, 3_392], [20, 0, 3_392]]), 0, 'neither signal moving: nothing');
  eq(both([...cycle(0), [80, 0, 33_920], [100, 0, 33_920], ...cycle(160, 33_920, 33_920)]), 3,
    'known cost: switching ONTO a constant feed while the head rests reads as one rise of speed — one extra piece, once per switch');
  console.log('derivedCounters: all checks passed');
}
