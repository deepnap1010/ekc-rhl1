// server/src/services/derivedCounter.service.ts
// The ONE way to count a derived-counter machine's pieces (config/derivedCounters).
// Every surface — machine card, targets board, dia trace, hourly bars — goes
// through here, because three hand-rolled copies of "fetch the signal, map it,
// find the edges" is exactly how they drift apart.
import { Telemetry } from '../models/Telemetry.js';
import { isNumericValue } from '../utils/normalize.js';
import { refMatch } from '../utils/machineRef.js';
import { derivedCounterFor, edgeEvents, REFRACTORY_MS, type DerivedCounter } from '../config/derivedCounters.js';

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
  const rows = await Telemetry.find({
    machineId: refs.length > 1 ? { $in: refs } : refMatch(refs[0] ?? ''),
    timestamp: range,
  }).sort({ timestamp: 1 }).select({ timestamp: 1, [`data.${dc.key}`]: 1 }).lean();

  // isNumericValue, not Number(): a null/'' reading is a MISSING sample, and
  // Number(null) === 0 would read as a dip below the threshold — manufacturing
  // a fresh rising edge, and a piece, out of a collector hiccup.
  const series = rows
    .filter((r) => isNumericValue((r.data as Record<string, unknown>)?.[dc.key]))
    .map((r) => ({ t: +new Date(r.timestamp as Date), v: Number((r.data as Record<string, unknown>)[dc.key]) }));

  const fromMs = from.getTime();
  return edgeEvents(series, dc.threshold).filter((e) => e.t >= fromMs);
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
