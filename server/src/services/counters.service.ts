// server/src/services/counters.service.ts
// The shared way to turn raw telemetry into CONFIRMED production steps per
// machine. Both the targets report (the dashboard's Production vs Target cards)
// and the dia trace need exactly this, and used to carry their own copy — so a
// change to one silently disagreed with the other, and both paid the same two
// avoidable costs on every cold request.
import { Telemetry } from '../models/Telemetry.js';
import { flattenData } from '../utils/flatten.js';
import { pickProductionKey } from '../utils/production.js';
import { cached } from '../utils/cache.js';
import { stepEvents, PROD_STEP_PER_MIN } from './activity.service.js';

const NUMERIC = ['int', 'long', 'double', 'decimal'];
const DAY = 24 * 3_600_000;

/** Each machine's production-counter key, read from its latest payload.
 *  Looked up in PARALLEL — one round trip instead of one per machine — and
 *  cached: a register map changes when a PLC is reprogrammed, not between page
 *  loads. (Measured on this fleet: 679ms sequential -> 254ms parallel -> 0 warm.) */
export function counterKeys(machines: string[]): Promise<{ ref: string; key: string }[]> {
  return cached(`counterkeys:${[...machines].sort().join(',')}`, 5 * 60_000, async () => {
    const found = await Promise.all(machines.map(async (ref) => {
      const last = await Telemetry.findOne({ machineId: ref }).sort({ timestamp: -1 })
        .select({ data: 1 }).lean();
      const k = last?.data ? pickProductionKey(flattenData(last.data as Record<string, unknown>)) : null;
      return k && !k.includes('.') ? { ref, key: k } : null;
    }));
    return found.filter((x): x is { ref: string; key: string } => x !== null);
  });
}

/** Confirmed counter steps per machine within [from, to]. Machines that publish
 *  no counter are simply absent from the map — that is what lets a caller tell
 *  "made nothing" from "cannot count". */
export async function productionEventsBy(
  machines: string[], from: Date, to?: Date | null,
): Promise<Map<string, { t: number; made: number }[]>> {
  const out = new Map<string, { t: number; made: number }[]>();
  if (!machines.length) return out;
  const keyed = await counterKeys(machines);
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

  for (const s of series) {
    const pts = s.rows.map((p) => ({ t: +new Date(p._id), v: Number(p.pv) }))
      .filter((p) => Number.isFinite(p.v))
      .sort((a, b) => a.t - b.t);
    out.set(s.ref, stepEvents(pts, PROD_STEP_PER_MIN));
  }
  return out;
}
