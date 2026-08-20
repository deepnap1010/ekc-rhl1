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

  const cacheKey = 'activity3:' + JSON.stringify(scope || 'all') + ':' + JSON.stringify(only || null)
    + ':' + fromD.toISOString() + ':' + toD.toISOString();

  const [teleAgg, events] = await Promise.all([
    // Cached 30s per (scope, only, window) so polling clients share one scan.
    cached(cacheKey, 30_000, async () => {
      const [tele, minutes] = await Promise.all([
        // One reading-count + first/last reading (timestamp AND payload) per
        // machine. Sort DESC so {machineId:1, timestamp:-1} backs the sort.
        Telemetry.aggregate([
          { $match: { machineId: { $in: refs }, timestamp: { $gte: fromD, $lte: endD } } },
          { $sort: { machineId: 1, timestamp: -1 } },
          { $group: {
            _id: '$machineId', readings: { $sum: 1 },
            firstSeen: { $last: '$timestamp' }, lastSeen: { $first: '$timestamp' },
            firstData: { $last: '$data' }, lastData: { $first: '$data' },
          } },
        ]).option({ allowDiskUse: true, maxTimeMS: 20000 }).exec(),
        // Reporting minutes per machine (the actual minute stamps, not just a
        // count) — running time is only credited for time the machine ACTUALLY
        // reported. Gaps between readings up to a small grace are bridged, since
        // the collector may post only every few minutes / on change.
        Telemetry.aggregate([
          { $match: { machineId: { $in: refs }, timestamp: { $gte: fromD, $lte: endD } } },
          { $group: { _id: { m: '$machineId', t: { $dateTrunc: { date: '$timestamp', unit: 'minute' } } } } },
          { $group: { _id: '$_id.m', ts: { $push: '$_id.t' } } },
        ]).option({ allowDiskUse: true, maxTimeMS: 20000 }).exec(),
      ]);
      return { tele, minutes };
    }),
    DowntimeEvent.find({
      machineId: { $in: refs },
      startedAt: { $lte: endD },
      $or: [{ endedAt: null }, { endedAt: { $gte: fromD } }],
    }).select({ machineId: 1, type: 1, startedAt: 1, endedAt: 1 }).maxTimeMS(20000).lean(),
  ]);

  const teleBy = new Map<string, TeleRow>(((teleAgg as { tele: TeleRow[] }).tele).map((t) => [t._id, t]));
  const minutesBy = new Map<string, number[]>(
    ((teleAgg as { minutes: { _id: string; ts: Date[] }[] }).minutes)
      .map((m) => [m._id, m.ts.map((d) => new Date(d).getTime())]),
  );

  // Coverage of the reporting minute-stamps: consecutive readings up to
  // GRACE_MS apart bridge as continuous reporting (collectors that post every
  // 2-5 minutes / on change must not lose runtime), each reading's own minute
  // always counts, and silence beyond the grace is never credited.
  const GRACE_MS = 5 * 60_000;
  const coverageMs = (stamps: number[]): number => {
    if (!stamps.length) return 0;
    const s = [...stamps].sort((a, b) => a - b);
    let cov = 60_000; // the last reading's own minute
    for (let i = 0; i < s.length - 1; i += 1) cov += Math.min(s[i + 1] - s[i], GRACE_MS);
    return cov;
  };

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

  // Window-clipped spans per machine (kept span-level: runningMs below needs
  // per-span overlap with the machine's reporting envelope).
  type Span = { type: 'idle' | 'stopped' | 'offline'; s: number; e: number };
  const spansBy = new Map<string, Span[]>();
  for (const ev of events) {
    const s = Math.max(new Date(ev.startedAt).getTime(), fromD.getTime());
    const e = Math.min(ev.endedAt ? new Date(ev.endedAt).getTime() : endMs, endMs);
    if (e <= s) continue;
    const arr = spansBy.get(ev.machineId) || [];
    arr.push({ type: ev.type as Span['type'], s, e });
    spansBy.set(ev.machineId, arr);
  }

  const windowMs = endMs - fromD.getTime();
  const rows: ActivityRow[] = machines.map((m) => {
    const ref = m.code || m.machineId || String(m._id);
    const t = teleBy.get(ref) ?? (m.machineId ? teleBy.get(m.machineId) : undefined);
    const spans = [
      ...(spansBy.get(ref) || []),
      ...(m.machineId && m.machineId !== ref ? spansBy.get(m.machineId) || [] : []),
    ];
    const down = { idle: 0, stopped: 0, offline: 0 };
    for (const sp of spans) down[sp.type] += sp.e - sp.s;
    const downMs = down.idle + down.stopped + down.offline;
    const readings = t?.readings || 0;
    // Running time = time the machine ACTUALLY reported, minus downtime — but
    // only the downtime that OVERLAPS the machine's reporting envelope
    // [firstSeen, lastSeen]. A silent overnight offline/idle span covers time
    // that was never in reportedMs; subtracting it too would erase real morning
    // runtime 1:1 (machines showed "offline" with hundreds of fresh readings).
    // ponytail: envelope overlap, not per-minute intersection — a silent span
    // WHOLLY INSIDE the envelope (report, silent-idle midday, report again)
    // still double-subtracts; refine to reported-minute intersection if that
    // pattern ever matters.
    const stamps = [
      ...(minutesBy.get(ref) || []),
      ...(m.machineId && m.machineId !== ref ? minutesBy.get(m.machineId) || [] : []),
    ];
    const reportedMs = Math.min(windowMs, coverageMs(stamps));
    let downInEnvelope = 0;
    const envS = t?.firstSeen ? new Date(t.firstSeen).getTime() : null;
    const envE = t?.lastSeen ? new Date(t.lastSeen).getTime() : null;
    if (envS != null && envE != null && envE > envS) {
      for (const sp of spans) {
        const os = Math.max(sp.s, envS);
        const oe = Math.min(sp.e, envE);
        if (oe > os) downInEnvelope += oe - os;
      }
    }
    const runningMs = readings > 0 ? Math.max(0, reportedMs - downInEnvelope) : 0;
    // Dominant state: silent, span-less time counts toward offline so a
    // mostly-dark machine never ranks as "running".
    const silentMs = Math.max(0, windowMs - reportedMs - down.offline);
    let status = 'offline';
    if (readings > 0 || downMs > 0) {
      const buckets: [string, number][] = [
        ['running', runningMs], ['idle', down.idle], ['stopped', down.stopped], ['offline', down.offline + silentMs],
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
