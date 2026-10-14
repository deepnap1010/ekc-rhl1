// server/src/services/derivedCounter.service.ts
// The ONE way to count a derived-counter machine's pieces (config/derivedCounters).
// Every surface — machine card, targets board, dia trace, hourly bars — goes
// through here, because three hand-rolled copies of "fetch the signal, find the
// edges" is exactly how they drift apart.
//
// The edges are found IN THE DATABASE, not in Node. Reading the raw signal back
// meant pulling 36,563 documents across the wire for one machine over six days:
// the query itself took 76ms and the transfer took 33 SECONDS on this tier. The
// same window asked as an aggregation returns the 274 edges themselves in 850ms.
// The rule is the general one — move the filter to the data, not the data to the
// filter — and it is worth remembering here because the naive version looked
// perfectly reasonable right up until the collection grew.
import { Telemetry } from '../models/Telemetry.js';
import { refCandidates } from '../utils/machineRef.js';
import { derivedCounterFor, rulesOf, REFRACTORY_MS, type CountRule, type DerivedCounter } from '../config/derivedCounters.js';

const NUMERIC = ['int', 'long', 'double', 'decimal'];

/** The moments one rule sees a cycle, for one machine inside `range`.
 *
 *  Numeric samples only — a null or '' reading is a MISSING sample, and
 *  treating it as 0 would read a collector hiccup as a dip and invent a piece.
 *  Each reading is then judged on its own: HIGH, LOW, or NEITHER (a stroke's
 *  dead band, the head mid-climb). NEITHER readings are dropped before the
 *  comparison, so an edge is a HIGH reading whose last JUDGED reading was LOW,
 *  however many readings the climb took. Asking instead for the reading
 *  immediately before to be LOW counted nothing through a 69-piece shift on
 *  BOTTOMMILLING03 (config/derivedCounters). Each reading is judged against
 *  its OWN travel setting, so a setting the operator moved since changes
 *  nothing. The first judged reading has no previous verdict, so a window
 *  opening mid-burst (or mid-stroke) does not count it. Mirrors the Node twin,
 *  config/derivedCounters#thresholdEdges / #strokeEdges. */
async function ruleEdges(refs: string[], rule: CountRule, range: Record<string, Date>): Promise<number[]> {
  const fields: Record<string, unknown> = { pv: { $getField: { field: rule.key, input: '$data' } } };
  const numeric: Record<string, unknown> = { pv: { $type: NUMERIC } };
  let low: unknown, high: unknown;
  if (rule.kind === 'threshold') {
    // A rise: at or above the threshold, after a reading below it. No dead band.
    low = { $lt: ['$pv', rule.threshold] };
    high = { $gte: ['$pv', rule.threshold] };
  } else {
    // A climb: from below low×travel to at least high×travel. A reading
    // carrying the position but no travel cannot be judged and is skipped —
    // on the floor that is ~3% of samples, none of them edges.
    fields.tv = { $getField: { field: rule.travelKey, input: '$data' } };
    numeric.tv = { $type: NUMERIC, $gt: 0 };
    low = { $lt: ['$pv', { $multiply: ['$tv', rule.low] }] };
    high = { $gte: ['$pv', { $multiply: ['$tv', rule.high] }] };
  }
  const rows = await Telemetry.aggregate([
    // $in of exact strings, never a regex: a case-insensitive regex cannot use
    // {machineId, timestamp} and turns this into a full collection scan.
    { $match: { machineId: { $in: refs.flatMap(refCandidates) }, timestamp: range } },
    { $addFields: fields },
    { $match: numeric },
    // HIGH = 1, LOW = 0, NEITHER = null — and NEITHER says nothing, so it goes.
    // Only what the comparison needs travels on from here.
    { $project: { _id: 0, machineId: 1, timestamp: 1, z: { $switch: { branches: [{ case: high, then: 1 }, { case: low, then: 0 }], default: null } } } },
    { $match: { z: { $ne: null } } },
    { $setWindowFields: {
      partitionBy: '$machineId',
      sortBy: { timestamp: 1 },
      output: { pz: { $shift: { output: '$z', by: -1, default: null } } },
    } },
    { $match: { z: 1, pz: 0 } },
    { $project: { t: '$timestamp' } },
  ]).option({ maxTimeMS: 30_000 }).exec() as { t: Date }[];
  return rows.map((r) => +new Date(r.t));
}

/** Pieces for one machine inside [from, to]: the cycles every rule of its
 *  counter sees, merged, with one refractory across all of them — so a piece
 *  two signals see a few seconds apart is one piece.
 *
 *  The query reaches REFRACTORY_MS BEFORE `from` and the resulting pre-window
 *  edges are dropped afterwards, so the refractory and the baseline carry
 *  across the boundary. Without that lead-in a burst that flaps either side of
 *  a day roll is counted once in each day's report — one piece, milled twice on
 *  paper — and windows of different lengths disagree by one. */
export async function derivedEvents(
  refs: string[], dc: DerivedCounter, from: Date, to?: Date | null,
): Promise<{ t: number; made: number }[]> {
  const range: Record<string, Date> = { $gte: new Date(from.getTime() - REFRACTORY_MS) };
  if (to) range.$lte = to;
  const edges = (await Promise.all(rulesOf(dc).map((rule) => ruleEdges(refs, rule, range)))).flat();

  // The refractory still belongs in Node: it is a judgement about what counts
  // as one piece, not a property of the data.
  const fromMs = from.getTime();
  const out: { t: number; made: number }[] = [];
  let lastEdge = -Infinity;
  for (const t of edges.sort((a, b) => a - b)) {
    if (t - lastEdge < REFRACTORY_MS) continue;   // a flap, a re-cut, or the other signal
    lastEdge = t;
    if (t >= fromMs) out.push({ t, made: 1 });    // pre-window edges only set the clock
  }
  return out;
}

/** Same, keyed by machine, for the machines in `machines` that have a derived
 *  counter. Machines without one are absent from the map. */
export async function derivedEventsBy(
  machines: string[], from: Date, to?: Date | null,
): Promise<Map<string, { t: number; made: number }[]>> {
  const out = new Map<string, { t: number; made: number }[]>();
  await Promise.all(machines.map(async (ref) => {
    const dc = derivedCounterFor(ref);
    if (!dc) return;
    out.set(ref, await derivedEvents([ref], dc, from, to));
  }));
  return out;
}
