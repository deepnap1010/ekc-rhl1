// server/src/services/counters.service.ts
// The shared way to turn raw telemetry into CONFIRMED production steps per
// machine. Both the targets report (the dashboard's Production vs Target cards)
// and the dia trace need exactly this, and used to carry their own copy — so a
// change to one silently disagreed with the other, and both paid the same two
// avoidable costs on every cold request.
import { Telemetry } from '../models/Telemetry.js';
import { excludedPiecesBy } from '../utils/prodclass.js';
import { stepEvents, PROD_STEP_PER_MIN } from './activity.service.js';
import { derivedCounterFor } from '../config/derivedCounters.js';
import { derivedEventsBy } from './derivedCounter.service.js';
import { loadCorrections, correctSteps } from '../utils/corrections.js';
import { counterKeys, windowKeys } from './counterKey.service.js';

export { counterKeys };

const NUMERIC = ['int', 'long', 'double', 'decimal'];
const DAY = 24 * 3_600_000;

/** Confirmed counter steps per machine within [from, to], with the
 *  error-correction book applied (utils/corrections): inside a corrected
 *  period the register's steps give way to the correction's pieces, and a
 *  machine with no counter at all still made what a correction says it did.
 *  Machines that publish no counter and carry no correction are simply
 *  absent from the map — that is what lets a caller tell "made nothing" from
 *  "cannot count". */
export async function productionEventsBy(
  machines: string[], from: Date, to?: Date | null,
): Promise<Map<string, { t: number; made: number }[]>> {
  const out = await rawProductionEventsBy(machines, from, to);
  const fromD = from ?? new Date(0), toD = to ?? new Date();
  const corr = await loadCorrections(machines, fromD, toD);
  if (!corr.size) return out;
  const spelling = new Map(machines.map((m) => [m.toUpperCase(), m]));
  for (const [k, list] of corr) {
    const ref = [...out.keys()].find((x) => x.toUpperCase() === k) ?? spelling.get(k) ?? list[0].machineRef;
    if (!list.some((c) => c.pieces != null) && !out.has(ref)) continue;
    out.set(ref, correctSteps(out.get(ref) || [], list, fromD.getTime(), toD.getTime()));
  }
  return out;
}

/** The register's own steps, before any correction. */
async function rawProductionEventsBy(
  machines: string[], from: Date, to?: Date | null,
): Promise<Map<string, { t: number; made: number }[]>> {
  const out = new Map<string, { t: number; made: number }[]>();
  if (!machines.length) return out;

  // The register is the plant's own number and always wins. Only a machine
  // whose payload carries NO register falls back to its derived rule
  // (config/derivedCounters) — edges in a raw signal, read from the raw series
  // because per-bin $max erases the dips the edges live in.
  const keyed = await counterKeys(machines);
  // No standing key is not yet "cannot count": the window's own last and first
  // reading are asked too — the two the card reads — so the board, the bars
  // and the reports find a counter wherever the card finds one.
  const standing = new Set(keyed.map((k) => k.ref));
  const unkeyed = machines.filter((m) => !standing.has(m));
  if (unkeyed.length) keyed.push(...await windowKeys(unkeyed, from, to));
  const registered = new Set(keyed.map((k) => k.ref));
  const recovered = new Set(keyed.filter((k) => k.recovered).map((k) => k.ref));
  const fallback = machines.filter((m) => !registered.has(m) && derivedCounterFor(m));
  // Classified-away pieces come OFF the step that made them — for a derived
  // counter exactly as for a register (see below); an operator's "dry cycle"
  // on BOTTOMMILLING03 is not production either.
  const excl = await excludedPiecesBy([...keyed.map((k) => k.ref), ...fallback], from ?? new Date(0), to ?? new Date());
  const takeOff = (ref: string, evs: { t: number; made: number }[]): { t: number; made: number }[] => {
    for (const x of excl.get(ref.toUpperCase()) || []) {
      let n = x.n;
      for (let i = evs.length - 1; i >= 0 && n > 0; i -= 1) {
        if (evs[i].t > x.t) continue;
        const take = Math.min(n, evs[i].made);
        evs[i].made -= take; n -= take;
      }
    }
    return evs.filter((e) => e.made > 0);
  };
  for (const [ref, evs] of await derivedEventsBy(fallback, from, to)) out.set(ref, takeOff(ref, evs));
  if (!keyed.length) return out;

  // Bin width scales with the span — 5-minute bins keep a month's pipeline
  // inside what this Atlas tier tolerates, and hour attribution only needs
  // sub-hour resolution anyway.
  const binSize = (to ? to.getTime() : Date.now()) - from.getTime() > 2 * DAY ? 5 : 1;
  const range: Record<string, Date> = { $gte: from };
  if (to) range.$lte = to;

  // ONE AGGREGATION PER MACHINE, all in flight together. Each is a plain index
  // range on {machineId, timestamp} instead of a $switch re-evaluated against
  // every document in the window; measured 2556ms -> 780ms on this fleet for
  // identical output. It also retires the empty-$switch crash that a
  // single-machine scope used to hit. No post-$group sort (the tier ignores
  // allowDiskUse) — the series is ordered in Node.
  const series = await Promise.all(keyed.map(async (k) => {
    const rows = await Telemetry.aggregate([
      { $match: { machineId: k.ref, timestamp: range } },
      { $addFields: { pv: { $getField: { field: k.key, input: '$data' } } } },
      { $match: { pv: { $type: NUMERIC } } },
      { $group: { _id: { $dateTrunc: { date: '$timestamp', unit: 'minute', binSize } }, pv: { $max: '$pv' } } },
    ]).option({ maxTimeMS: 30_000 }).exec() as { _id: Date; pv: number }[];
    return { ref: k.ref, rows };
  }));

  // Classified-away pieces come OFF the step that made them, so every consumer
  // that sums `made` over a window — the targets report, the dia trace — drops
  // them from exactly that window. The event is stamped at the sweep that saw
  // the advance (up to a bin + 30s AFTER the step's bin start), so each one is
  // taken from the latest step at or before its stamp, walking back if that
  // step cannot absorb it — a bin boundary or an hour/operator edge between the
  // two can then never credit one row and debit another. A piece the bins never
  // credited (first bin, a physics-capped preload) has nothing to come off and
  // is dropped, so no row can go below zero.
  for (const s of series) {
    const pts = s.rows.map((p) => ({ t: +new Date(p._id), v: Number(p.pv) }))
      .filter((p) => Number.isFinite(p.v))
      .sort((a, b) => a.t - b.t);
    // A recovered key names the counter; whether the machine COUNTED in this
    // window is for the window's own readings to say. With none of them
    // carrying it the machine stays absent — "cannot count", as it read
    // before the name was recovered — rather than "made nothing".
    if (!pts.length && recovered.has(s.ref)) continue;
    out.set(s.ref, takeOff(s.ref, stepEvents(pts, PROD_STEP_PER_MIN)));
  }
  return out;
}
