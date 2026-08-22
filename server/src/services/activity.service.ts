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

// Consecutive reporting minutes up to this far apart bridge as continuous
// reporting — collectors post every few minutes / on change, so a 2-minute gap
// is not downtime. Silence beyond it is never credited as running time.
const GRACE_MS = 5 * 60_000;

const aliasMatch = (refs: string[]): Record<string, unknown> =>
  ({ $or: [{ code: { $in: refs } }, { machineId: { $in: refs } }] });

export type Span = { type: 'idle' | 'stopped' | 'offline'; s: number; e: number };

/** Collapse a machine's downtime spans into a NON-OVERLAPPING timeline.
 *
 *  The span log can't be trusted to be clean: while two server instances swept
 *  the same database they wrote overlapping rows — and some backwards ones
 *  (endedAt before startedAt) — for the same minutes. Summing those raw reported
 *  more downtime than the window contains, which drove runtime to 0 on machines
 *  that were demonstrably running. Each span is clipped to start after the
 *  previous one ends, so overlapping time is counted ONCE (earliest writer wins)
 *  and the total can never exceed the span of the input. */
export function clipSpans(spans: Span[]): Span[] {
  const out: Span[] = [];
  let cursor = Number.NEGATIVE_INFINITY;
  for (const sp of [...spans].sort((a, b) => a.s - b.s || a.e - b.e)) {
    if (sp.e <= sp.s) continue;                 // backwards row — never real
    const s = Math.max(sp.s, cursor);
    if (sp.e <= s) continue;                    // fully swallowed by an earlier span
    out.push({ type: sp.type, s, e: sp.e });
    cursor = sp.e;
  }
  return out;
}

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

  const cacheKey = 'activity4:' + JSON.stringify(scope || 'all') + ':' + JSON.stringify(only || null)
    + ':' + fromD.toISOString() + ':' + toD.toISOString();
  // Month / year windows scan far more telemetry but change far more slowly:
  // cache them longer and give Atlas more time, so the dashboard's group panels
  // can ask for them without timing out.
  const longWindow = endMs - fromD.getTime() > 7 * 24 * 3600 * 1000;
  const ttlMs = longWindow ? 5 * 60_000 : 30_000;
  const maxTimeMS = longWindow ? 60_000 : 20_000;

  const [teleAgg, events] = await Promise.all([
    // Cached per (scope, only, window) so polling clients share one scan.
    cached(cacheKey, ttlMs, async () => {
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
        ]).allowDiskUse(true).option({ maxTimeMS }).exec(),
        // Reported COVERAGE per machine, summed in the database: running time is
        // only credited for time the machine ACTUALLY reported, with gaps up to
        // GRACE_MS bridged. Summed server-side on purpose — a year-long window
        // holds ~500k reporting minutes per machine and shipping those stamps to
        // Node (the previous $push) did not scale past a few days.
        Telemetry.aggregate([
          { $match: { machineId: { $in: refs }, timestamp: { $gte: fromD, $lte: endD } } },
          { $group: { _id: { m: '$machineId', t: { $dateTrunc: { date: '$timestamp', unit: 'minute' } } } } },
          { $setWindowFields: {
            partitionBy: '$_id.m', sortBy: { '_id.t': 1 },
            output: { prev: { $shift: { output: '$_id.t', by: -1, default: null } } },
          } },
          { $group: {
            _id: '$_id.m',
            minutes: { $sum: 1 },
            coveredMs: { $sum: { $cond: [
              { $eq: ['$prev', null] }, 0,
              { $min: [{ $subtract: ['$_id.t', '$prev'] }, GRACE_MS] },
            ] } },
          } },
        ]).allowDiskUse(true).option({ maxTimeMS }).exec(),
      ]);

      // Production is the sum of the counter's POSITIVE steps inside the window,
      // summed in the database. Last-minus-first was wrong on every machine whose
      // counter resets each shift: INTERNALSHOTBLASTING03 ran 4 → 128, reset to 0
      // at 07:00, climbed to 8 — and reported "4 pcs" for a 132-piece day. Steps
      // are immune: a reset is a negative step, which contributes nothing.
      //
      // Needs the per-machine counter key, which only exists once the pass above
      // has a payload to pick from — hence a second pass, inside the same cache
      // entry. Dotted keys (raw PLC addresses like I0.4) are never counters, so
      // $getField on a flat key covers every real case.
      const keyed = tele
        .map((t: TeleRow) => ({ id: t._id, key: t.lastData ? pickProductionKey(flattenData(t.lastData)) : null }))
        .filter((x): x is { id: string; key: string } => !!x.key && !x.key.includes('.'));

      const made = keyed.length ? await Telemetry.aggregate([
        { $match: { machineId: { $in: keyed.map((k) => k.id) }, timestamp: { $gte: fromD, $lte: endD } } },
        { $addFields: { pv: { $switch: {
          branches: keyed.map((k) => ({ case: { $eq: ['$machineId', k.id] }, then: { $getField: { field: k.key, input: '$data' } } })),
          default: null,
        } } } },
        { $match: { pv: { $type: ['int', 'long', 'double', 'decimal'] } } },
        // One value per reporting MINUTE before the window function — 11k readings
        // a day become ~750 rows, so the sort never spills and a month-long window
        // stays affordable.
        // ponytail: a counter that resets AND climbs again inside one minute loses
        // that minute's post-reset pieces (max() keeps the pre-reset peak). Once a
        // day, bounded by one minute of output — drop the $group to make it exact.
        { $group: { _id: { m: '$machineId', t: { $dateTrunc: { date: '$timestamp', unit: 'minute' } } }, pv: { $max: '$pv' } } },
        { $setWindowFields: {
          partitionBy: '$_id.m', sortBy: { '_id.t': 1 },
          output: { prevV: { $shift: { output: '$pv', by: -1, default: null } } },
        } },
        { $group: { _id: '$_id.m', made: { $sum: { $cond: [
          { $and: [{ $ne: ['$prevV', null] }, { $gt: ['$pv', '$prevV'] }] },
          { $subtract: ['$pv', '$prevV'] },
          0,
        ] } } } },
      ]).allowDiskUse(true).option({ maxTimeMS }).exec() : [];

      return { tele, minutes, made };
    }),
    DowntimeEvent.find({
      machineId: { $in: refs },
      startedAt: { $lte: endD },
      $or: [{ endedAt: null }, { endedAt: { $gte: fromD } }],
    }).select({ machineId: 1, type: 1, startedAt: 1, endedAt: 1 }).maxTimeMS(20000).lean(),
  ]);

  const teleBy = new Map<string, TeleRow>(((teleAgg as { tele: TeleRow[] }).tele).map((t) => [t._id, t]));
  // coveredMs is the bridged gap total; the last reading's own minute is added
  // here, so a machine with a single reading still counts as 1 minute reported.
  const coverageBy = new Map<string, number>(
    ((teleAgg as { minutes: { _id: string; minutes: number; coveredMs: number }[] }).minutes)
      .map((m) => [m._id, m.minutes ? m.coveredMs + 60_000 : 0]),
  );

  // What the counter ADDED inside the window (summed above). Key selection is
  // shared (utils/production) with the event engine + client.
  const madeBy = new Map<string, number>(
    ((teleAgg as { made: { _id: string; made: number }[] }).made || []).map((m) => [m._id, m.made]),
  );
  const productionOf = (t?: TeleRow): { key: string; production: number } | null => {
    if (!t?.lastData) return null;
    const last = flattenData(t.lastData);
    const key = pickProductionKey(last);
    if (!key) return null;
    const steps = madeBy.get(t._id);
    if (steps != null) return { key, production: steps };
    // Dotted key (no $getField pass) → fall back to first-vs-last. A null/'' first
    // reading must NOT coerce to 0, and a mid-window reset falls back to the end
    // value, exactly as before.
    const first = flattenData(t.firstData || {});
    const end = Number(last[key]);
    const start = isNumericValue(first[key]) ? Number(first[key]) : Number.NaN;
    const delta = Number.isFinite(start) ? end - start : 0;
    return { key, production: delta >= 0 ? delta : end };
  };

  // Window-clipped spans per machine (kept span-level: runningMs below needs
  // per-span overlap with the machine's reporting envelope).
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
    const spans = clipSpans([
      ...(spansBy.get(ref) || []),
      ...(m.machineId && m.machineId !== ref ? spansBy.get(m.machineId) || [] : []),
    ]);
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
    // Aliases (code + machineId) normally carry the SAME stream — take the
    // larger coverage, never the sum, so a duplicated stream can't inflate runtime.
    const reportedMs = Math.min(windowMs, Math.max(
      coverageBy.get(ref) || 0,
      m.machineId && m.machineId !== ref ? (coverageBy.get(m.machineId) || 0) : 0,
    ));
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
    // Dominant OBSERVED state — what the machine was doing while we could see
    // it (reported time + recorded spans). Silence is NOT folded in: a machine
    // observed running 52m inside a fortnight window must read "running · live
    // data", not "offline". Darkness still shows through the live flag, the
    // durations, and availability (runningMs ÷ window) — a dark machine can't
    // rank high because its runningMs stays tiny.
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
