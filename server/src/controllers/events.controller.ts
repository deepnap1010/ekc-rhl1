// server/src/controllers/events.controller.ts
// Read API over the operational event log (machine_events). This is what the
// event-based History surfaces consume: state sessions + production events,
// filterable by machine / kind / state / time range. Read-only; events are
// written solely by the sweep (services/event.service).
import { MachineEvent } from '../models/MachineEvent.js';
import { ok, fail, asyncHandler } from '../utils/http.js';
import { machineScope } from '../utils/scope.js';

type ScopedUser = { isSuperAdmin?: boolean; assignedMachines?: string[] };
type RangeFilter = { $gte?: Date; $lte?: Date };

const parseDate = (s: string | undefined): Date | null => {
  if (!s) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
};

// GET /events — paginated event feed, newest first.
// Query: machineId?, kind? (state|production), state?, from?, to?, page?, limit?
export const listEvents = asyncHandler(async (req, res) => {
  const q = req.query as Record<string, string | undefined>;
  const scope = machineScope(req.user as ScopedUser | undefined);

  const filter: Record<string, unknown> = {};
  if (scope) filter.machineId = { $in: scope };
  if (q.machineId) {
    // An explicit machine must still be inside the user's scope.
    if (scope && !scope.includes(q.machineId)) return ok(res, [], { total: 0, page: 1, limit: 0 });
    filter.machineId = q.machineId;
  }
  if (q.kind === 'state' || q.kind === 'production') filter.kind = q.kind;
  if (q.state && ['running', 'idle', 'stopped', 'offline'].includes(q.state)) filter.state = q.state;

  const from = parseDate(q.from);
  const to = parseDate(q.to);
  if ((q.from && !from) || (q.to && !to)) return fail(res, 400, 'Invalid from/to date');
  if (from || to) {
    const range: RangeFilter = {};
    if (from) range.$gte = from;
    if (to) range.$lte = to;
    filter.startedAt = range;
  }

  const page = Math.max(1, Number(q.page) || 1);
  const limit = Math.min(200, Math.max(1, Number(q.limit) || 50));

  const [rows, total] = await Promise.all([
    MachineEvent.find(filter).sort({ startedAt: -1 }).skip((page - 1) * limit).limit(limit)
      .maxTimeMS(15000).lean(),
    MachineEvent.countDocuments(filter).maxTimeMS(15000),
  ]);

  return ok(res, rows, { total, page, limit });
});

// GET /events/summary — §-style counters over a range (default: last 24h).
// Session durations are clipped to the range; open sessions count up to now/to.
export const eventsSummary = asyncHandler(async (req, res) => {
  const q = req.query as Record<string, string | undefined>;
  const scope = machineScope(req.user as ScopedUser | undefined);

  const to = parseDate(q.to) || new Date();
  const from = parseDate(q.from) || new Date(to.getTime() - 24 * 3600 * 1000);
  if (from >= to) return fail(res, 400, 'from must be before to');
  const endMs = Math.min(to.getTime(), Date.now());

  const machineFilter = q.machineId
    ? (scope && !scope.includes(q.machineId) ? { machineId: '__none__' } : { machineId: q.machineId })
    : (scope ? { machineId: { $in: scope } } : {});

  const [sessions, prodAgg] = await Promise.all([
    // Low volume by construction (transitions only) — clip precisely in JS.
    MachineEvent.find({
      ...machineFilter, kind: 'state',
      startedAt: { $lte: to },
      $or: [{ endedAt: null }, { endedAt: { $gte: from } }],
    }).select({ machineId: 1, state: 1, startedAt: 1, endedAt: 1 }).limit(5000).maxTimeMS(15000).lean(),
    MachineEvent.aggregate([
      { $match: { ...machineFilter, kind: 'production', startedAt: { $gte: from, $lte: to } } },
      { $group: { _id: null, events: { $sum: 1 }, pieces: { $sum: { $ifNull: ['$delta', 0] } } } },
    ]).option({ maxTimeMS: 15000 }),
  ]);

  const counts = { running: 0, idle: 0, stopped: 0, offline: 0 };
  const durations = { running: 0, idle: 0, stopped: 0, offline: 0 };
  for (const s of sessions) {
    const st = (s.state || 'offline') as keyof typeof counts;
    const start = Math.max(new Date(s.startedAt).getTime(), from.getTime());
    const end = Math.min(s.endedAt ? new Date(s.endedAt).getTime() : endMs, endMs);
    if (end <= start) continue;
    counts[st] += 1;
    durations[st] += end - start;
  }
  const prod = prodAgg[0] as { events: number; pieces: number } | undefined;

  return ok(res, {
    from: from.toISOString(), to: to.toISOString(),
    sessions: counts,
    durations: {
      runningMs: durations.running, idleMs: durations.idle,
      stoppedMs: durations.stopped, offlineMs: durations.offline,
    },
    production: { events: prod?.events || 0, pieces: prod?.pieces || 0 },
    totalEvents: sessions.length + (prod?.events || 0),
  });
});
