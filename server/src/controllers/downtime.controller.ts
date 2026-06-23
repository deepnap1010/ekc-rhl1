// server/src/controllers/downtime.controller.ts
import type { FilterQuery, PipelineStage } from 'mongoose';
import { DowntimeEvent } from '../models/DowntimeEvent.js';
import type { IDowntimeEvent } from '../models/DowntimeEvent.js';
import { Machine } from '../models/Machine.js';
import { ok, fail, asyncHandler } from '../utils/http.js';
import { machineScope } from '../utils/scope.js';

type ScopeUser = { isSuperAdmin?: boolean; assignedMachines?: string[] } | undefined;

const num = { $ifNull: ['$durationMs', 0] };
const MAX_MS = 20000; // query-time ceiling so one slow scan can't hang a request
// Only return the columns the table actually renders — keeps payloads small at scale.
const LIST_FIELDS = 'machineId type startedAt endedAt durationMs reason reportedBy acknowledged acknowledgedBy acknowledgedAt';

// GET /downtime — list events, paginated + filtered. Index-backed sort on startedAt.
export const listDowntime = asyncHandler(async (req, res) => {
  const { machineId, type, status, acknowledged, plant, from, to, page: pageQ, limit: limitQ } =
    req.query as Record<string, string | undefined>;
  const limit = Math.min(Math.max(Number(limitQ) || 25, 1), 100);
  const page = Math.max(Number(pageQ) || 1, 1);
  const q: FilterQuery<IDowntimeEvent> = {};

  if (machineId && machineId !== 'all') q.machineId = machineId;
  if (type && type !== 'all') q.type = type as IDowntimeEvent['type'];

  // filter by open/closed
  if (status === 'open') q.endedAt = null;
  else if (status === 'closed') q.endedAt = { $ne: null };

  // filter by acknowledgement (review queue)
  if (acknowledged === 'true') q.acknowledged = true;
  else if (acknowledged === 'false') q.acknowledged = { $ne: true };

  if (from || to) {
    const range: { $gte?: Date; $lte?: Date } = {};
    if (from) range.$gte = new Date(from);
    if (to) range.$lte = new Date(to);
    q.startedAt = range;
  }

  // filter by plant — telemetry/downtime reference machines by code
  if (plant && plant !== 'all') {
    const codes = await Machine.find({ plant }).select('code').lean();
    q.machineId = { $in: codes.map((m) => m.code) };
  }

  // Row-level scope: operators only see downtime for their assigned machines
  // (intersected with any machine/plant filter already applied).
  const scope = machineScope(req.user as ScopeUser);
  if (scope) {
    if (typeof q.machineId === 'string') {
      if (!scope.includes(q.machineId)) return ok(res, [], { total: 0, page, limit, pages: 0 });
    } else if (q.machineId && typeof q.machineId === 'object') {
      const requested = (q.machineId as { $in?: string[] }).$in || [];
      q.machineId = { $in: requested.filter((c) => scope.includes(c)) };
    } else {
      q.machineId = { $in: scope };
    }
  }

  const unfiltered = Object.keys(q).length === 0;
  const skip = (page - 1) * limit;
  const [items, total] = await Promise.all([
    DowntimeEvent.find(q).select(LIST_FIELDS).sort({ startedAt: -1 }).skip(skip).limit(limit).maxTimeMS(MAX_MS).lean(),
    // Unfiltered total comes from collection metadata — O(1) instead of a full scan.
    unfiltered ? DowntimeEvent.estimatedDocumentCount() : DowntimeEvent.countDocuments(q).maxTimeMS(MAX_MS),
  ]);

  return ok(res, items, { total, page, limit, pages: Math.max(1, Math.ceil(total / limit)) });
});

// GET /downtime/summary — aggregate KPIs for the downtime page cards
export const downtimeSummary = asyncHandler(async (req, res) => {
  const { from, to, plant } = req.query as Record<string, string | undefined>;

  const matchStage: FilterQuery<IDowntimeEvent> = {};
  if (from || to) {
    const range: { $gte?: Date; $lte?: Date } = {};
    if (from) range.$gte = new Date(from);
    if (to) range.$lte = new Date(to);
    matchStage.startedAt = range;
  }
  if (plant && plant !== 'all') {
    const codes = await Machine.find({ plant }).select('code').lean();
    matchStage.machineId = { $in: codes.map((m) => m.code) };
  }

  // Row-level scope: operators' KPIs only cover their assigned machines.
  const scope = machineScope(req.user as ScopeUser);
  if (scope) {
    if (matchStage.machineId && typeof matchStage.machineId === 'object') {
      const requested = (matchStage.machineId as { $in?: string[] }).$in || [];
      matchStage.machineId = { $in: requested.filter((c) => scope.includes(c)) };
    } else {
      matchStage.machineId = { $in: scope };
    }
  }

  // One index-backed pass over the matched window produces every KPI the page needs
  // ($facet fans out in-memory after a single scan, instead of three separate scans).
  const [agg] = await DowntimeEvent.aggregate([
    { $match: matchStage as PipelineStage.Match['$match'] },
    {
      $facet: {
        totals: [{
          $group: {
            _id: null,
            totalEvents: { $sum: 1 },
            totalMs: { $sum: num },
            openEvents: { $sum: { $cond: [{ $eq: ['$endedAt', null] }, 1, 0] } },
            idleEvents: { $sum: { $cond: [{ $eq: ['$type', 'idle'] }, 1, 0] } },
            stoppedEvents: { $sum: { $cond: [{ $eq: ['$type', 'stopped'] }, 1, 0] } },
            unacknowledged: { $sum: { $cond: [{ $ne: ['$acknowledged', true] }, 1, 0] } },
          },
        }],
        worstMachines: [
          { $group: { _id: '$machineId', events: { $sum: 1 }, totalMs: { $sum: num } } },
          { $sort: { totalMs: -1 } },
          { $limit: 5 },
        ],
        // Real distribution of types present (e.g. idle / stopped / offline) — drives
        // the frontend's filter chips so no event state is ever silently excluded.
        byType: [
          { $group: { _id: '$type', events: { $sum: 1 }, totalMs: { $sum: num } } },
          { $sort: { totalMs: -1 } },
        ],
      },
    },
  ]).option({ allowDiskUse: true, maxTimeMS: MAX_MS });

  const totals = agg?.totals?.[0] || { totalEvents: 0, totalMs: 0, openEvents: 0, idleEvents: 0, stoppedEvents: 0, unacknowledged: 0 };
  return ok(res, {
    ...totals,
    worstMachines: agg?.worstMachines || [],
    byType: (agg?.byType || []).map((b: { _id?: string; events: number; totalMs: number }) => ({ type: b._id || 'other', events: b.events, totalMs: b.totalMs })),
  });
});

// GET /machines/:code/downtime — downtime for a single machine
export const machineDowntime = asyncHandler(async (req, res) => {
  const scope = machineScope(req.user as ScopeUser);
  if (scope && !scope.includes(req.params.code)) return fail(res, 403, 'You are not assigned to this machine');
  const { page = 1, limit = 20, from, to } = req.query as Record<string, string | undefined>;
  const q: FilterQuery<IDowntimeEvent> = { machineId: req.params.code };
  if (from || to) {
    const range: { $gte?: Date; $lte?: Date } = {};
    if (from) range.$gte = new Date(from);
    if (to) range.$lte = new Date(to);
    q.startedAt = range;
  }
  const skip = (Number(page) - 1) * Number(limit);
  const [items, total] = await Promise.all([
    DowntimeEvent.find(q).sort({ startedAt: -1 }).skip(skip).limit(Number(limit)).lean(),
    DowntimeEvent.countDocuments(q),
  ]);
  return ok(res, items, { total, page: Number(page), limit: Number(limit) });
});

// PATCH /downtime/:id/reason — operator logs a reason
export const updateReason = asyncHandler(async (req, res) => {
  const { reason, reportedBy } = req.body as { reason?: string; reportedBy?: string };
  const event = await DowntimeEvent.findByIdAndUpdate(
    req.params.id,
    { $set: { reason: reason || '', reportedBy: reportedBy || '' } },
    { new: true }
  ).lean();
  if (!event) return fail(res, 404, 'Downtime event not found');
  return ok(res, event);
});

// PATCH /downtime/:id/ack — supervisor acknowledges (or un-acknowledges) an event.
export const acknowledgeDowntime = asyncHandler(async (req, res) => {
  const { acknowledged = true, acknowledgedBy } = req.body as { acknowledged?: boolean; acknowledgedBy?: string };
  const update = acknowledged
    ? { $set: { acknowledged: true, acknowledgedBy: acknowledgedBy || '', acknowledgedAt: new Date() } }
    : { $set: { acknowledged: false, acknowledgedBy: '', acknowledgedAt: null } };
  const event = await DowntimeEvent.findByIdAndUpdate(req.params.id, update, { new: true }).lean();
  if (!event) return fail(res, 404, 'Downtime event not found');
  return ok(res, event);
});
