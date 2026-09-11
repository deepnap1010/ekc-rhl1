// server/src/controllers/events.controller.ts
// Read API over the operational event log (machine_events), plus the ONE kind
// of write this collection accepts: classifying a production event (operator
// popup or a later history correction). The counter path stays untouchable —
// events are still created solely by the sweep (services/event.service); the
// classification endpoints only ever relabel a row that already exists.
import { MachineEvent } from '../models/MachineEvent.js';
import { AuditLog } from '../models/AuditLog.js';
import { ok, fail, asyncHandler } from '../utils/http.js';
import { machineScope } from '../utils/scope.js';
import { refMatch, refIn } from '../utils/machineRef.js';
import { userCan } from '../middleware/auth.js';
import type { AuthUser } from '../types/auth.js';
import { getProdClassConfig, invalidateProductionReads, CLASS_VALUES, type ClassValue } from '../utils/prodclass.js';

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

    // A state SESSION that began BEFORE this window and ran into it happened
    // during the window. /events/summary counts it that way; this list used
    // "started inside" and so the tiles and the table contradicted each other on
    // one screen — 45 sessions counted above an empty table for a day whose
    // machines had gone silent mid-session.
    // Production events are point-in-time, so for those "started inside" IS the
    // right question.
    const sessionInWindow: Record<string, unknown> = { kind: 'state' };
    if (to) sessionInWindow.startedAt = { $lte: to };
    if (from) sessionInWindow.$or = [{ endedAt: null }, { endedAt: { $gte: from } }];
    const pointInWindow = { kind: 'production', startedAt: range };

    if (filter.kind === 'state') Object.assign(filter, sessionInWindow);
    else if (filter.kind === 'production') filter.startedAt = range;
    else filter.$or = [sessionInWindow, pointInWindow];
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


// ── production-event classification ─────────────────────────────────────────

// How far back the popup reaches. Old rows keep their default classification —
// they are already classified; the queue is only "recent enough to still ask".
const QUEUE_WINDOW_MS = 2 * 3600_000;

const audit = (
  user: { _id?: unknown; name?: string } | undefined,
  action: string, entity: { type: string; id?: string; label?: string },
  before?: unknown, after?: unknown,
): void => {
  // Fire-and-forget — an audit row must never be the reason a change fails.
  AuditLog.create({ at: new Date(), user: { id: String(user?._id || ''), name: user?.name || '' }, action, entity, before, after })
    .catch(() => {});
};

// GET /production/class-queue — recent production events on MY machines whose
// classification is still the untouched default. Operators only: an admin
// browsing the dashboard must not be popped for the whole fleet.
export const classQueue = asyncHandler(async (req, res) => {
  const cfg = await getProdClassConfig();
  if (!cfg.enabled) return ok(res, []);
  const user = req.user as ScopedUser | undefined;
  const mine = user?.assignedMachines || [];
  if (!mine.length) return ok(res, []);
  const rows = await MachineEvent.find({
    kind: 'production', classSource: 'default', delta: { $gt: 0 },
    machineId: { $in: mine.map(refMatch) },
    startedAt: { $gte: new Date(Date.now() - QUEUE_WINDOW_MS) },
  }).sort({ startedAt: 1 }).limit(25).lean();
  return ok(res, rows);
});

// POST /production/events/:id/classify — the popup's answer, or its timeout.
// Body: { value } for a button press, { timeout: true } when the countdown ran
// out. Both are atomic filtered updates, so two devices can never both win:
//   · a button press lands only while the row is 'default' or 'timeout' —
//     it can refine an unanswered row, never overwrite another person's answer;
//   · a timeout lands only while the row is still 'default' (the value stays
//     the default — the write just marks "asked, no answer" so it leaves the queue).
export const classifyEvent = asyncHandler(async (req, res) => {
  const user = req.user as (ScopedUser & { _id?: unknown; name?: string }) | undefined;
  const body = req.body as { value?: unknown; timeout?: unknown };
  const ev = await MachineEvent.findById(req.params.id).lean();
  if (!ev || ev.kind !== 'production') return fail(res, 404, 'Production event not found');
  // Popup answers come only from the machine's OWN operator (superadmin
  // excepted). "Unscoped sees everything" is a READ rule — letting every
  // view-level account classify fleet-wide would let a dashboard viewer
  // pre-empt the real operator, unaudited. Everyone else corrects through
  // the audited PATCH /events/:id/classification. Uniform 404, not 403 —
  // an out-of-scope caller learns nothing about other machines' events.
  if (!user?.isSuperAdmin && !refIn(user?.assignedMachines, ev.machineId)) {
    return fail(res, 404, 'Production event not found');
  }

  if (body.timeout) {
    const r = await MachineEvent.updateOne(
      { _id: ev._id, classSource: 'default' },
      { $set: { classSource: 'timeout', classifiedAt: new Date() } },
    );
    return ok(res, { handled: r.modifiedCount > 0 });
  }

  const cfg = await getProdClassConfig();
  const value = body.value as ClassValue;
  const opt = cfg.options.find((o) => o.value === value);
  if (!opt || !opt.enabled) return fail(res, 400, 'Not an enabled classification option');
  const r = await MachineEvent.updateOne(
    { _id: ev._id, classSource: { $in: ['default', 'timeout'] } },
    { $set: {
      classification: value, classSource: 'operator',
      classifiedBy: { id: String(user?._id || ''), name: user?.name || '' },
      classifiedAt: new Date(),
    } },
  );
  // modifiedCount 0 = someone else already answered — their word stands.
  // A popup answer of dry-cycle / sample takes the piece out of the count.
  if (r.modifiedCount > 0) invalidateProductionReads();
  return ok(res, { handled: r.modifiedCount > 0 });
});

// PATCH /events/:id/classification — correct a past classification, with a
// REASON. Who may: anyone holding history.update (supervisors, admins), or the
// machine's own operator (a production viewer whose assignedMachines holds
// it) — the same person the popup trusted. Audited with the reason, and
// allowed to use a currently DISABLED option: disabling only removes a button
// from future popups, it does not make old truths unsayable.
export const editClassification = asyncHandler(async (req, res) => {
  const user = req.user as (ScopedUser & { _id?: unknown; name?: string }) | undefined;
  const body = req.body as { value?: unknown; reason?: unknown };
  const value = body.value as ClassValue;
  if (!CLASS_VALUES.includes(value)) return fail(res, 400, 'Unknown classification');
  const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
  if (!reason) return fail(res, 400, 'A reason is required to change a past classification');
  if (reason.length > 200) return fail(res, 400, 'Reason must be 200 characters or fewer');
  const ev = await MachineEvent.findById(req.params.id).lean();
  if (!ev || ev.kind !== 'production') return fail(res, 404, 'Production event not found');
  const own = refIn(user?.assignedMachines, ev.machineId);
  const editor = userCan(user as AuthUser | undefined, 'history', 'update');
  const operator = own && userCan(user as AuthUser | undefined, 'production', 'view');
  if (!editor && !operator) return fail(res, 404, 'Production event not found');
  const scope = machineScope(user);
  if (scope && !refIn(scope, ev.machineId)) return fail(res, 404, 'Production event not found');
  if ((ev.meta as { reset?: boolean } | undefined)?.reset) return fail(res, 400, 'Counter resets are not classifiable');

  // findOneAndUpdate (default new:false) returns the pre-image atomically —
  // the audit's "before" cannot be staled by a popup answer landing between a
  // separate read and write, and a row deleted in between is a 404, not a
  // fabricated success.
  const prev = await MachineEvent.findOneAndUpdate(
    { _id: ev._id, kind: 'production' },
    { $set: {
      classification: value, classSource: 'edit', editReason: reason,
      classifiedBy: { id: String(user?._id || ''), name: user?.name || '' },
      classifiedAt: new Date(),
    } },
  ).lean();
  if (!prev) return fail(res, 404, 'Production event not found');
  // Every cached figure that summed this piece is stale the moment its class
  // moves — the list must not update while the cards hold the old number.
  invalidateProductionReads();
  // The counter change on the row is untouched by design — only its label
  // moves (and with it, whether the piece counts as production).
  audit(user, 'production.classify',
    { type: 'machine_event', id: String(ev._id), label: `${ev.machineId} · ${ev.prevValue} → ${ev.newValue}` },
    { classification: prev.classification ?? null, classSource: prev.classSource ?? null },
    { classification: value, reason });
  return ok(res, { handled: true });
});
