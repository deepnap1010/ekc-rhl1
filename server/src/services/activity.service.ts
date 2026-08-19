// server/src/services/activity.service.ts
// THE range-metrics engine. Reconstructs, for any [from, to] window, what every
// visible machine did: running/idle/stopped/offline time, whether it reported,
// and the production-counter delta. Read-only over `telemetries` (readings in
// range) + `downtime_reports` (overlapping spans) — nothing is written.
//
// Single source of truth shared by /machines/activity, the filtered dashboard,
// and the performance rankings, so those surfaces can never disagree.
import { Machine } from '../models/Machine.js';
import { Telemetry } from '../models/Telemetry.js';
import { DowntimeEvent } from '../models/DowntimeEvent.js';
import { flattenData } from '../utils/flatten.js';
import { pickProductionKey } from '../utils/production.js';
import { isNumericValue } from '../utils/normalize.js';
import { cached } from '../utils/cache.js';

export interface ActivityRow {
  code: string;
  name: string;
  type: string | null;
  status: string;            // dominant state during the range
  live: boolean;             // machine actually sent data in the range
  readings: number;
  firstSeen: Date | null;
  lastSeen: Date | null;
  runningMs: number;
  idleMs: number;
  stoppedMs: number;
  offlineMs: number;
  production: number | null; // counter delta over the range
  productionKey: string | null;
}

export interface ActivityResult {
  rows: ActivityRow[];
  windowMs: number;
  from: Date;
  to: Date;                  // clipped to now — future time never counts
}

type LeanM = { _id: unknown; code?: string; machineId?: string; name?: string; machineName?: string; type?: string; machineType?: string };
type TeleRow = {
  _id: string; readings: number; firstSeen: Date; lastSeen: Date;
  firstData?: Record<string, unknown>; lastData?: Record<string, unknown>;
};

const aliasMatch = (refs: string[]): Record<string, unknown> =>
  ({ $or: [{ code: { $in: refs } }, { machineId: { $in: refs } }] });

/**
 * @param scope user's machine scope (null = unrestricted)
 * @param only  optional further restriction to specific machine refs (code/machineId aliases)
 */
export async function computeActivity(
  scope: string[] | null,
  fromD: Date,
  toD: Date,
  only?: string[] | null
): Promise<ActivityResult> {
  // Only elapsed time counts — a "today 00:00–23:59" range picked at 14:00 must
  // not report the future 10 hours as running time.
  const endMs = Math.min(toD.getTime(), Date.now());
  if (endMs <= fromD.getTime()) return { rows: [], windowMs: 0, from: fromD, to: fromD };
  const endD = new Date(endMs);

  // Visible machines first; their code/machineId aliases then bound the telemetry
  // and downtime queries so both ride their machineId-leading indexes.
  const conds: Record<string, unknown>[] = [];
  if (scope) conds.push(aliasMatch(scope));
  if (only && only.length) conds.push(aliasMatch(only));
  const machines = (await Machine.find(conds.length ? { $and: conds } : {})
    .select({ code: 1, machineId: 1, name: 1, machineName: 1, type: 1, machineType: 1 })
    .lean()) as LeanM[];
  const refs = [...new Set(machines.flatMap((m) => [m.code, m.machineId].filter(Boolean) as string[]))];

  const cacheKey = 'activity:' + JSON.stringify(scope || 'all') + ':' + JSON.stringify(only || null)
    + ':' + fromD.toISOString() + ':' + toD.toISOString();

  const [tele, events] = await Promise.all([
    // One reading-count + first/last reading (timestamp AND payload) per machine.
    // Sort DESC so {machineId:1, timestamp:-1} backs the sort (ascending blew the
    // 32MB in-memory limit). Newest-first: $first = latest, $last = earliest.
    // Cached 30s per (scope, only, window) so polling clients share one scan.
    cached(cacheKey, 30_000, () =>
      Telemetry.aggregate([
        { $match: { machineId: { $in: refs }, timestamp: { $gte: fromD, $lte: endD } } },
        { $sort: { machineId: 1, timestamp: -1 } },
        { $group: {
          _id: '$machineId', readings: { $sum: 1 },
          firstSeen: { $last: '$timestamp' }, lastSeen: { $first: '$timestamp' },
          firstData: { $last: '$data' }, lastData: { $first: '$data' },
        } },
      ]).option({ allowDiskUse: true, maxTimeMS: 20000 }).exec()),
    DowntimeEvent.find({
      machineId: { $in: refs },
      startedAt: { $lte: endD },
      $or: [{ endedAt: null }, { endedAt: { $gte: fromD } }],
    }).select({ machineId: 1, type: 1, startedAt: 1, endedAt: 1 }).maxTimeMS(20000).lean(),
  ]);

  const teleBy = new Map<string, TeleRow>((tele as TeleRow[]).map((t) => [t._id, t]));

  // Production over the range = counter delta between first and last reading.
  // Key selection is shared (utils/production) with the event engine + client.
  const productionOf = (t?: TeleRow): { key: string; production: number } | null => {
    if (!t?.lastData) return null;
    const last = flattenData(t.lastData);
    const first = flattenData(t.firstData || {});
    const key = pickProductionKey(last);
    if (!key) return null;
    const end = Number(last[key]);
    // A null/'' first reading must NOT coerce to 0 (that would report the full
    // counter value as "production in range").
    const start = isNumericValue(first[key]) ? Number(first[key]) : Number.NaN;
    // Counter reset mid-range (delta negative) → best effort: the end value.
    const delta = Number.isFinite(start) ? end - start : 0;
    return { key, production: delta >= 0 ? delta : end };
  };

  const downBy = new Map<string, { idle: number; stopped: number; offline: number }>();
  for (const e of events) {
    const start = Math.max(new Date(e.startedAt).getTime(), fromD.getTime());
    const end = Math.min(e.endedAt ? new Date(e.endedAt).getTime() : endMs, endMs);
    if (end <= start) continue;
    const d = downBy.get(e.machineId) || { idle: 0, stopped: 0, offline: 0 };
    d[e.type] += end - start;
    downBy.set(e.machineId, d);
  }

  const windowMs = endMs - fromD.getTime();
  const rows: ActivityRow[] = machines.map((m) => {
    const ref = m.code || m.machineId || String(m._id);
    const t = teleBy.get(ref) ?? (m.machineId ? teleBy.get(m.machineId) : undefined);
    const down =
      downBy.get(ref) ?? (m.machineId ? downBy.get(m.machineId) : undefined) ?? { idle: 0, stopped: 0, offline: 0 };
    const downMs = down.idle + down.stopped + down.offline;
    const readings = t?.readings || 0;
    // Time not covered by a downtime span counts as running only if the machine
    // actually reported in the range — silence with no spans is "no data", not uptime.
    // Known ceiling: a machine that reported briefly and then went silent while its
    // status stayed "running" (so no offline span was recorded) still gets full
    // credit — running time is only as truthful as the reported status timeline.
    const runningMs = readings > 0 ? Math.max(0, windowMs - downMs) : 0;
    let status = 'offline';
    if (readings > 0 || downMs > 0) {
      const buckets: [string, number][] = [
        ['running', runningMs], ['idle', down.idle], ['stopped', down.stopped], ['offline', down.offline],
      ];
      buckets.sort((a, b) => b[1] - a[1]);
      status = buckets[0][0];
    }
    const prod = productionOf(t);
    return {
      code: ref,
      name: m.name || m.machineName || ref,
      type: m.type || m.machineType || null,
      status, live: readings > 0, readings,
      firstSeen: t?.firstSeen || null, lastSeen: t?.lastSeen || null,
      runningMs, idleMs: down.idle, stoppedMs: down.stopped, offlineMs: down.offline,
      production: prod?.production ?? null,
      productionKey: prod?.key ?? null,
    };
  });

  return { rows, windowMs, from: fromD, to: endD };
}
