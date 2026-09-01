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

  const rows = await Telemetry.aggregate([
    // $in of exact strings, never a regex: a case-insensitive regex cannot use
    // {machineId, timestamp} and turns this into a full collection scan.
    { $match: { machineId: { $in: refs.flatMap(refCandidates) }, timestamp: range } },
    { $addFields: { pv: { $getField: { field: dc.key, input: '$data' } } } },
    // Numeric only — a null or '' reading is a MISSING sample, and treating it
    // as 0 would read a collector hiccup as a dip and invent a piece from it.
    { $match: { pv: { $type: NUMERIC } } },
    { $setWindowFields: {
      partitionBy: '$machineId',
      sortBy: { timestamp: 1 },
      output: { prev: { $shift: { output: '$pv', by: -1, default: null } } },
    } },
    // A rising edge: at or above the threshold, with the previous numeric
    // reading below it. The first sample in the window has no previous reading,
    // and $ifNull makes it not-below — so a window opening mid-burst does not
    // count that burst, and no piece is counted twice across adjacent windows.
    { $match: { $expr: { $and: [
      { $gte: ['$pv', dc.threshold] },
      { $lt: [{ $ifNull: ['$prev', dc.threshold] }, dc.threshold] },
    ] } } },
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
