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
import { derivedCounterFor, REFRACTORY_MS, type DerivedCounter } from '../config/derivedCounters.js';

const NUMERIC = ['int', 'long', 'double', 'decimal'];

/** Edge events for one machine inside [from, to].
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

  // The two rule kinds share everything but the two tests. Both: numeric
  // samples only — a null or '' reading is a MISSING sample, and treating it
  // as 0 would read a collector hiccup as a dip and invent a piece from it.
  // Each reading is judged against ITSELF ("am I below?", "am I high?") and
  // the "below" verdict is what gets shifted to the next row — so a stroke's
  // previous reading is measured against its OWN travel setting, exactly as
  // strokeEvents does, not against a setting the operator changed since. The
  // first sample in the window has no previous verdict (default false), so a
  // window opening mid-burst (or mid-stroke) does not count it, and no piece
  // is counted twice across adjacent windows.
  const fields: Record<string, unknown> = { pv: { $getField: { field: dc.key, input: '$data' } } };
  const numeric: Record<string, unknown> = { pv: { $type: NUMERIC } };
  let below: unknown, high: unknown;
  if (dc.kind === 'threshold') {
    // A rising edge: at or above the threshold, with the previous reading below.
    below = { $lt: ['$pv', dc.threshold] };
    high = { $gte: ['$pv', dc.threshold] };
  } else {
    // A stroke: from below low×travel to at least high×travel. A reading
    // carrying the position but no travel cannot be judged and is skipped —
    // on the floor that is ~3% of samples, none of them edges.
    fields.tv = { $getField: { field: dc.travelKey, input: '$data' } };
    numeric.tv = { $type: NUMERIC, $gt: 0 };
    below = { $lt: ['$pv', { $multiply: ['$tv', dc.low] }] };
    high = { $gte: ['$pv', { $multiply: ['$tv', dc.high] }] };
  }
  const rows = await Telemetry.aggregate([
    // $in of exact strings, never a regex: a case-insensitive regex cannot use
    // {machineId, timestamp} and turns this into a full collection scan.
    { $match: { machineId: { $in: refs.flatMap(refCandidates) }, timestamp: range } },
    { $addFields: fields },
    { $match: numeric },
    { $setWindowFields: {
      partitionBy: '$machineId',
      sortBy: { timestamp: 1 },
      output: { prevBelow: { $shift: { output: below, by: -1, default: false } } },
    } },
    { $match: { $expr: { $and: [high, '$prevBelow'] } } },
    { $project: { _id: 0, t: '$timestamp' } },
    { $sort: { t: 1 } },
  ]).option({ maxTimeMS: 30_000 }).exec() as { t: Date }[];

  // The refractory still belongs in Node: it is a judgement about what counts
  // as one piece, not a property of the data.
  const fromMs = from.getTime();
  const out: { t: number; made: number }[] = [];
  let lastEdge = -Infinity;
  for (const r of rows) {
    const t = +new Date(r.t);
    if (t - lastEdge < REFRACTORY_MS) continue;   // a flap, not a second piece
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
