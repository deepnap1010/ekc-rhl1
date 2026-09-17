// server/src/controllers/downtime.controller.ts
import type { FilterQuery, PipelineStage } from 'mongoose';
import { DowntimeEvent } from '../models/DowntimeEvent.js';
import type { IDowntimeEvent } from '../models/DowntimeEvent.js';
import { Machine } from '../models/Machine.js';
import { MachineEvent } from '../models/MachineEvent.js';
import { AuditLog } from '../models/AuditLog.js';
import { ok, fail, asyncHandler } from '../utils/http.js';
import { machineScope } from '../utils/scope.js';
import { refIn, refCandidates } from '../utils/machineRef.js';
import { getDowntimeAskConfig, askedTypes, reasonsFor, shiftSwitchExpr } from '../utils/downtimeAsk.js';
import { loadShifts } from './config.controller.js';

type ScopeUser = { isSuperAdmin?: boolean; assignedMachines?: string[] } | undefined;
type Actor = { _id?: unknown; name?: string; isSuperAdmin?: boolean; assignedMachines?: string[] } | undefined;

const MAX_MS = 20000; // query-time ceiling so one slow scan can't hang a request
// Only return the columns the table actually renders — keeps payloads small at scale.
const LIST_FIELDS = 'machineId type startedAt endedAt durationMs reason reportedBy reasonSource reasonAt acknowledged acknowledgedBy acknowledgedAt';

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
  const { from, to, plant, machineId } = req.query as Record<string, string | undefined>;

  const matchStage: FilterQuery<IDowntimeEvent> = {};
  if (machineId && machineId !== 'all') matchStage.machineId = machineId;
  // Spans OVERLAPPING the window (not just started inside it) — an overnight
  // span that crosses midnight must still count toward today, and durations are
  // CLIPPED to the window below so totals match the dashboard's activity engine.
  const winTo = to ? new Date(to) : new Date();
  const winFrom = from ? new Date(from) : null;
  if (from || to) {
    matchStage.startedAt = { $lte: winTo };
    if (winFrom) matchStage.$or = [{ endedAt: null }, { endedAt: { $gte: winFrom } }];
  }
  // Window-clipped duration (open spans run to now).
  const clipExpr = {
    $max: [0, {
      $subtract: [
        { $min: [{ $ifNull: ['$endedAt', '$$NOW'] }, winTo] },
        winFrom ? { $max: ['$startedAt', winFrom] } : '$startedAt',
      ],
    }],
  };
  if (plant && plant !== 'all') {
    const codes = await Machine.find({ plant }).select('code').lean();
    matchStage.machineId = { $in: codes.map((m) => m.code) };
  }

  // Row-level scope: operators' KPIs only cover their assigned machines.
  const scope = machineScope(req.user as ScopeUser);
  if (scope) {
    if (typeof matchStage.machineId === 'string') {
      if (!scope.includes(matchStage.machineId)) {
        return ok(res, { totalEvents: 0, totalMs: 0, openEvents: 0, idleEvents: 0, stoppedEvents: 0, unacknowledged: 0, worstMachines: [], byType: [] });
      }
    } else if (matchStage.machineId && typeof matchStage.machineId === 'object') {
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
    { $addFields: { _clip: clipExpr } },
    {
      $facet: {
        totals: [{
          $group: {
            _id: null,
            totalEvents: { $sum: 1 },
            totalMs: { $sum: '$_clip' },
            openEvents: { $sum: { $cond: [{ $eq: ['$endedAt', null] }, 1, 0] } },
            idleEvents: { $sum: { $cond: [{ $eq: ['$type', 'idle'] }, 1, 0] } },
            stoppedEvents: { $sum: { $cond: [{ $eq: ['$type', 'stopped'] }, 1, 0] } },
            unacknowledged: { $sum: { $cond: [{ $ne: ['$acknowledged', true] }, 1, 0] } },
          },
        }],
        worstMachines: [
          { $group: { _id: '$machineId', events: { $sum: 1 }, totalMs: { $sum: '$_clip' } } },
          { $sort: { totalMs: -1 } },
          { $limit: 5 },
        ],
        // Real distribution of types present (e.g. idle / stopped / offline) — drives
        // the frontend's filter chips so no event state is ever silently excluded.
        byType: [
          { $group: { _id: '$type', events: { $sum: 1 }, totalMs: { $sum: '$_clip' } } },
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
  const { page = 1, limit = 20, from, to, type, status } = req.query as Record<string, string | undefined>;
  const q: FilterQuery<IDowntimeEvent> = { machineId: req.params.code };
  if (type && type !== 'all') q.type = type as IDowntimeEvent['type'];
  if (status === 'open') q.endedAt = null;
  else if (status === 'closed') q.endedAt = { $ne: null };
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

// ── downtime reasons ─────────────────────────────────────────────────────────
// A reason is written to the span in downtime_reports (the record) and echoed
// onto the machine_events state session the same sweep tick opened, so the
// History Log and the Downtime page say the same words. Two ways in: the
// operator popup (answerDowntime) and an edit on the Downtime page
// (updateReason). Both audited.

const MAX_REASON = 200;

/** The state session that mirrors this span. The sweep stamps both with one
 *  `now`, so the match is exact; ±60s covers a session the sweep opened a
 *  tick apart (boot re-seeding), the nearest one wins. */
async function mirrorReason(span: { machineId: string; type: string; startedAt: Date }, reason: string, by: string): Promise<void> {
  try {
    const at = new Date(span.startedAt).getTime();
    const near = await MachineEvent.find({
      machineId: span.machineId, kind: 'state', state: span.type,
      startedAt: { $gte: new Date(at - 60_000), $lte: new Date(at + 60_000) },
    }).select({ startedAt: 1 }).limit(3).lean();
    if (!near.length) return;
    const best = near.reduce((a, b) =>
      Math.abs(new Date(b.startedAt).getTime() - at) < Math.abs(new Date(a.startedAt).getTime() - at) ? b : a);
    await MachineEvent.updateOne({ _id: best._id }, { $set: { reason: reason || null, reasonBy: reason ? by : null } });
  } catch { /* the span is the record; a missed echo is a display gap, not data loss */ }
}

const audit = (user: Actor, action: string, span: { _id: unknown; machineId: string; type: string }, before: unknown, after: unknown): void => {
  // Fire-and-forget — an audit row must never be the reason a write fails.
  AuditLog.create({
    at: new Date(), user: { id: String(user?._id || ''), name: user?.name || '' }, action,
    entity: { type: 'downtime_event', id: String(span._id), label: `${span.machineId} · ${span.type}` }, before, after,
  }).catch(() => {});
};

// PATCH /downtime/:id/reason — add, change or clear a reason from the
// Downtime page (downtime.update). Who wrote it is the signed-in user, not a
// name the client sends.
export const updateReason = asyncHandler(async (req, res) => {
  const user = req.user as Actor;
  const body = req.body as { reason?: unknown; reportedBy?: unknown };
  const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
  if (reason.length > MAX_REASON) return fail(res, 400, `Reason must be ${MAX_REASON} characters or fewer`);
  const by = user?.name || (typeof body.reportedBy === 'string' ? body.reportedBy.trim() : '');
  const now = new Date();
  // An operator edits only their own machines' spans — the same row scope
  // the list applies. Uniform 404, so nothing is learned about other rows.
  const scope = machineScope(user);
  // findOneAndUpdate (new:false) hands back the pre-image atomically for the audit.
  const prev = await DowntimeEvent.findOneAndUpdate(
    { _id: req.params.id, ...(scope ? { machineId: { $in: scope } } : {}) },
    {
      $set: reason
        ? { reason, reportedBy: by, reasonSource: 'edit', reasonAt: now }
        : { reason: '', reportedBy: '', reasonSource: '', reasonAt: null },
    },
  ).lean();
  if (!prev) return fail(res, 404, 'Downtime event not found');
  await mirrorReason(prev, reason, by);
  audit(user, 'downtime.reason', prev, { reason: prev.reason || '' }, { reason });
  const event = await DowntimeEvent.findById(prev._id).lean();
  return ok(res, event);
});

// How long after a span ENDS it is still worth asking about: the operator's
// screen may have been closed while the machine was down; when it comes back
// the ask is still fresh. Older unanswered spans stay on the Downtime page
// with "Add reason".
const QUEUE_RECENT_MS = 2 * 3600_000;

// GET /production/downtime-queue — spans on MY machines that have lasted
// long enough to ask about and nobody has answered: still open and past the
// ask-after mark, or closed recently after lasting at least that long.
// Operators only — an admin browsing the dashboard is not popped for the fleet.
export const downtimeQueue = asyncHandler(async (req, res) => {
  const cfg = await getDowntimeAskConfig();
  const types = askedTypes(cfg);
  if (!cfg.enabled || !types.length) return ok(res, []);
  const user = req.user as ScopeUser;
  const mine = user?.assignedMachines || [];
  if (!mine.length) return ok(res, []);
  const now = Date.now();
  const minMs = cfg.askAfterMin * 60_000;
  const rows = await DowntimeEvent.find({
    machineId: { $in: [...new Set(mine.flatMap(refCandidates))] },
    type: { $in: types },
    reason: { $in: ['', null] },
    askedAt: null,
    $or: [
      { endedAt: null, startedAt: { $lte: new Date(now - minMs) } },
      { endedAt: { $ne: null, $gte: new Date(now - QUEUE_RECENT_MS) }, durationMs: { $gte: minMs } },
    ],
  }).select(LIST_FIELDS).sort({ startedAt: 1 }).limit(10).maxTimeMS(MAX_MS).lean();
  return ok(res, rows);
});

// POST /production/downtime/:id/reason — the popup's answer, or its timeout.
// Body: { reason } for a choice (a button, or typed when the admin allows it),
// { timeout: true } when a countdown ran out. Atomic filtered writes, so two
// screens for one machine can never both win: an answer lands only while the
// span has no reason; a timeout only marks "asked" and leaves the reason empty.
export const answerDowntime = asyncHandler(async (req, res) => {
  const user = req.user as Actor;
  const body = req.body as { reason?: unknown; timeout?: unknown };
  const span = await DowntimeEvent.findById(req.params.id).lean();
  // Uniform 404: an out-of-scope caller learns nothing about other machines.
  if (!span || (!user?.isSuperAdmin && !refIn(user?.assignedMachines, span.machineId))) {
    return fail(res, 404, 'Downtime event not found');
  }
  const now = new Date();
  if (body.timeout) {
    const r = await DowntimeEvent.updateOne({ _id: span._id, reason: { $in: ['', null] }, askedAt: null }, { $set: { askedAt: now } });
    return ok(res, { handled: r.modifiedCount > 0 });
  }
  const cfg = await getDowntimeAskConfig();
  const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
  if (!reason) return fail(res, 400, 'A reason is required');
  if (reason.length > MAX_REASON) return fail(res, 400, `Reason must be ${MAX_REASON} characters or fewer`);
  const listed = reasonsFor(cfg, span.type).some((l) => l.toLowerCase() === reason.toLowerCase());
  if (!listed && !cfg.allowCustom) return fail(res, 400, 'Pick one of the listed reasons');
  const by = user?.name || '';
  const r = await DowntimeEvent.updateOne(
    { _id: span._id, reason: { $in: ['', null] } },
    { $set: { reason, reportedBy: by, reasonSource: 'popup', reasonAt: now, askedAt: now } },
  );
  // matchedCount 0 = someone else already answered — their word stands.
  if (r.matchedCount > 0) {
    await mirrorReason(span, reason, by);
    audit(user, 'downtime.reason', span, { reason: '' }, { reason, source: 'popup' });
  }
  return ok(res, { handled: r.matchedCount > 0 });
});

// GET /downtime/reasons?from&to&machineId&plant&type&tz — where the downtime
// went, by reason: totals, per shift and per hour of the day. One
// index-backed pass with $facet, like /downtime/summary; durations are
// clipped to the window and spans without a reason are a bucket of their
// own (the unexplained share is the number a supervisor wants first).
// `tz` = minutes east of UTC on the plant clock (the client's), so a span
// that started at 14:58 IST lands in Shift A / hour 14, not UTC's 09.
export const downtimeReasons = asyncHandler(async (req, res) => {
  const { from, to, plant, machineId, type, tz } = req.query as Record<string, string | undefined>;
  const match: FilterQuery<IDowntimeEvent> = {};
  if (machineId && machineId !== 'all') match.machineId = machineId;
  if (type && type !== 'all') match.type = type as IDowntimeEvent['type'];
  const winTo = to ? new Date(to) : new Date();
  const winFrom = from ? new Date(from) : null;
  if (from || to) {
    match.startedAt = { $lte: winTo };
    if (winFrom) match.$or = [{ endedAt: null }, { endedAt: { $gte: winFrom } }];
  }
  if (plant && plant !== 'all') {
    const codes = await Machine.find({ plant }).select('code').lean();
    match.machineId = { $in: codes.map((m) => m.code) };
  }
  const scope = machineScope(req.user as ScopeUser);
  const empty = { totalMs: 0, byReason: [], byShift: [], byHour: [], shifts: [] };
  if (scope) {
    if (typeof match.machineId === 'string') {
      if (!scope.includes(match.machineId)) return ok(res, empty);
    } else if (match.machineId && typeof match.machineId === 'object') {
      const requested = (match.machineId as { $in?: string[] }).$in || [];
      match.machineId = { $in: requested.filter((c) => scope.includes(c)) };
    } else {
      match.machineId = { $in: scope };
    }
  }

  const clip = {
    $max: [0, {
      $subtract: [
        { $min: [{ $ifNull: ['$endedAt', '$$NOW'] }, winTo] },
        winFrom ? { $max: ['$startedAt', winFrom] } : '$startedAt',
      ],
    }],
  };
  const offsetMs = Math.max(-840, Math.min(840, Math.round(Number(tz) || 0))) * 60_000;
  const DAY = 86_400_000;
  // ms since local midnight of the span's start — $mod of a positive number.
  const sinceMidnight = { $mod: [{ $add: [{ $toLong: '$startedAt' }, offsetMs, DAY] }, DAY] };
  const shifts = await loadShifts();
  const reasonKey = { $ifNull: ['$reason', ''] };
  const rollup = (key: Record<string, unknown>): PipelineStage.FacetPipelineStage[] => [
    { $group: { _id: { reason: reasonKey, ...key }, events: { $sum: 1 }, totalMs: { $sum: '$_clip' } } },
    { $sort: { totalMs: -1 } },
  ];
  const [agg] = await DowntimeEvent.aggregate([
    { $match: match as PipelineStage.Match['$match'] },
    { $addFields: { _clip: clip, _min: { $floor: { $divide: [sinceMidnight, 60_000] } } } },
    { $addFields: { _shift: shiftSwitchExpr(shifts, '$_min'), _hour: { $floor: { $divide: ['$_min', 60] } } } },
    {
      $facet: {
        total: [{ $group: { _id: null, totalMs: { $sum: '$_clip' } } }],
        byReason: rollup({}),
        byShift: rollup({ shift: '$_shift' }),
        byHour: rollup({ hour: '$_hour' }),
      },
    },
  ]).option({ allowDiskUse: true, maxTimeMS: MAX_MS });
  type Row = { _id: { reason: string; shift?: string; hour?: number }; events: number; totalMs: number };
  const flat = (rows: Row[]) => rows.map((r) => ({ ...r._id, events: r.events, totalMs: r.totalMs }));
  return ok(res, {
    totalMs: agg?.total?.[0]?.totalMs || 0,
    byReason: flat(agg?.byReason || []),
    byShift: flat(agg?.byShift || []),
    byHour: flat(agg?.byHour || []),
    shifts: shifts.map((s) => s.name),
  });
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
