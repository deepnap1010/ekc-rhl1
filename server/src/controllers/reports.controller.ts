// server/src/controllers/reports.controller.ts
// READ-ONLY reporting over the real collections. OEE = efficiency, totalOutput = output.
// Plant ids are resolved to names via a lookup against `plants` (null until that
// collection exists — reported as "Unassigned").
import type { FilterQuery, PipelineStage } from 'mongoose';
import { Machine }       from '../models/Machine.js';
import type { IMachine } from '../models/Machine.js';
import { DowntimeEvent } from '../models/DowntimeEvent.js';
import type { IDowntimeEvent } from '../models/DowntimeEvent.js';
import { ok, asyncHandler } from '../utils/http.js';
import { getFleetSnapshot } from '../services/fleet.service.js';
import { machineScope } from '../utils/scope.js';

type ScopedUser = { isSuperAdmin?: boolean; assignedMachines?: string[] };

const num = (p: string): { $ifNull: [string, number] } => ({ $ifNull: [p, 0] });

// A machine row projected for the report (plant is populated to its name).
type PopulatedMachine = Omit<IMachine, 'plant'> & { plant?: { name?: string } | null };

// Resolve a grouped-by-plant pipeline tail: _id is a plant ObjectId.
const resolvePlantName: PipelineStage[] = [
  { $lookup: { from: 'plants', localField: '_id', foreignField: '_id', as: '_plant' } },
  { $addFields: { plantName: { $ifNull: [{ $first: '$_plant.name' }, null] } } },
  { $project: { _plant: 0 } },
];

// Human labels for the health-engine alert categories (the "error statuses").
const ERROR_LABELS: Record<string, string> = {
  fault:     'Sensor fault',
  range:     'Out of range',
  deviation: 'Set / actual drift',
  stale:     'Stale (running, no data)',
  offline:   'Offline',
  other:     'Other',
};

// GET /reports/overview — single-call downtime & error analysis console.
// Composes the live health snapshot (status mix + categorised errors) with the
// recorded downtime events (per-machine breakdown) over a rolling window. All real.
export const overviewReport = asyncHandler(async (req, res) => {
  const scope = machineScope(req.user as ScopedUser | undefined);
  const sm = scope ? { machineId: { $in: scope } } : {};
  const windowDays = Math.min(Math.max(Number((req.query as Record<string, string | undefined>).days) || 30, 1), 365);
  const since = new Date(Date.now() - windowDays * 24 * 3600 * 1000);

  const [snapshot, totals, byMachine] = await Promise.all([
    getFleetSnapshot(scope),
    DowntimeEvent.aggregate([
      { $match: { startedAt: { $gte: since }, ...sm } as PipelineStage.Match['$match'] },
      { $group: { _id: null, events: { $sum: 1 }, totalMs: { $sum: num('$durationMs') }, open: { $sum: { $cond: [{ $eq: ['$endedAt', null] }, 1, 0] } } } },
    ]),
    DowntimeEvent.aggregate([
      { $match: { startedAt: { $gte: since }, ...sm } as PipelineStage.Match['$match'] },
      { $group: { _id: '$machineId', events: { $sum: 1 }, totalMs: { $sum: num('$durationMs') }, open: { $sum: { $cond: [{ $eq: ['$endedAt', null] }, 1, 0] } } } },
      { $sort: { totalMs: -1 } },
    ]),
  ]);

  // Live status mix + categorised errors, from the same health engine the whole app
  // uses — so the donut and the KPI counts always agree with Alerts/Dashboard.
  const status: Record<string, number> = { running: 0, idle: 0, stopped: 0, offline: 0 };
  const cat: Record<string, number> = { fault: 0, range: 0, deviation: 0, stale: 0, offline: 0, other: 0 };
  let faults = 0, critical = 0, warning = 0, scoreSum = 0;
  for (const m of snapshot) {
    status[m.status] = (status[m.status] || 0) + 1;
    faults += m.faultCount || 0;
    scoreSum += m.health.score;
    if (m.health.status === 'critical') critical += 1;
    else if (m.health.status === 'warning') warning += 1;
    for (const a of m.health.alerts) cat[a.category] = (cat[a.category] || 0) + 1;
  }
  const errors = Object.values(cat).reduce((s, n) => s + n, 0);

  const errorsByStatus = Object.entries(cat)
    .filter(([, v]) => v > 0)
    .map(([k, v]) => ({ key: k, label: ERROR_LABELS[k] || k, count: v }))
    .sort((a, b) => b.count - a.count);

  const statusMix = [
    { key: 'running', label: 'Running', count: status.running ?? 0 },
    { key: 'idle',    label: 'Idle',    count: status.idle ?? 0 },
    { key: 'stopped', label: 'Stopped', count: status.stopped ?? 0 },
    { key: 'offline', label: 'Offline', count: status.offline ?? 0 },
  ].filter((s) => s.count > 0);

  return ok(res, {
    windowDays,
    kpis: {
      machines: snapshot.length,
      running: status.running ?? 0, idle: status.idle ?? 0, stopped: status.stopped ?? 0, offline: status.offline ?? 0,
      faults, errors, criticalMachines: critical, warningMachines: warning,
      avgHealth: snapshot.length ? Math.round(scoreSum / snapshot.length) : 0,
      downtimeMs: totals[0]?.totalMs || 0,
      downtimeEvents: totals[0]?.events || 0,
      openDowntime: totals[0]?.open || 0,
    },
    statusMix,
    errorsByStatus,
    downtimeByMachine: byMachine.map((m) => ({ machineId: m._id as string, events: m.events as number, totalMs: m.totalMs as number, open: m.open as number })),
  });
});

// GET /reports/production — production summary by type + plant
export const productionReport = asyncHandler(async (req, res) => {
  const { plant } = req.query as Record<string, string | undefined>;
  const match: FilterQuery<IMachine> = {};
  if (plant && plant !== 'all') match.plant = plant;

  const [byType, byPlant, machines] = await Promise.all([
    Machine.aggregate([
      { $match: match as PipelineStage.Match['$match'] },
      {
        $group: {
          _id: '$type',
          output:   { $sum: num('$totalOutput') },
          avgOee:   { $avg: num('$oee') },
          machines: { $sum: 1 },
          running:  { $sum: { $cond: [{ $eq: ['$status', 'running'] }, 1, 0] } },
        },
      },
      { $sort: { output: -1 } },
    ]),
    Machine.aggregate([
      { $match: match as PipelineStage.Match['$match'] },
      {
        $group: {
          _id: '$plant',
          output:   { $sum: num('$totalOutput') },
          avgOee:   { $avg: num('$oee') },
          machines: { $sum: 1 },
          running:  { $sum: { $cond: [{ $eq: ['$status', 'running'] }, 1, 0] } },
        },
      },
      ...resolvePlantName,
      { $sort: { output: -1 } },
    ]),
    Machine.find(match).populate({ path: 'plant', select: 'name' })
      .select('code name type plant status totalOutput oee ratedCapacity')
      .sort({ type: 1, name: 1 }).lean(),
  ]);

  return ok(res, {
    byType: byType.map((r) => ({ type: r._id, output: Math.round(r.output), efficiency: Math.round(r.avgOee || 0), machines: r.machines, running: r.running })),
    byPlant: byPlant.map((r) => ({ plant: r.plantName || 'Unassigned', output: Math.round(r.output), efficiency: Math.round(r.avgOee || 0), machines: r.machines, running: r.running })),
    machines: (machines as unknown as PopulatedMachine[]).map((m) => ({
      code:       m.code,
      name:       m.name,
      type:       m.type,
      plant:      m.plant?.name || 'Unassigned',
      status:     m.status,
      output:     Math.round(m.totalOutput ?? 0),
      efficiency: Math.round(m.oee ?? 0),
      capacity:   Math.round(m.ratedCapacity ?? 0),
    })),
  });
});

// GET /reports/downtime — downtime summary (reads downtime_reports; empty → zeros)
export const downtimeReport = asyncHandler(async (req, res) => {
  const { plant, from, to } = req.query as Record<string, string | undefined>;

  const match: FilterQuery<IDowntimeEvent> = {};
  if (from || to) {
    const range: { $gte?: Date; $lte?: Date } = {};
    if (from) range.$gte = new Date(from);
    if (to)   range.$lte = new Date(to);
    match.startedAt = range;
  }
  if (plant && plant !== 'all') {
    const codes = await Machine.find({ plant }).select('code').lean();
    match.machineId = { $in: codes.map((m) => m.code) };
  }

  const [byMachine, byType, totals] = await Promise.all([
    DowntimeEvent.aggregate([
      { $match: match as PipelineStage.Match['$match'] },
      { $group: { _id: '$machineId', events: { $sum: 1 }, totalMs: { $sum: num('$durationMs') } } },
      { $sort: { totalMs: -1 } },
      { $limit: 20 },
    ]),
    DowntimeEvent.aggregate([
      { $match: match as PipelineStage.Match['$match'] },
      { $group: { _id: '$type', events: { $sum: 1 }, totalMs: { $sum: num('$durationMs') } } },
    ]),
    DowntimeEvent.aggregate([
      { $match: match as PipelineStage.Match['$match'] },
      { $group: { _id: null, totalEvents: { $sum: 1 }, totalMs: { $sum: num('$durationMs') } } },
    ]),
  ]);

  return ok(res, { totals: totals[0] || { totalEvents: 0, totalMs: 0 }, byType, byMachine });
});

// GET /reports/plants — plant-level status + output rollup
export const plantsReport = asyncHandler(async (req, res) => {
  const plants = await Machine.aggregate([
    {
      $group: {
        _id: '$plant',
        total:        { $sum: 1 },
        running:      { $sum: { $cond: [{ $eq: ['$status', 'running'] }, 1, 0] } },
        idle:         { $sum: { $cond: [{ $eq: ['$status', 'idle'] }, 1, 0] } },
        stopped:      { $sum: { $cond: [{ $eq: ['$status', 'stopped'] }, 1, 0] } },
        offline:      { $sum: { $cond: [{ $eq: ['$status', 'offline'] }, 1, 0] } },
        totalOutput:  { $sum: num('$totalOutput') },
        avgOee:       { $avg: num('$oee') },
      },
    },
    ...resolvePlantName,
    { $sort: { totalOutput: -1 } },
  ]);

  return ok(res, plants.map((p) => ({
    plant:         p.plantName || 'Unassigned',
    total:         p.total,
    running:       p.running,
    idle:          p.idle,
    stopped:       p.stopped,
    offline:       p.offline,
    totalOutput:   Math.round(p.totalOutput),
    avgEfficiency: Math.round(p.avgOee || 0),
  })));
});

// GET /reports/fleet — per-machine performance (health-scored) + per-class rollup.
export const fleetReport = asyncHandler(async (req, res) => {
  const scope = machineScope(req.user as ScopedUser | undefined);
  const sm = scope ? { machineId: { $in: scope } } : {};

  const [snapshot, downByMachine] = await Promise.all([
    getFleetSnapshot(scope),
    DowntimeEvent.aggregate([
      { $match: sm as PipelineStage.Match['$match'] },
      { $group: { _id: '$machineId', events: { $sum: 1 }, totalMs: { $sum: num('$durationMs') } } },
    ]),
  ]);
  const dt: Record<string, { events: number; totalMs: number }> = Object.fromEntries(
    downByMachine.map((d) => [d._id as string, { events: d.events as number, totalMs: d.totalMs as number }]),
  );

  const machines = snapshot.map((m) => {
    const d = dt[m.machineId] || { events: 0, totalMs: 0 };
    return {
      machineId: m.machineId, name: m.name, type: m.type, class: m.class, status: m.status,
      health: m.health.status, score: m.health.score, readings: m.readings || 0,
      namedCount: m.namedCount || 0, ioCount: m.ioCount || 0, registers: m.registers || 0, faultCount: m.faultCount || 0,
      downtimeMs: d.totalMs, downtimeEvents: d.events,
    };
  });

  const byClass: Record<string, { class: string; machines: number; readings: number; faults: number; scoreSum: number }> = {};
  for (const m of machines) {
    const c = m.class || 'unclassified';
    const g = byClass[c] || (byClass[c] = { class: c, machines: 0, readings: 0, faults: 0, scoreSum: 0 });
    g.machines += 1; g.readings += m.readings; g.faults += m.faultCount; g.scoreSum += m.score;
  }

  return ok(res, {
    machines,
    byClass: Object.values(byClass)
      .map((g) => ({ class: g.class, machines: g.machines, readings: g.readings, faults: g.faults, avgScore: Math.round(g.scoreSum / g.machines) }))
      .sort((a, b) => b.machines - a.machines),
    totals: {
      machines: machines.length,
      readings: machines.reduce((s, m) => s + m.readings, 0),
      signals: machines.reduce((s, m) => s + m.namedCount + m.ioCount, 0),
      registers: machines.reduce((s, m) => s + m.registers, 0),
      faults: machines.reduce((s, m) => s + m.faultCount, 0),
    },
  });
});

// GET /reports/reliability — MTBF / MTTR / availability over a rolling window.
export const reliabilityReport = asyncHandler(async (req, res) => {
  const scope = machineScope(req.user as ScopedUser | undefined);
  const sm = scope ? { machineId: { $in: scope } } : {};
  const windowDays = Math.min(Math.max(Number((req.query as Record<string, string | undefined>).days) || 30, 1), 365);
  const windowMs = windowDays * 24 * 3600 * 1000;
  const since = new Date(Date.now() - windowMs);

  const agg = await DowntimeEvent.aggregate([
    { $match: { startedAt: { $gte: since }, ...sm } as PipelineStage.Match['$match'] },
    { $group: { _id: '$machineId', events: { $sum: 1 }, totalMs: { $sum: num('$durationMs') } } },
    { $sort: { totalMs: -1 } },
  ]);

  const machines = agg.map((d) => {
    const downtimeMs = Math.min(d.totalMs as number, windowMs);
    const operatingMs = Math.max(0, windowMs - downtimeMs);
    const events = d.events as number;
    return {
      machineId: d._id as string, events, downtimeMs,
      availability: Math.round((operatingMs / windowMs) * 1000) / 10,
      mttrMs: events ? Math.round(downtimeMs / events) : 0,
      mtbfMs: events ? Math.round(operatingMs / events) : operatingMs,
    };
  });

  return ok(res, { windowDays, machines });
});
