// server/src/controllers/dashboard.controller.ts
// All figures are aggregated from the real `machines` collection (+ downtime_reports
// and users when those exist). Nothing is fabricated; empty collections yield zeros.
import { Machine }       from '../models/Machine.js';
import { Telemetry }     from '../models/Telemetry.js';
import { DowntimeEvent } from '../models/DowntimeEvent.js';
import { User }          from '../models/User.js';
import { Role }          from '../models/Role.js';
import { ok, asyncHandler } from '../utils/http.js';
import { getFleetSnapshot } from '../services/fleet.service.js';
import { machineScope } from '../utils/scope.js';

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
  const since24h = new Date(Date.now() - 24 * 3600 * 1000);
  const since7d  = new Date(Date.now() - 7 * 24 * 3600 * 1000);

  // Row-level scope: a restricted user sees a dashboard built only from their machines.
  const scope = machineScope(req.user as ScopedUser | undefined);
  const sm = scope ? { machineId: { $in: scope } } : null;

  const [snapshot, statusAgg, downAgg, employeeCount, activity, teamByRole, rolesCount, superAdmins] = await Promise.all([
    getFleetSnapshot(scope),
    Machine.aggregate([...(sm ? [{ $match: sm }] : []), { $group: { _id: '$status', count: { $sum: 1 } } }]),
    DowntimeEvent.aggregate([
      { $match: { startedAt: { $gte: since24h }, ...(sm || {}) } },
      { $group: { _id: null, totalMs: { $sum: num('$durationMs') }, count: { $sum: 1 } } },
    ]),
    User.countDocuments({ active: true }),
    Telemetry.aggregate([
      { $match: { timestamp: { $gte: since7d }, ...(sm || {}) } },
      { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$timestamp' } }, readings: { $sum: 1 } } },
      { $sort: { _id: 1 } },
    ]),
    User.aggregate([
      { $match: { active: true } },
      { $group: { _id: '$role', count: { $sum: 1 } } },
      { $lookup: { from: 'roles', localField: '_id', foreignField: '_id', as: 'r' } },
      { $project: { count: 1, role: { $ifNull: [{ $first: '$r.name' }, null] } } },
    ]),
    Role.estimatedDocumentCount(),
    User.countDocuments({ active: true, isSuperAdmin: true }),
  ]);

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

  for (const m of snapshot) {
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
  const avgScore = snapshot.length ? Math.round(scoreSum / snapshot.length) : 0;
  const alertTotal = Object.values(byCategory).reduce((s, n) => s + n, 0);
  const critical = byCategory.fault + byCategory.range;
  const warning  = byCategory.deviation + byCategory.stale;
  const byTypeArr = Object.values(byType).sort((a, b) => b.readings - a.readings);
  const dt = (downAgg as { totalMs: number; count: number }[])[0];

  const machines = snapshot.map((m) => ({
    machineId: m.machineId, name: m.name, type: m.type, class: m.class, status: m.status,
    lastSeenAt: m.lastSeenAt, readings: m.readings || 0,
    namedCount: m.namedCount || 0, ioCount: m.ioCount || 0, registers: m.registers || 0, faultCount: m.faultCount || 0,
    health: { score: m.health.score, status: m.health.status, freshness: m.health.freshness, counts: m.health.counts, alerts: m.health.alerts },
  }));

  return ok(res, {
    fleet,
    health: { ...health, avgScore },
    reporting: { reporting, live, total: snapshot.length },
    alerts: { total: alertTotal, critical, warning, info: byCategory.offline + byCategory.other, byCategory },
    signals: { named, io, registers, mapped, total: totalSignals, mappedPct: pct(mapped, totalSignals) },
    volume: { totalReadings, perDay: (activity as { _id: string; readings: number }[]).map((a) => ({ day: a._id, readings: a.readings })), byType: byTypeArr },
    downtime: { totalMs: dt?.totalMs || 0, events: dt?.count || 0 },
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
