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
import { pickProductionKey, pickRunKeys, type MachineBooks } from '../utils/production.js';
import { pickTemperatureKeys, TEMP_MIN, TEMP_MAX } from '../utils/temperature.js';
import { isNumericValue } from '../utils/normalize.js';
import { cached } from '../utils/cache.js';
import { lineLinkFor, normRef } from '../config/lineLinks.js';

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
  // Set when this machine's count was made by the machine UPSTREAM of it: the
  // code that counted, and how far behind that count runs here (see
  // config/lineLinks). null on every machine that counts its own work.
  productionFrom: string | null;
  productionLagMs: number;
  // Mean MEASURED temperature over the range, averaged across the machine's work
  // zones. null = this machine reports no temperature (most of them don't) — a
  // furnace shows this where a press shows production.
  avgTemp: number | null;
  tempZones: number;         // how many zones that mean was taken over
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
/** Pieces (or seconds) a counter ADDED across a series of samples.
 *
 *  A value only moves the high-water mark once the NEXT sample confirms it,
 *  which is what separates the three things a PLC counter does: a real climb, a
 *  shift RESET (a drop the next sample agrees with), and a single garbage
 *  sample. Both kinds of garbage are in this fleet's data — CNCLATHE04 once
 *  reported 0 against a true 440, SPG02 once reported 507 against a true 51 —
 *  and unconfirmed, each would have fabricated hundreds of pieces.
 *  ponytail: a one-sample lookahead is the whole heuristic; a counter that stays
 *  wrong for two consecutive samples still fools it. */
export function countStepsOf(series: { t: number; v: number }[]): number {
  const v = [...series].sort((a, b) => a.t - b.t).map((p) => p.v);
  if (v.length < 2) return 0;
  let made = 0, high = v[0];
  for (let i = 1; i < v.length; i += 1) {
    const cur = v[i], next = i + 1 < v.length ? v[i + 1] : null;
    if (cur > high) {
      if (next === null || next >= cur) { made += cur - high; high = cur; }   // confirmed climb
    } else if (cur < high && next !== null && next < high) {
      high = cur;                                                             // confirmed reset
    }
  }
  return made;
}

/** Milliseconds the MACHINE says it was running, from its own signal.
 *
 *  A seconds counter is stepped like production (it resets daily too, so the
 *  same confirmation rules apply); a flag credits the time between the samples
 *  that carried it, bridged by the same grace as reporting coverage, so a
 *  machine that reports every 5 minutes is not punished for the gaps. */
export function runMsFromSeries(series: { t: number; v: number }[], kind: 'seconds' | 'flag'): number | null {
  const s = [...series].sort((a, b) => a.t - b.t);
  if (s.length < 2) return null;
  if (kind === 'seconds') return countStepsOf(s) * 1000;
  let ms = 0;
  for (let i = 1; i < s.length; i += 1) {
    if (s[i - 1].v >= 1) ms += Math.min(s[i].t - s[i - 1].t, GRACE_MS);
  }
  return ms;
}

export type Interval = { s: number; e: number };

/** The intervals during which a machine was REPORTING.
 *
 *  Consecutive reporting buckets up to GRACE_MS apart are one continuous
 *  interval (collectors post every few minutes / on change); a run's last bucket
 *  contributes its own width. */
export function coverageIntervals(stamps: number[], binMs: number): Interval[] {
  if (!stamps.length) return [];
  const t = [...stamps].sort((a, b) => a - b);
  const out: Interval[] = [];
  let start = t[0], prev = t[0];
  for (let i = 1; i < t.length; i += 1) {
    if (t[i] - prev <= GRACE_MS) { prev = t[i]; continue; }
    out.push({ s: start, e: prev + binMs });
    start = t[i]; prev = t[i];
  }
  out.push({ s: start, e: prev + binMs });
  return out;
}

/** Measure of A minus B, where both are sorted and non-overlapping.
 *
 *  Runtime used to be `reportedMs - downtimeMs`, two scalars measured on
 *  different clocks: coverage counts only the time a machine was REPORTING,
 *  while a downtime span runs in wall-clock time. On a sparse reporter that
 *  subtraction eats everything — SPG02 reported 542 times across 8.5h, so
 *  widening the window by 31 minutes added 31 minutes of downtime, almost no
 *  coverage, and its runtime FELL from 16m to 1m. A window cannot contain less
 *  running time than a window inside it. Subtracting on the timeline instead is
 *  monotonic by construction, and never negative. */
export function subtractMs(cover: Interval[], cut: Interval[]): number {
  let total = 0;
  for (const c of cover) {
    let pos = c.s;
    for (const d of cut) {
      if (d.e <= pos) continue;
      if (d.s >= c.e) break;
      if (d.s > pos) total += Math.min(d.s, c.e) - pos;
      pos = Math.max(pos, d.e);
      if (pos >= c.e) break;
    }
    if (pos < c.e) total += c.e - pos;
  }
  return total;
}

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

  const cacheKey = 'activity5:' + JSON.stringify(scope || 'all') + ':' + JSON.stringify(only || null)
    + ':' + fromD.toISOString() + ':' + toD.toISOString();
  // Month / year windows scan far more telemetry but change far more slowly:
  // cache them longer and give Atlas more time, so the dashboard's group panels
  // can ask for them without timing out.
  const spanMs = endMs - fromD.getTime();
  const longWindow = spanMs > 7 * 24 * 3600 * 1000;
  // Readings are bucketed before they leave the database. Past a month the bucket
  // widens so the pushed arrays stay small; 5 minutes is still exact for the
  // coverage maths below, because that IS the bridging grace.
  const binSize = spanMs > 30 * 24 * 3600 * 1000 ? 5 : 1;   // minutes
  const binMs = binSize * 60_000;
  const bucket = { $dateTrunc: { date: '$timestamp', unit: 'minute', binSize } };
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
        // The buckets in which each machine REPORTED. Running time is only
        // credited for time the machine actually reported, with gaps up to
        // GRACE_MS bridged (done in Node, below).
        //
        // Deliberately NO $setWindowFields here: it forces a blocking sort, and
        // this Atlas tier does not honour allowDiskUse. Measured on the live
        // cluster, that sort dies at ~48k group docs - about three days of this
        // fleet's telemetry - so every week/month/year window would 500. $group
        // + $push has no sort, and the bucket above bounds what comes back.
        Telemetry.aggregate([
          { $match: { machineId: { $in: refs }, timestamp: { $gte: fromD, $lte: endD } } },
          { $group: { _id: { m: '$machineId', t: bucket } } },
          { $group: { _id: '$_id.m', ts: { $push: '$_id.t' } } },
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
      // The same pass also collects the machine's own RUN signal where it has
      // one, because it is the honest answer for runtime — see utils/production
      // #pickRunKey. One pipeline for both: a second scan of the same window
      // would double the cost of every dashboard poll.
      const flatOf = (t: TeleRow): Record<string, unknown> => (t.lastData ? flattenData(t.lastData) : {});
      const usable = (k: string | null | undefined): boolean => !!k && !k.includes('.');
      type Keyed = { id: string; key: string | null; books: MachineBooks };
      const keyed: Keyed[] = tele
        .map((t: TeleRow) => {
          const flat = flatOf(t);
          const prod = pickProductionKey(flat);
          const b = pickRunKeys(flat);
          const books: MachineBooks = {
            run: b.run && usable(b.run.key) ? b.run : null,
            idle: usable(b.idle) ? b.idle : null,
            stop: usable(b.stop) ? b.stop : null,
          };
          return { id: t._id, key: usable(prod) ? prod : null, books };
        })
        .filter((x) => !!x.key || !!x.books.run);

      const NUMERIC = ['int', 'long', 'double', 'decimal'];
      // $switch with an empty branch list is a SERVER ERROR, not an empty result:
      // "$switch requires at least one branch". It fires the moment a scope holds
      // no machine with the key being picked — one machine that counts pieces but
      // publishes no run/idle/stop signal is enough, which is most of this fleet,
      // so every single-machine query (the per-machine report filter, a machine's
      // own shift panel) died with a 500. No machine has the key => the column is
      // null for everyone.
      const pick = (field: (k: Keyed) => string | null) => {
        const branches = keyed.filter((k) => field(k)).map((k) => ({
          case: { $eq: ['$machineId', k.id] },
          then: { $getField: { field: field(k) as string, input: '$data' } },
        }));
        return branches.length ? { $switch: { branches, default: null } } : null;
      };

      const made = keyed.length ? await Telemetry.aggregate([
        { $match: { machineId: { $in: keyed.map((k) => k.id) }, timestamp: { $gte: fromD, $lte: endD } } },
        { $addFields: {
          pv: pick((k) => k.key),
          rv: pick((k) => k.books.run?.key ?? null),
          iv: pick((k) => k.books.idle),
          sv: pick((k) => k.books.stop),
        } },
        { $match: { $or: [{ pv: { $type: NUMERIC } }, { rv: { $type: NUMERIC } }] } },
        // Highest counter value per bucket, then the series itself - the stepping
        // happens in Node (countSteps), for the same reason as the pipeline above:
        // no window function, so no blocking sort this tier cannot spill.
        // ponytail: a counter that resets AND climbs again inside ONE bucket loses
        // that bucket's post-reset pieces ($max keeps the pre-reset peak). Once a
        // day, bounded by one bucket of output.
        { $group: { _id: { m: '$machineId', t: bucket }, pv: { $max: '$pv' }, rv: { $max: '$rv' }, iv: { $max: '$iv' }, sv: { $max: '$sv' } } },
        { $group: { _id: '$_id.m', pts: { $push: { t: '$_id.t', v: '$pv', r: '$rv', i: '$iv', s: '$sv' } } } },
      ]).allowDiskUse(true).option({ maxTimeMS }).exec() : [];

      // Mean temperature over the window, averaged in the database. A furnace's
      // reading is the mean across its work zones (T1…T4), so each document
      // contributes ONE per-zone mean and those are averaged over the window —
      // otherwise a machine with four zones would out-weight one with a single
      // probe. Dead channels (nulls, S7 fault sentinels) are filtered out first,
      // so an unwired thermocouple can't drag the average toward zero.
      const tempKeyed = tele
        .map((t: TeleRow) => ({ id: t._id, keys: t.lastData ? pickTemperatureKeys(flattenData(t.lastData), t._id) : [] }))
        .filter((x) => x.keys.length > 0 && x.keys.every((k) => !k.includes('.')));

      const heat = tempKeyed.length ? await Telemetry.aggregate([
        { $match: { machineId: { $in: tempKeyed.map((k) => k.id) }, timestamp: { $gte: fromD, $lte: endD } } },
        { $addFields: { tv: { $switch: {
          branches: tempKeyed.map((k) => ({
            case: { $eq: ['$machineId', k.id] },
            then: { $filter: {
              input: k.keys.map((key) => ({ $getField: { field: key, input: '$data' } })),
              as: 'v',
              cond: { $and: [
                { $isNumber: '$$v' },
                { $gte: ['$$v', TEMP_MIN] },
                { $lte: ['$$v', TEMP_MAX] },
              ] },
            } },
          })),
          default: [],
        } } } },
        { $match: { 'tv.0': { $exists: true } } },
        { $group: { _id: '$machineId', avgTemp: { $avg: { $avg: '$tv' } }, zones: { $max: { $size: '$tv' } } } },
      ]).allowDiskUse(true).option({ maxTimeMS }).exec() : [];

      return { tele, minutes, made, keyed, heat };
    }),
    DowntimeEvent.find({
      machineId: { $in: refs },
      startedAt: { $lte: endD },
      $or: [{ endedAt: null }, { endedAt: { $gte: fromD } }],
    }).select({ machineId: 1, type: 1, startedAt: 1, endedAt: 1 }).maxTimeMS(20000).lean(),
  ]);

  const teleBy = new Map<string, TeleRow>(((teleAgg as { tele: TeleRow[] }).tele).map((t) => [t._id, t]));
  // The reporting STAMPS are kept, not a total: runtime is the part of these
  // intervals that no downtime span covers, and that has to be worked out on the
  // timeline (see subtractMs).
  const stampsBy = new Map<string, number[]>(
    ((teleAgg as { minutes: { _id: string; ts: Date[] }[] }).minutes)
      .map((m) => [m._id, m.ts.map((d) => new Date(d).getTime())]),
  );

  // What the counter ADDED across the window. A value only moves the high-water
  // mark once the NEXT bucket confirms it, which is what separates the three
  // things a PLC counter does: a real climb, a shift RESET (a drop the next
  // bucket agrees with), and a single garbage sample. Both kinds of garbage are
  // in this fleet's data - CNCLATHE04 once reported 0 against a true 440, SPG02
  // once reported 507 against a true 51 - and unconfirmed, each would have
  // fabricated hundreds of pieces.
  // ponytail: a one-sample lookahead is the whole heuristic; a counter that
  // stays wrong for two consecutive buckets still fools it.
  type Point = { t: Date; v: number | null; r: number | null; i: number | null; s: number | null };
  type Sample = { t: number; v: number | null; r: number | null; i: number | null; s: number | null };
  const num = (x: unknown): number | null => (x == null ? null : Number(x));
  const seriesBy = new Map<string, Sample[]>(
    ((teleAgg as { made: { _id: string; pts: Point[] }[] }).made || [])
      .map((m) => [m._id, m.pts
        .map((x) => ({ t: new Date(x.t).getTime(), v: num(x.v), r: num(x.r), i: num(x.i), s: num(x.s) }))
        .sort((a, b) => a.t - b.t)]),
  );
  const booksBy = new Map<string, MachineBooks>(
    ((teleAgg as { keyed: { id: string; books: MachineBooks }[] }).keyed || []).map((k) => [k.id, k.books]),
  );
  // Window-mean temperature per machine (averaged above). Keyed on the telemetry
  // machineId, exactly like madeBy.
  const heatBy = new Map<string, { avgTemp: number; zones: number }>(
    ((teleAgg as { heat?: { _id: string; avgTemp: number; zones: number }[] }).heat || [])
      .map((x) => [x._id, { avgTemp: x.avgTemp, zones: x.zones }]),
  );
  const madeBy = new Map<string, number>(
    [...seriesBy].map(([id, pts]) => [id, countStepsOf(pts.filter((x) => x.v != null).map((x) => ({ t: x.t, v: x.v as number })))]),
  );

  // Seconds counters are stepped like production; a flag credits the gaps after
  // the samples that carried it — but only if it really IS a flag. SPG04 calls a
  // register RUNNING_FLAG and puts 10932 in it; believing the name would have
  // credited that as running time.
  const seriesOf = (id: string, field: 'r' | 'i' | 's'): { t: number; v: number }[] =>
    (seriesBy.get(id) || []).filter((x) => x[field] != null).map((x) => ({ t: x.t, v: x[field] as number }));

  const booksFor = (id: string): { runMs: number; idleMs: number | null; stopMs: number | null } | null => {
    const books = booksBy.get(id);
    if (!books?.run) return null;
    const runSeries = seriesOf(id, 'r');
    if (books.run.kind === 'flag' && runSeries.some((x) => x.v !== 0 && x.v !== 1)) return null;
    const runMs = runMsFromSeries(runSeries, books.run.kind);
    if (runMs == null) return null;
    const secs = (field: 'i' | 's', key: string | null): number | null => {
      if (!key) return null;
      const ms = runMsFromSeries(seriesOf(id, field), 'seconds');
      return ms == null ? null : ms;
    };
    return { runMs, idleMs: secs('i', books.idle), stopMs: secs('s', books.stop) };
  };

  // Key selection is shared (utils/production) with the event engine + client.
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
    const readings = t?.readings || 0;
    // Running time = the part of the machine's REPORTING intervals that no
    // downtime span covers. Aliases (code + machineId) normally carry the same
    // stream, so their stamps are unioned — duplicates collapse into the same
    // intervals and cannot inflate anything.
    const cover = coverageIntervals([
      ...(stampsBy.get(ref) || []),
      ...(m.machineId && m.machineId !== ref ? stampsBy.get(m.machineId) || [] : []),
    ], binMs).map((c) => ({ s: Math.max(c.s, fromD.getTime()), e: Math.min(c.e, endMs) }))
      .filter((c) => c.e > c.s);
    const reportedMs = Math.min(windowMs, cover.reduce((n, c) => n + (c.e - c.s), 0));
    // The machine's own run signal wins when it has one: the collector's status
    // field is a guess about the machine, this IS the machine. ISB02 read 0m of
    // runtime for a 100-piece day purely because its status never said "running".
    const own = booksFor(ref) ?? (m.machineId && m.machineId !== ref ? booksFor(m.machineId) : null);
    const signalRun = own?.runMs ?? null;
    // …but only when the machine's own output doesn't contradict it. SPG02/03/04
    // publish RUNNING_FLAG and it is wired to nothing: 744 readings today, every
    // one of them 0, while the three of them made 297 pieces between them. A
    // signal that says "never ran" over a window the counter says was productive
    // is broken, not informative — fall back and let it start working by itself
    // the day it gets wired up.
    const madeInWindow = madeBy.get(ref) ?? 0;
    const trustSignal = signalRun != null && (signalRun > 0 || madeInWindow <= 0);
    const runningMs = trustSignal
      ? Math.min(signalRun as number, windowMs)
      : (readings > 0 ? subtractMs(cover, spans) : 0);

    // When the machine keeps its own books for the whole day, use them for idle
    // and stopped too — one clock for the whole pie. ISB03's span log claimed
    // 7.59h stopped where the machine's own counter says 2.48h.
    if (trustSignal && own?.idleMs != null) down.idle = Math.min(own.idleMs, windowMs);
    if (trustSignal && own?.stopMs != null) down.stopped = Math.min(own.stopMs, windowMs);

    // A machine cannot be idle while it is demonstrably running. When the two
    // sources disagree, believe the machine and take the contradiction out of
    // idle first, then stopped — otherwise the four buckets would add up to more
    // than the window and every share on the dashboard would be wrong.
    let excess = runningMs + down.idle + down.stopped + down.offline - windowMs;
    for (const k of ['idle', 'stopped', 'offline'] as const) {
      if (excess <= 0) break;
      const cut = Math.min(down[k], excess);
      down[k] -= cut;
      excess -= cut;
    }
    // Dominant OBSERVED state — what the machine was doing while we could see
    // it (reported time + recorded spans). Silence is NOT folded in: a machine
    // observed running 52m inside a fortnight window must read "running · live
    // data", not "offline". Darkness still shows through the live flag, the
    // durations, and availability (runningMs ÷ window) — a dark machine can't
    // rank high because its runningMs stays tiny.
    let status = 'offline';
    if (readings > 0 || down.idle + down.stopped + down.offline > 0) {
      const buckets: [string, number][] = [
        ['running', runningMs], ['idle', down.idle], ['stopped', down.stopped], ['offline', down.offline],
      ];
      buckets.sort((a, b) => b[1] - a[1]);
      status = buckets[0][0];
    }
    const prod = productionOf(t);
    const heat = t ? heatBy.get(t._id) : undefined;
    return {
      code: ref,
      name: m.name || m.machineName || ref,
      type: m.type || m.machineType || null,
      status, live: readings > 0, readings,
      firstSeen: t?.firstSeen || null, lastSeen: t?.lastSeen || null,
      runningMs, idleMs: down.idle, stoppedMs: down.stopped, offlineMs: down.offline,
      production: prod?.production ?? null,
      productionKey: prod?.key ?? null,
      productionFrom: null,
      productionLagMs: 0,
      avgTemp: heat ? Math.round(heat.avgTemp * 10) / 10 : null,
      tempZones: heat?.zones ?? 0,
    };
  });

  // ── Line links ────────────────────────────────────────────────────────────
  // A milling machine with no counter still makes pieces: the ones the machine
  // upstream counted, reaching it a couple of minutes later. Take the source's
  // counter series and stop it short by the transit time, so a piece counted
  // upstream at 12:29 lands here at 12:31 — the delay is the point, not a
  // detail. Over a past window the two numbers agree; live, this one trails.
  // ponytail: the window's START edge is not shifted, so pieces made in the two
  // minutes before it land on the wrong side of a day boundary. Bounded by two
  // minutes of one machine's output; shift both edges if that ever matters.
  const rowBy = new Map(rows.map((r) => [normRef(r.code), r]));
  const seriesNorm = new Map([...seriesBy].map(([id, pts]) => [normRef(id), pts]));
  for (const row of rows) {
    const link = lineLinkFor(row.code);
    if (!link) continue;
    const src = rowBy.get(normRef(link.source));
    const pts = seriesNorm.get(normRef(link.source));
    const arrived = pts
      ? countStepsOf(pts.filter((x) => x.v != null && x.t <= endMs - link.delayMs)
          .map((x) => ({ t: x.t, v: x.v as number })))
      : src?.production ?? null;
    if (arrived == null) continue;
    row.production = arrived;
    row.productionKey = src?.productionKey ?? null;
    row.productionFrom = src?.code ?? link.source;
    row.productionLagMs = link.delayMs;
  }

  return { rows, windowMs, from: fromD, to: endD };
}
