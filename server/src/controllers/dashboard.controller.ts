// server/src/controllers/dashboard.controller.ts
// All figures are aggregated from the real `machines` collection (+ downtime_reports
// and users when those exist). Nothing is fabricated; empty collections yield zeros.
import { Machine }       from '../models/Machine.js';
import { Telemetry }     from '../models/Telemetry.js';
import { DowntimeEvent } from '../models/DowntimeEvent.js';
import { User }          from '../models/User.js';
import { Role }          from '../models/Role.js';
import { ok, fail, asyncHandler } from '../utils/http.js';
import { getFleetSnapshot } from '../services/fleet.service.js';
import { machineScope } from '../utils/scope.js';
import { cached } from '../utils/cache.js';
import { computeActivity } from '../services/activity.service.js';

type ScopedUser = { isSuperAdmin?: boolean; assignedMachines?: string[] };

const num = (path: string): { $ifNull: [string, number] } => ({ $ifNull: [path, 0] });
const pct = (a: number, b: number): number => (b ? Math.round((a / b) * 100) : 0);

// What a complete monitoring solution would expose. `live` = derivable from today's
// data; `blocked` = needs a signal no machine currently streams.
const CAPABILITIES = {
  live: ['Machine status & uptime', 'Downtime & availability', 'Anomaly & fault detection', 'Signal / telemetry coverage'],
  blocked: [
    { name: 'Production output', needs: 'piece / production counter' },
    { name: 'OEE & performance', needs: 'cycle time + good/reject counts' },
    { name: 'Cycle time', needs: 'cycle start / complete signal' },
    { name: 'Energy / gas consumption', needs: 'kWh or gas-flow meter' },
    { name: 'Tool life & maintenance', needs: 'tool-change counter' },
  ],
};

// GET /dashboard/overview — the fleet ANALYSIS layer: aggregates, ratios,
// distributions, instrumentation gap analysis. All derived from REAL data.
export const overview = asyncHandler(async (req, res) => {
  const q = req.query as Record<string, string | undefined>;
  const parseD = (s?: string): Date | null => {
    if (!s) return null;
    const d = new Date(s);
    return Number.isNaN(d.getTime()) ? null : d;
  };
  // Optional filters: ?machineId=&from=&to= — every applicable metric below
  // derives from the SAME filtered dataset (machine + range), per-scope enforced.
  const fromD = parseD(q.from);
  const toD = parseD(q.to);
  const rangeActive = !!(fromD && toD && fromD < toD);

  // Default edges are rounded to the MINUTE so cache keys repeat between polls
  // (per-request Date.now() would defeat the 30s cache and grow it unboundedly).
  const nowMin   = Math.floor(Date.now() / 60_000) * 60_000;
  const since24h = new Date(nowMin - 24 * 3600 * 1000);
  const since7d  = new Date(nowMin - 7 * 24 * 3600 * 1000);
  const downFrom = rangeActive ? (fromD as Date) : since24h;
  const downTo   = rangeActive ? (toD as Date)   : new Date(nowMin);
  const volFrom  = rangeActive ? (fromD as Date) : since7d;
  const volTo    = rangeActive ? (toD as Date)   : new Date(nowMin);

  // Row-level scope: a restricted user sees a dashboard built only from their machines.
  const scope = machineScope(req.user as ScopedUser | undefined);

  // Explicit machine — resolve its code/machineId aliases; must be inside scope.
  let only: string[] | null = null;
  if (q.machineId) {
    if (scope && !scope.includes(q.machineId)) return fail(res, 403, 'Machine not in your scope');
    const mdoc = (await Machine.findOne({ $or: [{ code: q.machineId }, { machineId: q.machineId }] })
      .select({ code: 1, machineId: 1 }).lean()) as { code?: string; machineId?: string } | null;
    only = mdoc ? ([mdoc.code, mdoc.machineId].filter(Boolean) as string[]) : [q.machineId];
  }
  const refs = only ?? scope;                                   // telemetry/downtime machineId refs
  const sm = refs ? { machineId: { $in: refs } } : null;
  const machineMatch = refs ? { $or: [{ code: { $in: refs } }, { machineId: { $in: refs } }] } : null;

  // The heavy hitters (fleet snapshot, telemetry volume scan, range activity) are
  // cached for 30s keyed by scope+filters: all clients polling the dashboard share
  // ONE Atlas computation, and a restricted user never sees another scope's data.
  const scopeKey = JSON.stringify(scope || 'all');
  const filterKey = scopeKey + ':' + JSON.stringify(only) + ':' + volFrom.toISOString() + ':' + volTo.toISOString();
  const [snapshot, statusAgg, downAgg, employeeCount, activity, teamByRole, rolesCount, superAdmins, act] = await Promise.all([
    cached('snap:' + scopeKey, 30_000, () => getFleetSnapshot(scope)),
    Machine.aggregate([...(machineMatch ? [{ $match: machineMatch }] : []), { $group: { _id: '$status', count: { $sum: 1 } } }]),
    // Events OVERLAPPING the window (not just started inside it) — a span that
    // crossed the boundary must count. Duration totals come from the activity
    // engine below (clipped to the window) so the two figures can't contradict.
    DowntimeEvent.aggregate([
      { $match: {
        startedAt: { $lte: downTo },
        $or: [{ endedAt: null }, { endedAt: { $gte: downFrom } }],
        ...(sm || {}),
      } },
      { $group: { _id: null, count: { $sum: 1 } } },
    ]),
    User.countDocuments({ active: true }),
    cached('vol:' + filterKey, 30_000, () => Telemetry.aggregate([
      { $match: { timestamp: { $gte: volFrom, $lte: volTo }, ...(sm || {}) } },
      { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$timestamp' } }, readings: { $sum: 1 } } },
      { $sort: { _id: 1 } },
    ]).option({ maxTimeMS: 20000, allowDiskUse: true }).exec()),
    User.aggregate([
      { $match: { active: true } },
      { $group: { _id: '$role', count: { $sum: 1 } } },
      { $lookup: { from: 'roles', localField: '_id', foreignField: '_id', as: 'r' } },
      { $project: { count: 1, role: { $ifNull: [{ $first: '$r.name' }, null] } } },
    ]),
    Role.estimatedDocumentCount(),
    User.countDocuments({ active: true, isSuperAdmin: true }),
    // Window activity — production/runtime/downtime for the selected range
    // (default: last 24h), from the same shared engine as /machines/activity
    // and /dashboard/rankings so the three surfaces always agree.
    computeActivity(scope, rangeActive ? (fromD as Date) : since24h, rangeActive ? (toD as Date) : new Date(nowMin), only),
  ]);

  // Machine filter applies to the snapshot-derived sections too (health, signals,
  // composition, machine list) so no stale fleet-wide value survives filtering.
  const snapRows = only ? snapshot.filter((m) => (only as string[]).includes(m.machineId)) : snapshot;

  const byRole = (teamByRole as { role?: string; count: number }[])
    .map((t) => ({ role: t.role || 'Unassigned', count: t.count }))
    .sort((a, b) => b.count - a.count);

  const fleet: Record<string, number> = { total: 0, running: 0, idle: 0, stopped: 0, offline: 0 };
  (statusAgg as { _id: string | null; count: number }[]).forEach((r) => { const k = r._id || 'offline'; fleet[k] = (fleet[k] || 0) + r.count; fleet.total += r.count; });

  const health: Record<string, number> = { healthy: 0, warning: 0, critical: 0, offline: 0 };
  const byCategory: Record<string, number> = { fault: 0, range: 0, deviation: 0, stale: 0, offline: 0, other: 0 };
  const byType: Record<string, { type: string; count: number; readings: number }> = {};
  const byClass: Record<string, { class: string; count: number; alerts: number }> = {};
  let named = 0, io = 0, registers = 0, scoreSum = 0, reporting = 0, live = 0, totalReadings = 0;

  for (const m of snapRows) {
    health[m.health.status] = (health[m.health.status] || 0) + 1;
    scoreSum += m.health.score;
    named += m.namedCount || 0; io += m.ioCount || 0; registers += m.registers || 0;
    totalReadings += m.readings || 0;
    if (m.signals > 0 || m.registers > 0) reporting += 1;
    if (m.health.freshness === 'live') live += 1;
    for (const a of m.health.alerts) byCategory[a.category] = (byCategory[a.category] || 0) + 1;
    const t = m.type || 'unclassified';
    (byType[t] = byType[t] || { type: t, count: 0, readings: 0 });
    byType[t].count += 1; byType[t].readings += m.readings || 0;
    const c = m.class || 'unclassified';
    (byClass[c] = byClass[c] || { class: c, count: 0, alerts: 0 });
    byClass[c].count += 1; byClass[c].alerts += m.health.counts.total;
  }

  const totalSignals = named + io + registers;
  const mapped = named + io;
  const avgScore = snapRows.length ? Math.round(scoreSum / snapRows.length) : 0;
  const alertTotal = Object.values(byCategory).reduce((s, n) => s + n, 0);
  const critical = byCategory.fault + byCategory.range;
  const warning  = byCategory.deviation + byCategory.stale;
  const byTypeArr = Object.values(byType).sort((a, b) => b.readings - a.readings);
  const dt = (downAgg as { count: number }[])[0];

  const machines = snapRows.map((m) => ({
    machineId: m.machineId, name: m.name, type: m.type, class: m.class, status: m.status,
    lastSeenAt: m.lastSeenAt, readings: m.readings || 0,
    namedCount: m.namedCount || 0, ioCount: m.ioCount || 0, registers: m.registers || 0, faultCount: m.faultCount || 0,
    health: { score: m.health.score, status: m.health.status, freshness: m.health.freshness, counts: m.health.counts, alerts: m.health.alerts },
  }));

  // Window KPIs — real, reconstructed figures for the selected range. OEE stays
  // null: its inputs (cycle time, good/reject counts) don't exist in the data,
  // and we never fabricate metrics.
  const wRows = act.rows;
  const wRunning = wRows.reduce((s, r) => s + r.runningMs, 0);
  const wIdle    = wRows.reduce((s, r) => s + r.idleMs, 0);
  const wStopped = wRows.reduce((s, r) => s + r.stoppedMs, 0);
  const wOffline = wRows.reduce((s, r) => s + r.offlineMs, 0);
  const wProd    = wRows.reduce((s, r) => s + (r.production ?? 0), 0);
  const windowBlock = {
    from: act.from.toISOString(), to: act.to.toISOString(), windowMs: act.windowMs,
    machines: wRows.length,
    reported: wRows.filter((r) => r.live).length,
    production: wProd,
    runningMs: wRunning, idleMs: wIdle, stoppedMs: wStopped, offlineMs: wOffline,
    downtimeMs: wStopped + wOffline,
    availabilityPct: act.windowMs && wRows.length ? Math.round((wRunning / (act.windowMs * wRows.length)) * 100) : 0,
    oee: null,
  };

  return ok(res, {
    filters: { machineId: q.machineId || null, from: rangeActive ? (fromD as Date).toISOString() : null, to: rangeActive ? (toD as Date).toISOString() : null },
    window: windowBlock,
    fleet,
    health: { ...health, avgScore },
    reporting: { reporting, live, total: snapRows.length },
    alerts: { total: alertTotal, critical, warning, info: byCategory.offline + byCategory.other, byCategory },
    signals: { named, io, registers, mapped, total: totalSignals, mappedPct: pct(mapped, totalSignals) },
    volume: { totalReadings, perDay: (activity as { _id: string; readings: number }[]).map((a) => ({ day: a._id, readings: a.readings })), byType: byTypeArr },
    // Duration is the activity engine's window-clipped total — same source as
    // the window KPI block, so the two downtime figures always agree.
    downtime: { totalMs: windowBlock.downtimeMs + windowBlock.idleMs, events: dt?.count || 0 },
    composition: {
      byType:  byTypeArr.map((t) => ({ type: t.type, count: t.count })),
      byClass: Object.values(byClass).sort((a, b) => b.count - a.count),
    },
    capabilities: {
      live: CAPABILITIES.live,
      blocked: CAPABILITIES.blocked,
      liveCount: CAPABILITIES.live.length,
      total: CAPABILITIES.live.length + CAPABILITIES.blocked.length,
    },
    machines,
    employees: employeeCount,
    team: { employees: employeeCount, superAdmins, roles: rolesCount, byRole },
  });
});

// GET /dashboard/production — output + OEE per machine type (the bar lists)
export const production = asyncHandler(async (req, res) => {
  const rows = await Machine.aggregate([
    {
      $group: {
        _id:      '$type',
        output:   { $sum: num('$totalOutput') },
        avgOee:   { $avg: num('$oee') },
        machines: { $sum: 1 },
        running:  { $sum: { $cond: [{ $eq: ['$status', 'running'] }, 1, 0] } },
      },
    },
    { $sort: { output: -1 } },
  ]);
  return ok(res, rows.map((r) => ({
    type:       r._id,
    output:     Math.round(r.output),
    efficiency: Math.round(r.avgOee || 0),
    machines:   r.machines,
    running:    r.running,
  })));
});

// GET /dashboard/rankings?from&to — per-machine performance over a range, from
// the shared activity engine. "Performance" here = availability (running time /
// window) with production as the tiebreak — the only officially derivable
// metrics; OEE is never fabricated. The client slices top/bottom N.
export const rankings = asyncHandler(async (req, res) => {
  const q = req.query as Record<string, string | undefined>;
  const parseD = (s?: string): Date | null => {
    if (!s) return null;
    const d = new Date(s);
    return Number.isNaN(d.getTime()) ? null : d;
  };
  const toD = parseD(q.to) || new Date();
  const fromD = parseD(q.from) || new Date(toD.getTime() - 24 * 3600 * 1000);
  if (fromD >= toD) return fail(res, 400, 'from must be before to');

  const scope = machineScope(req.user as ScopedUser | undefined);
  const act = await computeActivity(scope, fromD, toD);

  const rows = act.rows
    .map((r) => ({
      code: r.code, name: r.name, type: r.type, status: r.status, live: r.live,
      production: r.production,
      runningMs: r.runningMs,
      downtimeMs: r.stoppedMs + r.offlineMs,
      idleMs: r.idleMs,
      availabilityPct: act.windowMs ? Math.round((r.runningMs / act.windowMs) * 100) : 0,
    }))
    .sort((a, b) =>
      (b.availabilityPct - a.availabilityPct)
      || ((b.production ?? -1) - (a.production ?? -1))
      || a.code.localeCompare(b.code));

  return ok(res, rows, { from: act.from.toISOString(), to: act.to.toISOString(), windowMs: act.windowMs });
});
