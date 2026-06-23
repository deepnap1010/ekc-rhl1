// server/src/controllers/machine.controller.ts
// READ-ONLY access to the real `machines` + `telemetries` collections.
// A machine is identified by its `code` (e.g. "TARAPUR-M01"); telemetry rows
// reference that code via `machineId`.
import mongoose, { type FilterQuery } from 'mongoose';
import { Machine }   from '../models/Machine.js';
import type { IMachine } from '../models/Machine.js';
import { Telemetry } from '../models/Telemetry.js';
import { ok, fail, asyncHandler } from '../utils/http.js';
import { flattenData } from '../utils/flatten.js';
import { computeStats } from '../utils/metrics.js';
import { normalizeData, rankNamed } from '../utils/normalize.js';
import { getProfile } from '../config/machineProfiles.js';
import { machineScope } from '../utils/scope.js';

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
    const key = r._id || 'offline';
    summary[key] = (summary[key] || 0) + r.count;
    summary.total += r.count;
  });
  return ok(res, summary);
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
  if (!inUserScope(req.user as ScopeUser, req.params.code)) return fail(res, 403, 'You are not assigned to this machine');
  const { from, to, page = 1, limit = 50 } = req.query as Record<string, string | undefined>;
  const lim  = Math.min(Number(limit) || 50, 200);
  const skip = (Number(page) - 1) * lim;

  const q: FilterQuery<Record<string, unknown>> = { machineId: req.params.code };
  if (from || to) {
    const range: { $gte?: Date; $lte?: Date } = {};
    if (from) range.$gte = new Date(from);
    if (to)   range.$lte = new Date(to);
    q.timestamp = range;
  }

  const [items, total] = await Promise.all([
    Telemetry.find(q).sort({ timestamp: -1 }).skip(skip).limit(lim).lean(),
    Telemetry.countDocuments(q),
  ]);

  // Flatten nested payloads so the history table + CSV expose every signal.
  const flat = items.map((it) => ({ ...it, data: flattenData(it.data) }));

  return ok(res, flat, { total, page: Number(page), limit: lim });
});
