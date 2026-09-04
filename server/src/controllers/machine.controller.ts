// server/src/controllers/machine.controller.ts
// READ-ONLY access to the real `machines` + `telemetries` collections.
// A machine is identified by its `code` (e.g. "TARAPUR-M01"); telemetry rows
// reference that code via `machineId`.
import mongoose, { type FilterQuery } from 'mongoose';
import { Machine }   from '../models/Machine.js';
import type { IMachine } from '../models/Machine.js';
import { Telemetry } from '../models/Telemetry.js';
import { DowntimeEvent } from '../models/DowntimeEvent.js';
import { ok, fail, asyncHandler } from '../utils/http.js';
import { flattenData } from '../utils/flatten.js';
import { computeStats } from '../utils/metrics.js';
import { normalizeData, rankNamed, isNumericValue } from '../utils/normalize.js';
import { derivedCounterFor } from '../config/derivedCounters.js';
import { derivedEvents } from '../services/derivedCounter.service.js';
import { pickProductionKey } from '../utils/production.js';
import { getProfile } from '../config/machineProfiles.js';
import { machineScope } from '../utils/scope.js';
import { computeActivity, stepEvents, PROD_STEP_PER_MIN } from '../services/activity.service.js';
import { cached, invalidate } from '../utils/cache.js';
import { readingSignature, pickColumns } from '../utils/history.js';
import { MachineLabel } from '../models/MachineLabel.js';
import { AuditLog } from '../models/AuditLog.js';
import { refMatch } from '../utils/machineRef.js';
import { normalizeStatus } from '../utils/status.js';

const PLANT_POP = { path: 'plant', select: 'name code location' };

type ScopeUser = { isSuperAdmin?: boolean; assignedMachines?: string[] } | undefined;

// Row-level visibility: a scoped (e.g. operator) user only sees the machines assigned
// to them. true when unrestricted, or when any ref matches their scope.
function inUserScope(user: ScopeUser, ...refs: (string | undefined)[]): boolean {
  const scope = machineScope(user);
  if (!scope) return true;
  return refs.some((r) => !!r && scope.includes(r));
}

// A Mongo condition limiting a Machine query to the user's assigned machines (matched
// on `code` OR `machineId`). null when unrestricted. Enforced server-side so it can't
// be bypassed by calling the API directly.
function scopeMatch(user: ScopeUser): FilterQuery<IMachine> | null {
  const scope = machineScope(user);
  if (!scope) return null;
  return { $or: [{ code: { $in: scope } }, { machineId: { $in: scope } }] } as unknown as FilterQuery<IMachine>;
}

// `machines`/`telemetries` are strict:false mirrors, so lean docs may carry extra
// fields (machineId, machineName, ...) beyond the declared schema. Allow them.
type LeanMachine = IMachine & {
  _id: mongoose.Types.ObjectId;
  machineId?: string;
  [key: string]: unknown;
};

// GET /machines — paginated, filterable list.
// Each machine is enriched with its latest telemetry payload (`latestData`) and
// plant name in ONE aggregation: a $lookup sub-pipeline reads exactly 1 telemetry
// row per machine via the { machineId, timestamp } index, so it scales to 600+.
export const listMachines = asyncHandler(async (req, res) => {
  const { search, status, plant, type, sort = 'name', page = 1, limit = 60 } =
    req.query as Record<string, string | undefined>;
  const match: FilterQuery<IMachine> = {};
  if (status && status !== 'all') match.status = status;
  if (type   && type   !== 'all') match.type   = type;
  if (plant  && plant  !== 'all' && mongoose.isValidObjectId(plant)) match.plant = new mongoose.Types.ObjectId(plant);
  if (search) {
    const rx = new RegExp(search, 'i');
    match.$or = [{ name: rx }, { code: rx }, { type: rx }, { machineName: rx }, { machineId: rx }, { machineType: rx }];
  }
  // Row-level scope — operators see only their assigned machines (ANDed with search/filters).
  const scoped = scopeMatch(req.user as ScopeUser);
  if (scoped) match.$and = [...((match.$and as FilterQuery<IMachine>[]) || []), scoped];

  const sortMap: Record<string, Record<string, 1 | -1>> = {
    name:   { name: 1 },
    status: { status: 1, name: 1 },
    recent: { lastReadingAt: -1 },
    oee:    { oee: -1 },
    output: { totalOutput: -1 },
  };
  const lim  = Math.min(Number(limit) || 60, 200);
  const skip = (Number(page) - 1) * lim;

  const [items, total] = await Promise.all([
    Machine.aggregate([
      { $match: match },
      { $sort: sortMap[sort] || { name: 1 } },
      { $skip: skip },
      { $limit: lim },
      {
        $lookup: {
          from: 'telemetries',
          let: { ref: { $ifNull: ['$code', '$machineId'] } },
          pipeline: [
            // Latest reading that actually carries data — PLCs occasionally send a
            // dataless heartbeat, which must not blank out the machine card.
            { $match: { $expr: { $and: [
              { $eq: ['$machineId', '$$ref'] },
              { $gt: [{ $size: { $objectToArray: { $ifNull: ['$data', {}] } } }, 0] },
            ] } } },
            { $sort: { timestamp: -1 } },
            { $limit: 1 },
            { $project: { _id: 0, data: 1, timestamp: 1 } },
          ],
          as: '_latest',
        },
      },
      {
        $addFields: {
          latestData:    { $ifNull: [{ $first: '$_latest.data' }, {}] },
          lastReadingAt: { $ifNull: ['$lastReadingAt', { $first: '$_latest.timestamp' }] },
        },
      },
      { $lookup: { from: 'plants', localField: 'plant', foreignField: '_id', as: '_plant' } },
      { $addFields: { plant: { $first: '$_plant' } } },
      { $project: { _latest: 0, _plant: 0 } },
    ]),
    Machine.countDocuments(match),
  ]);

  // Flatten any nested telemetry payloads (e.g. { active: { "I0.0": 1 } }) so the
  // UI renders every signal as a flat key->value.
  const enriched = items.map((it) => ({ ...it, latestData: flattenData(it.latestData) }));

  return ok(res, enriched, { total, page: Number(page), limit: lim });
});

// GET /machines/summary — status counts for the cards (single aggregation)
export const machineSummary = asyncHandler(async (req, res) => {
  const scoped = scopeMatch(req.user as ScopeUser);
  const agg = await Machine.aggregate([
    ...(scoped ? [{ $match: scoped as Record<string, unknown> }] : []),
    { $group: { _id: '$status', count: { $sum: 1 } } },
  ]);
  const summary: Record<string, number> = { total: 0, running: 0, idle: 0, stopped: 0, offline: 0 };
  agg.forEach((r) => {
    const key = normalizeStatus(r._id) || 'offline';
    summary[key] = (summary[key] || 0) + r.count;
    summary.total += r.count;
  });
  return ok(res, summary);
});

// GET /machines/activity?from&to — READ-ONLY historical view: which machines were
// running / idle / stopped / offline (and which actually reported data) in a time
// range. Reconstructed entirely from the existing `telemetries` (readings in range)
// and `downtime_reports` (overlapping spans) collections — nothing is written.
export const machineActivity = asyncHandler(async (req, res) => {
  const { from, to } = req.query as Record<string, string | undefined>;
  const fromD = from ? new Date(from) : null;
  const toD   = to   ? new Date(to)   : null;
  if (!fromD || !toD || Number.isNaN(fromD.getTime()) || Number.isNaN(toD.getTime()) || fromD >= toD) {
    return fail(res, 400, 'A valid from/to range is required (from must be before to)');
  }
  // Shared engine (services/activity.service) — same source as the dashboard
  // range metrics and rankings, so all three always agree.
  //
  // CACHED, because this is the dashboard's heaviest read and every open board
  // polls it every 15 seconds: without this, ten tabs meant ten full
  // recomputations a minute, and the server spent its life rebuilding the same
  // answer. The client rounds `to` down to the minute, so every client in the
  // same minute shares one computation.
  const scope = machineScope(req.user as ScopeUser);
  const key = `activity:${(scope || []).join(',') || '*'}:${fromD.toISOString()}:${toD.toISOString()}`;
  const act = await cached(key, 20_000, () => computeActivity(scope, fromD, toD));
  return ok(res, act.rows, { from: act.from.toISOString(), to: act.to.toISOString(), windowMs: act.windowMs });
});

// GET /machines/:code/timeline?from&to — the machine's minute-level CHANGE log:
// one row per minute (latest reading in that minute), and only minutes where the
// production counter or the reported status actually changed survive — so every
// row is a real change, not telemetry spam. Default window: last 7 days.
// Read-only over `telemetries`; the row's full payload is fetched on demand by
// the client ("View parameters"), so this response stays light at scale.
export const machineTimeline = asyncHandler(async (req, res) => {
  const m = await findMachine(req.params.code);
  if (!m) return fail(res, 404, 'Machine not found');
  if (!inUserScope(req.user as ScopeUser, m.code, m.machineId)) return fail(res, 403, 'You are not assigned to this machine');
  const refs = [m.code, m.machineId].filter(Boolean) as string[];

  const q = req.query as Record<string, string | undefined>;
  const parseD = (s?: string): Date | null => {
    if (!s) return null;
    const d = new Date(s);
    return Number.isNaN(d.getTime()) ? null : d;
  };
  const nowMin = Math.floor(Date.now() / 60_000) * 60_000;
  const toD = parseD(q.to) || new Date(nowMin);
  const fromD = parseD(q.from) || new Date(toD.getTime() - 7 * 24 * 3600 * 1000);
  if (fromD >= toD) return fail(res, 400, 'from must be before to');
  const endD = new Date(Math.min(toD.getTime(), Date.now()));

  // The counter key comes from the machine's CURRENT snapshot, so the pipeline
  // can ask the database for the minute's HIGHEST counter value. "Latest reading
  // in the minute" was not survivable: when a collector reconnects it replays its
  // buffer stamped with the current time — CUTTINGMACHINE07 wrote 15,294 readings
  // into 30 minutes, the same values interleaved over and over (359 rises, 293
  // drops, one of them 67 wide), so "the last one" was effectively a coin toss and
  // the History column sawed up and down. The highest value in a minute is stable
  // however many times that minute is replayed.
  const snapKey = pickProductionKey(flattenData((m as LeanMachine).currentParameters as Record<string, unknown> || {}));
  const maxKey = snapKey && !snapKey.includes('.') ? snapKey : null;
  const counterAt = maxKey ? { $getField: { field: maxKey, input: '$data' } } : null;

  // The whole range is aggregated ONCE and cached briefly. Paging must not re-run
  // this pipeline per page, and two people looking at the same machine share one
  // computation.
  const page = Math.max(Number(q.page) || 1, 1);
  const lim  = Math.min(Math.max(Number(q.limit) || 25, 1), 2000);   // 2,000 = what a CSV export asks for
  const MAX_ROWS = 20_000;
  const cacheKey = `timeline:${refs.join('|')}:${fromD.toISOString()}:${endD.toISOString()}`;

  const built = await cached(cacheKey, 30_000, async () => {
    // Latest reading per minute — the sort rides {machineId, timestamp:-1}.
    // Downtime spans give each row a status even when the payload carries none
    // (many machines don't send a status key) — same source as the status pills.
    const [agg, spans] = await Promise.all([
      Telemetry.aggregate([
        { $match: { machineId: { $in: refs }, timestamp: { $gte: fromD, $lte: endD } } },
        { $sort: { machineId: 1, timestamp: -1 } },
        { $group: {
          _id: { $dateTrunc: { date: '$timestamp', unit: 'minute' } },
          ts: { $first: '$timestamp' },
          data: { $first: '$data' },
          docStatus: { $first: '$status' },
          readings: { $sum: 1 },
          // Non-numeric samples are ignored rather than compared: BSON orders
          // strings above numbers, so one stray '' would win every $max.
          prodMax: counterAt ? { $max: { $cond: [{ $isNumber: counterAt }, counterAt, null] } } : { $max: null },
        } },
        // Deliberately NO { $sort: { _id: 1 } } here: a sort after $group is a
        // blocking sort, and this Atlas tier ignores allowDiskUse — a History range
        // of a few months would 500 instead of loading. Ordering happens in Node.
      ]).option({ allowDiskUse: true, maxTimeMS: 20000 }) as Promise<{ _id: Date; ts: Date; data?: Record<string, unknown>; docStatus?: string; readings: number; prodMax: number | null }[]>,
      DowntimeEvent.find({
        machineId: { $in: refs },
        startedAt: { $lte: endD },
        $or: [{ endedAt: null }, { endedAt: { $gte: fromD } }],
      }).select({ type: 1, startedAt: 1, endedAt: 1 }).sort({ startedAt: 1 }).maxTimeMS(20000).lean(),
    ]);
    const statusAt = (t: number): string => {
      for (const sp of spans) {
        const st = new Date(sp.startedAt).getTime();
        const en = sp.endedAt ? new Date(sp.endedAt).getTime() : Number.POSITIVE_INFINITY;
        if (t >= st && t <= en) return sp.type;
      }
      return 'running'; // it reported this minute and no downtime span covers it
    };

    agg.sort((a, b) => new Date(a._id).getTime() - new Date(b._id).getTime());

    // One production-counter key for the whole range. The snapshot's key is the
    // one the $max above used; fall back to the newest payload that carries one
    // (report-by-exception means the snapshot can be missing it), in which case
    // rows fall back to that minute's last reading.
    let prodKey: string | null = maxKey;
    for (let i = agg.length - 1; i >= 0 && !prodKey; i -= 1) prodKey = pickProductionKey(flattenData(agg[i].data || {}));

    // First pass: each minute's counter value and status, chronologically.
    const minutes: { ts: Date; t: number; production: number | null; status: string | null }[] = [];
    for (const r of agg) {
      const flat = flattenData(r.data || {});
      const production = r.prodMax != null && isNumericValue(r.prodMax)
        ? Number(r.prodMax)
        : (prodKey && isNumericValue(flat[prodKey]) ? Number(flat[prodKey]) : null);
      // Status priority: payload status → telemetry doc status → downtime spans.
      // EXACT keys only, never a suffix match: this plant's payload also carries
      // status_reason ("manual") and status_mode ("MANUAL"), and a loose match
      // would have read the reason as the state. Cutting-04 names it
      // machine_status, so `flat.status` alone found nothing and every row fell
      // through to the span lookup — which reports "running" for any hour no
      // span covers, the exact hours this is meant to describe.
      const rawStatus = [flat.status, flat.machine_status, r.docStatus]
        .find((v) => typeof v === 'string' && (v as string).trim());
      const status = rawStatus ? normalizeStatus(rawStatus).toLowerCase() : statusAt(new Date(r.ts).getTime());
      minutes.push({ ts: r.ts, t: new Date(r.ts).getTime(), production, status });
    }

    // What the WINDOW made, minute by minute — the same confirmation rule as
    // the card, the targets and every other surface (a rise the next reading
    // agrees with, and no faster than the machine can physically go), over the
    // same per-minute maxima the activity engine steps. The raw counter is a
    // machine-lifetime number that resets on its own schedule; the reader
    // looking at "Today" is owed today's arithmetic, ending on exactly the
    // total the Overview card shows.
    const madeAt = new Map<number, number>();
    for (const e of stepEvents(minutes.filter((x) => x.production != null).map((x) => ({ t: x.t, v: x.production as number })), PROD_STEP_PER_MIN)) {
      madeAt.set(e.t, (madeAt.get(e.t) || 0) + e.made);
    }

    // Second pass: running total, keeping only real changes (production or
    // status differs from the previous minute). The total accumulates across
    // skipped minutes too — a hidden row is an unchanged row, and an unchanged
    // counter makes nothing.
    const rows: { ts: Date; production: number | null; made: number; total: number; status: string | null }[] = [];
    let prevProd: number | null = null;
    let prevStatus: string | null = null;
    let running = 0;
    for (const x of minutes) {
      const made = madeAt.get(x.t) || 0;
      running += made;
      if (rows.length && x.production === prevProd && x.status === prevStatus) continue;
      rows.push({ ts: x.ts, production: x.production, made, total: running, status: x.status });
      prevProd = x.production;
      prevStatus = x.status;
    }
    rows.reverse(); // newest first

    // A minute holding more readings than a machine can physically produce is a
    // replay burst, not a busy minute — surfaced so the UI can say so instead of
    // leaving the reader to wonder why the counter moved oddly.
    const REPLAY_PER_MIN = 60;
    return {
      rows,
      minutes: agg.length,
      replayMinutes: agg.filter((r) => r.readings > REPLAY_PER_MIN).length,
      prodKey,
    };
  });

  // Paged on the server. It used to hand the browser rows.slice(0, 2000) with no
  // page at all: the table showed the first 2,000 changes and there was no way to
  // reach the 2,001st.
  const all = built.rows.slice(0, MAX_ROWS);
  const skip = (page - 1) * lim;
  return ok(res, all.slice(skip, skip + lim), {
    from: fromD.toISOString(), to: endD.toISOString(),
    productionKey: built.prodKey, total: all.length, minutes: built.minutes,
    replayMinutes: built.replayMinutes,
    page, limit: lim, capped: built.rows.length > MAX_ROWS,
  });
});

// Resolve a machine by business `code`, then by the raw `machineId` (the mirror
// docs have no `code`), then by Mongo `_id` — so any link form works.
async function findMachine(idOrCode: string): Promise<LeanMachine | null> {
  let m = await Machine.findOne({ code: idOrCode }).populate(PLANT_POP).lean();
  if (!m) m = await Machine.findOne({ machineId: idOrCode }).populate(PLANT_POP).lean();
  if (!m && mongoose.isValidObjectId(idOrCode)) {
    m = await Machine.findById(idOrCode).populate(PLANT_POP).lean();
  }
  return m as LeanMachine | null;
}

// GET /machines/:code
export const getMachine = asyncHandler(async (req, res) => {
  const m = await findMachine(req.params.code);
  if (!m) return fail(res, 404, 'Machine not found');
  if (!inUserScope(req.user as ScopeUser, m.code, m.machineId)) return fail(res, 403, 'You are not assigned to this machine');

  const ref = m.code || m.machineId || String(m._id);

  // Reading count + the most recent reading that actually carries data (a dataless
  // PLC heartbeat must not blank the parameters). Fall back to the plain latest.
  const [telemetryCount, latestWithData] = await Promise.all([
    Telemetry.countDocuments({ machineId: ref }),
    Telemetry.findOne({ machineId: ref, data: { $exists: true, $ne: {} } }).sort({ timestamp: -1 }).lean(),
  ]);
  const latestTelemetry =
    latestWithData ?? (await Telemetry.findOne({ machineId: ref }).sort({ timestamp: -1 }).lean());

  // Params shown on the detail page: prefer the machine's own live snapshot, else
  // the latest telemetry payload — flattened so nested PLC signals render.
  const rawParams = Object.keys(m.currentParameters || {}).length
    ? (m.currentParameters as Record<string, unknown>)
    : (latestTelemetry?.data || {});
  const params = flattenData(rawParams);

  // Normalized contract for the rich MachineOverview UI — real values only.
  const data = (latestTelemetry?.data as Record<string, unknown>) || {};
  const { named, inputs, outputs, registers } = normalizeData(data);
  const rankedNamed = rankNamed(named);
  const profile = getProfile(ref);
  const faultCount = named.filter((x) => x.fault).length;
  const mid = (m.machineId as string) || String(m._id);
  const firstDefined = (...vals: unknown[]): unknown => vals.find((v) => v !== undefined && v !== null && v !== '') ?? null;

  return ok(res, {
    ...m,
    // identity (normalized)
    id: mid,
    machineId: mid,
    name: (m.machineName as string) || (m.name as string) || mid,
    type: (m.machineType as string) || (m.type as string) || null,
    subtitle: profile?.subtitle || null,
    class: profile?.class || null,
    isActive: (m.isActive as boolean) !== false,
    lastSeenAt: firstDefined(m.lastSeenAt, m.lastReadingAt, m.updatedAt),
    registeredAt: firstDefined(m.registeredAt, m.createdAt),
    oee: typeof m.oee === 'number' ? m.oee : null,
    telemetryCount,
    latest: {
      ts: latestTelemetry?.timestamp || null,
      hasData: named.length > 0 || registers.length > 0 || inputs.length + outputs.length > 0,
      namedCount: named.length,
      registerCount: registers.length,
      ioCount: inputs.length + outputs.length,
      faultCount,
    },
    metrics: rankedNamed.map((x) => ({ key: x.key, value: x.value, numeric: x.numeric, fault: x.fault })),
    inputs: inputs.map((x) => ({ key: x.key, on: x.on, value: x.value })),
    outputs: outputs.map((x) => ({ key: x.key, on: x.on, value: x.value })),
    registers: registers.slice(0, 2000).map((r) => ({ key: r.key, value: r.value })),
    registerCount: registers.length,
    ioCount: inputs.length + outputs.length,
    // legacy fields kept for back-compat
    latestTelemetry,
    liveParameters: params,
    metricKeys: Object.keys(params),
  });
});

// GET /machines/:code/stats — per-metric last/min/max/avg + sparkline over a window.
// Index-backed telemetry slice; faults excluded from aggregates but counted. Bounded
// window + metric cap so it scales regardless of how wide the machine's payload is.
export const machineStats = asyncHandler(async (req, res) => {
  const m = await findMachine(req.params.code);
  if (!m) return fail(res, 404, 'Machine not found');
  if (!inUserScope(req.user as ScopeUser, m.code, m.machineId)) return fail(res, 403, 'You are not assigned to this machine');
  const ref = m.code || m.machineId || String(m._id);

  const windowN = Math.min(Number((req.query as Record<string, string | undefined>).window) || 120, 500);
  const readings = await Telemetry.find({ machineId: ref })
    .sort({ timestamp: -1 })
    .limit(windowN)
    .select({ timestamp: 1, data: 1, _id: 0 })
    .lean();

  const { metrics, metricCount } = computeStats(readings, { sparkPoints: 32, maxMetrics: 48 });
  return ok(res, { window: readings.length, metricCount, metrics });
});

// GET /machines/metric-averages?from&to&keys=CODE:key,CODE:key — the same mean,
// for a whole group in ONE round trip. A dashboard panel showing 19 machines
// must not fire 19 requests every poll.
export const machineMetricAverages = asyncHandler(async (req, res) => {
  const q = req.query as Record<string, string | undefined>;
  const pairs = (q.keys || '').split(',')
    .map((p) => p.split(':'))
    .filter((p) => p.length === 2 && p[0].trim() && p[1].trim() && !p[1].includes('.') && !p[1].includes('$'))
    .map((p) => ({ code: p[0].trim(), key: p[1].trim() }))
    .slice(0, 60);
  if (!pairs.length) return ok(res, []);

  const scope = machineScope(req.user as ScopeUser);
  const wanted = scope ? pairs.filter((p) => scope.includes(p.code)) : pairs;
  if (!wanted.length) return ok(res, []);

  const parseD = (s?: string): Date | null => {
    if (!s) return null;
    const d = new Date(s);
    return Number.isNaN(d.getTime()) ? null : d;
  };
  const toD = parseD(q.to) || new Date();
  const fromD = parseD(q.from) || new Date(toD.getTime() - 24 * 3600 * 1000);
  if (fromD >= toD) return fail(res, 400, 'from must be before to');
  const endD = new Date(Math.min(toD.getTime(), Date.now()));

  // One $switch picks each machine's own key, exactly as the activity engine
  // does for production and temperature.
  const rows = await Telemetry.aggregate([
    { $match: { machineId: { $in: wanted.map((p) => p.code) }, timestamp: { $gte: fromD, $lte: endD } } },
    { $addFields: { v: { $switch: {
      branches: wanted.map((p) => ({ case: { $eq: ['$machineId', p.code] }, then: { $getField: { field: p.key, input: '$data' } } })),
      default: null,
    } } } },
    { $match: { v: { $type: ['int', 'long', 'double', 'decimal'] }, $expr: { $lt: [{ $abs: '$v' }, 32767] } } },
    { $group: { _id: '$machineId', avg: { $avg: '$v' }, min: { $min: '$v' }, max: { $max: '$v' }, samples: { $sum: 1 } } },
  ]).option({ allowDiskUse: true, maxTimeMS: 20000 }).exec();

  const keyOf = new Map(wanted.map((p) => [p.code, p.key]));
  return ok(res, rows.map((r) => ({
    code: r._id as string,
    key: keyOf.get(r._id as string) || null,
    avg: Math.round(r.avg * 100) / 100,
    min: r.min, max: r.max, samples: r.samples,
  })), { from: fromD.toISOString(), to: endD.toISOString() });
});

// GET /machines/:code/metric-average?from&to&key= — the mean of ONE signal over
// a window. Deliberately dumb: the CLIENT decides which signal matters (that
// judgement lives in lib/headline, and the card the user is looking at already
// made it), so this endpoint never guesses. Answers the panel's question for a
// machine that counts no pieces: "what did it average during that shift?"
export const machineMetricAverage = asyncHandler(async (req, res) => {
  const m = await findMachine(req.params.code);
  if (!m) return fail(res, 404, 'Machine not found');
  if (!inUserScope(req.user as ScopeUser, m.code, m.machineId)) return fail(res, 403, 'You are not assigned to this machine');
  const refs = [m.code, m.machineId].filter(Boolean) as string[];

  const q = req.query as Record<string, string | undefined>;
  const key = (q.key || '').trim();
  // $getField takes a literal field name; a dotted key would be read as a path.
  if (!key || key.includes('.') || key.includes('$')) return fail(res, 400, 'A plain top-level key is required');
  const parseD = (s?: string): Date | null => {
    if (!s) return null;
    const d = new Date(s);
    return Number.isNaN(d.getTime()) ? null : d;
  };
  const toD = parseD(q.to) || new Date();
  const fromD = parseD(q.from) || new Date(toD.getTime() - 24 * 3600 * 1000);
  if (fromD >= toD) return fail(res, 400, 'from must be before to');
  const endD = new Date(Math.min(toD.getTime(), Date.now()));

  const at = { $getField: { field: key, input: '$data' } };
  const [row] = await Telemetry.aggregate([
    { $match: { machineId: { $in: refs }, timestamp: { $gte: fromD, $lte: endD } } },
    { $addFields: { v: at } },
    // Sentinels from an unwired channel are not readings.
    { $match: { v: { $type: ['int', 'long', 'double', 'decimal'] }, $expr: { $lt: [{ $abs: '$v' }, 32767] } } },
    { $group: { _id: null, avg: { $avg: '$v' }, min: { $min: '$v' }, max: { $max: '$v' }, samples: { $sum: 1 } } },
  ]).option({ maxTimeMS: 20000 }).exec();

  return ok(res, {
    key,
    avg: row ? Math.round(row.avg * 100) / 100 : null,
    min: row?.min ?? null,
    max: row?.max ?? null,
    samples: row?.samples ?? 0,
  }, { from: fromD.toISOString(), to: endD.toISOString() });
});

// GET /machines/:code/series — time-bucketed OHLC candles for ONE metric (stock-style
// chart). interval ∈ 30s|1m|5m|15m|30m|1h. Buckets the recent window and computes
// open/high/low/close/avg per bucket (faults excluded).
const SERIES_INTERVALS: Record<string, number> = { '30s': 30000, '1m': 60000, '5m': 300000, '15m': 900000, '30m': 1800000, '1h': 3600000 };

export const machineSeries = asyncHandler(async (req, res) => {
  const m = await findMachine(req.params.code);
  if (!m) return fail(res, 404, 'Machine not found');
  if (!inUserScope(req.user as ScopeUser, m.code, m.machineId)) return fail(res, 403, 'You are not assigned to this machine');
  const ref = m.code || m.machineId || String(m._id);
  const q = req.query as Record<string, string | undefined>;
  const interval = q.interval && SERIES_INTERVALS[q.interval] ? q.interval : '5m';
  const intervalMs = SERIES_INTERVALS[interval];

  const rows = await Telemetry.find({ machineId: ref })
    .sort({ timestamp: -1 }).limit(3000).select({ timestamp: 1, data: 1, _id: 0 }).lean();
  rows.reverse();

  const normalized = rows.map((r) => ({
    t: new Date((r as { timestamp?: Date | string }).timestamp ?? 0).getTime(),
    named: normalizeData(((r as { data?: Record<string, unknown> }).data) || {}).named,
  }));

  // Discover numeric keys + their spread (to pick the most interesting default metric).
  const spread: Record<string, { min: number; max: number; count: number }> = {};
  for (const r of normalized) {
    for (const mm of r.named) {
      if (!mm.numeric || mm.fault) continue;
      const v = Number(mm.value);
      const s = spread[mm.key] || (spread[mm.key] = { min: v, max: v, count: 0 });
      s.min = Math.min(s.min, v); s.max = Math.max(s.max, v); s.count += 1;
    }
  }
  const availableMetrics = Object.keys(spread).sort((a, b) => a.localeCompare(b));

  let metric = q.metric && spread[q.metric] ? q.metric : null;
  if (!metric) {
    metric = availableMetrics.slice().sort((a, b) => (spread[b].max - spread[b].min) - (spread[a].max - spread[a].min))[0] || null;
  }

  const buckets = new Map<number, { t: number; open: number; high: number; low: number; close: number; sum: number; count: number }>();
  if (metric) {
    for (const r of normalized) {
      const entry = r.named.find((x) => x.key === metric);
      if (!entry || !entry.numeric || entry.fault) continue;
      const v = Number(entry.value);
      const bt = Math.floor(r.t / intervalMs) * intervalMs;
      const b = buckets.get(bt);
      if (!b) buckets.set(bt, { t: bt, open: v, high: v, low: v, close: v, sum: v, count: 1 });
      else { b.high = Math.max(b.high, v); b.low = Math.min(b.low, v); b.close = v; b.sum += v; b.count += 1; }
    }
  }
  let series = [...buckets.values()].sort((a, b) => a.t - b.t).map((b) => ({
    t: b.t, open: b.open, high: b.high, low: b.low, close: b.close,
    avg: Math.round((b.sum / b.count) * 100) / 100, count: b.count,
  }));
  if (series.length > 120) series = series.slice(-120);

  return ok(res, { metric, interval, availableMetrics, series });
});

// GET /machines/:code/history — telemetry readings, range + paginated.
// Backed by the { machineId, timestamp } compound index → fast at 600+ machines.
export const machineHistory = asyncHandler(async (req, res) => {
  // Resolve code/machineId/_id aliases so every link form finds the telemetry rows,
  // which are keyed by the machine's business ref — not by whatever the URL carried.
  const m = await findMachine(req.params.code);
  if (!inUserScope(req.user as ScopeUser, req.params.code, m?.code, m?.machineId)) return fail(res, 403, 'You are not assigned to this machine');
  const ref = m ? ((m.code as string) || (m.machineId as string) || String(m._id)) : req.params.code;
  const { from, to, page = 1, limit = 25 } = req.query as Record<string, string | undefined>;
  const lim  = Math.min(Math.max(Number(limit) || 25, 1), 200);
  const skip = (Math.max(Number(page) || 1, 1) - 1) * lim;

  const q: FilterQuery<Record<string, unknown>> = { machineId: ref };
  if (from || to) {
    const range: { $gte?: Date; $lte?: Date } = {};
    if (from) range.$gte = new Date(from);
    if (to)   range.$lte = new Date(to);
    q.timestamp = range;
  }

  // Only readings where something CHANGED — a machine posting every second fills
  // page after page with the same row (BOTTOMMILLING04 sent 13,599 readings in
  // one morning, all of them 7,000 / 800 / 800). A run of identical payloads
  // collapses to the reading where that value FIRST appeared, so the table reads
  // as "this is when it became this". Clocks don't count as change: see
  // utils/history#readingSignature.
  //
  // The scan stops as soon as THIS page is full. The old shape walked the whole
  // range — up to 5,000 changes — before it could return page 1, and that scan
  // is what the log spent its "Loading…" seconds on. Rows are gathered a block
  // at a time so paging forward reuses one scan instead of starting over.
  const BLOCK = 500;
  const need  = skip + lim + 1;                       // +1 answers "is there a next page?"
  const block = Math.ceil(need / BLOCK) * BLOCK;
  // Two ceilings, because a machine that NEVER changes would otherwise be scanned
  // to the end of the range: BOTTOMMILLING2 has posted the same {"status":"idle"}
  // since 21 Aug. Whichever ceiling comes first wins, and the page says so.
  const MAX_SCAN = 60_000;
  const DEADLINE = Date.now() + 8_000;
  const cacheKey = `rawchanges:${ref}:${from || ''}:${to || ''}:${block}`;
  const changes = await cached(cacheKey, 30_000, async () => {
    const cursor = Telemetry.find(q).sort({ timestamp: -1 })
      .select({ timestamp: 1, data: 1 }).maxTimeMS(20_000).batchSize(500).lean().cursor();
    const rows: Record<string, unknown>[] = [];
    let prevSig: string | null = null;
    let runOldest: Record<string, unknown> | null = null;
    let scanned = 0;
    let exhausted = true;      // the cursor ran out => the row count is exact
    let scanCapped = false;
    try {
      for await (const doc of cursor) {
        scanned += 1;
        const data = flattenData((doc as { data?: Record<string, unknown> }).data);
        const sig = readingSignature(data);
        if (sig !== prevSig) {
          // Scanning newest -> oldest, the run we just left ends at its OLDEST
          // reading: the moment that value came up.
          if (runOldest) rows.push(runOldest);
          prevSig = sig;
        }
        runOldest = { ...(doc as Record<string, unknown>), data };
        if (rows.length >= block) { exhausted = false; break; }
        if (scanned >= MAX_SCAN || Date.now() > DEADLINE) { exhausted = false; scanCapped = true; break; }
      }
    } catch (err) {
      // A stalled cursor mid-scan (this DB lives on a VPS link that drops) should
      // hand back the changes already found, not a 500 over a page that was
      // nearly ready. Nothing found at all is still a real failure.
      if (!rows.length) throw err;
      exhausted = false; scanCapped = true;
    }
    if (exhausted && runOldest) rows.push(runOldest);
    await cursor.close().catch(() => {});
    return { rows, scanned, exhausted, scanCapped };
  });

  const rows = changes.rows.slice(skip, skip + lim);
  return ok(res, rows, {
    // `total` is exact only when the scan reached the end of the range; short of
    // that it is what has been found SO FAR, and the client pages by hasMore
    // rather than printing a page count it would have to invent.
    total: changes.rows.length,
    exact: changes.exhausted,
    hasMore: !changes.exhausted || changes.rows.length > skip + lim,
    page: Math.max(Number(page) || 1, 1),
    limit: lim,
    scanned: changes.scanned,
    scanCapped: changes.scanCapped,
    columns: pickColumns(changes.rows.map((r) => (r as { data: Record<string, unknown> }).data)),
  });
});

// ── Hourly production ────────────────────────────────────────────────────────
// GET /machines/:code/hourly?from&to — pieces made per hour, from the same
// confirmed-step rules as the activity engine (a shift reset is not
// production; a single garbage sample is not a piece). Buckets are anchored to
// the request's `from`, so a client on the plant's half-hour-offset clock gets
// 07:00–08:00 LOCAL bars, not UTC ones. Feeds the target board's hourly bars.
export const machineHourly = asyncHandler(async (req, res) => {
  const m = await findMachine(req.params.code);
  if (!m) return fail(res, 404, 'Machine not found');
  if (!inUserScope(req.user as ScopeUser, m.code, m.machineId)) return fail(res, 403, 'You are not assigned to this machine');
  const refs = [m.code, m.machineId].filter(Boolean) as string[];

  const q = req.query as Record<string, string | undefined>;
  const parseD = (v?: string): Date | null => {
    if (!v) return null;
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d;
  };
  const toD = parseD(q.to) || new Date();
  const fromD = parseD(q.from) || new Date(toD.getTime() - 24 * 3600_000);
  if (fromD >= toD) return fail(res, 400, 'from must be before to');
  if (toD.getTime() - fromD.getTime() > 7 * 24 * 3600_000) return fail(res, 400, 'window too large (max 7 days)');
  const endD = new Date(Math.min(toD.getTime(), Date.now()));

  // A derived-counter machine's hours come from edge events in its raw signal
  // (config/derivedCounters) — same engine as its card and the targets board.
  const dc = derivedCounterFor(m.code || m.machineId || '');
  if (dc) {
    const HOUR_MS = 3600_000;
    const hours = await cached(`hourly:${refs.join('|')}:edge:${fromD.toISOString()}:${endD.toISOString()}`, 30_000, async () => {
      const offset = fromD.getTime();
      const byHour = new Map<number, number>();
      for (const ev of await derivedEvents(refs, dc, fromD, endD)) {
        const b = Math.floor((ev.t - offset) / HOUR_MS) * HOUR_MS + offset;
        byHour.set(b, (byHour.get(b) || 0) + ev.made);
      }
      // `t` and the {from,to} meta, exactly as the register branch below —
      // the client reads h.t, and `start` rendered every bar as zero.
      return [...byHour.entries()].sort((a, b) => a[0] - b[0])
        .map(([t, made]) => ({ t: new Date(t).toISOString(), made }));
    });
    return ok(res, { key: dc.key, hours }, { from: fromD.toISOString(), to: endD.toISOString() });
  }

  // Counter key from the machine's current snapshot — the timeline's choice too.
  const snapKey = pickProductionKey(flattenData((m.currentParameters as Record<string, unknown>) || {}));
  const key = snapKey && !snapKey.includes('.') ? snapKey : null;
  if (!key) return ok(res, { key: null, hours: [] });

  const HOUR = 3600_000;
  const cacheKey = `hourly:${refs.join('|')}:${key}:${fromD.toISOString()}:${endD.toISOString()}`;
  const hours = await cached(cacheKey, 30_000, async () => {
    // Highest counter value per minute (replay-proof), stepped in Node — then
    // each confirmed climb lands in the hour of the sample that observed it.
    const rows = await Telemetry.aggregate([
      { $match: { machineId: { $in: refs }, timestamp: { $gte: fromD, $lte: endD } } },
      { $addFields: { pv: { $getField: { field: key, input: '$data' } } } },
      { $match: { pv: { $type: ['int', 'long', 'double', 'decimal'] } } },
      { $group: { _id: { $dateTrunc: { date: '$timestamp', unit: 'minute' } }, v: { $max: '$pv' } } },
    ]).option({ maxTimeMS: 20000 }).exec() as { _id: Date; v: number }[];
    const series = rows.map((r) => ({ t: new Date(r._id).getTime(), v: Number(r.v) })).filter((p) => Number.isFinite(p.v));
    const offset = fromD.getTime();
    const byHour = new Map<number, number>();
    for (const ev of stepEvents(series, PROD_STEP_PER_MIN)) {
      const b = Math.floor((ev.t - offset) / HOUR) * HOUR + offset;
      byHour.set(b, (byHour.get(b) || 0) + ev.made);
    }
    return [...byHour.entries()].sort((a, b) => a[0] - b[0])
      .map(([t, made]) => ({ t: new Date(t).toISOString(), made }));
  });
  return ok(res, { key, hours }, { from: fromD.toISOString(), to: endD.toISOString() });
});

// ── Display names ────────────────────────────────────────────────────────────
// A label is not an identity. These two endpoints are the ONLY writes involved
// in renaming a machine: nothing here touches the machines collection, the
// telemetry, or any historical row, all of which stay keyed by the real code
// the PLC posts under.

// GET /machines/labels — every custom name, for everyone who can see machines.
// Small (one row per renamed machine) and read on every page, so it is cached.
export const listMachineLabels = asyncHandler(async (_req, res) => {
  const rows = await cached('machinelabels', 30_000, () =>
    MachineLabel.find().select({ machineRef: 1, displayName: 1, updatedBy: 1, updatedAt: 1 }).lean());
  return ok(res, rows);
});

// PUT /machines/:code/label { displayName } — admin only (see the route).
// An empty name removes the label and the machine goes back to its own code.
export const setMachineLabel = asyncHandler(async (req, res) => {
  const ref = String(req.params.code || '').trim();
  if (!ref) return fail(res, 400, 'machine code is required');
  const raw = String((req.body as { displayName?: unknown })?.displayName ?? '').trim();
  if (raw.length > 60) return fail(res, 400, 'Name is too long (60 characters max)');

  // The machine has to exist — a label for a code nobody posts under is a typo
  // that would then haunt every screen.
  const machine = await findMachine(ref);
  if (!machine) return fail(res, 404, `No machine posts as "${ref}"`);
  const realRef = String(machine.code || machine.machineId || ref);

  const who = { id: String((req.user as { _id?: unknown })?._id || ''), name: (req.user as { name?: string })?.name };
  const before = await MachineLabel.findOne({ machineRef: refMatch(realRef) }).lean();

  if (!raw) {
    await MachineLabel.deleteMany({ machineRef: refMatch(realRef) });
  } else {
    // deleteMany + create, not upsert: an older row could carry a differently
    // punctuated ref (SPG-06 vs SPG06) and leave two labels for one machine.
    await MachineLabel.deleteMany({ machineRef: refMatch(realRef) });
    await MachineLabel.create({ machineRef: realRef, displayName: raw, updatedBy: who });
  }
  invalidate('machinelabels');

  AuditLog.create({
    at: new Date(),
    user: who,
    action: raw ? 'machine.rename' : 'machine.rename.clear',
    entity: { type: 'machine', id: realRef, label: raw ? `${realRef} → ${raw}` : realRef },
    before: before ? { displayName: before.displayName } : null,
    after: raw ? { displayName: raw } : null,
  }).catch(() => {});

  return ok(res, { machineRef: realRef, displayName: raw });
});
