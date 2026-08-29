// server/src/controllers/production.controller.ts
// DIA products, production stages, and machine assignments — the configuration
// side of production targets. Targets themselves are DERIVED (assigned seconds ÷
// processing seconds) wherever they are displayed; nothing here stores a target
// or an achievement, so nothing here can go stale.
import mongoose from 'mongoose';
import { DiaConfig, type IDiaStage } from '../models/DiaConfig.js';
import { MachineAssignment } from '../models/MachineAssignment.js';
import { AuditLog } from '../models/AuditLog.js';
import { ok, created, fail, asyncHandler } from '../utils/http.js';
import { machineScope } from '../utils/scope.js';
import { cached } from '../utils/cache.js';
import { computeTargets, rollupToDays, type TargetRow } from '../services/targets.service.js';
import { Telemetry } from '../models/Telemetry.js';
import { flattenData } from '../utils/flatten.js';
import { pickProductionKey } from '../utils/production.js';
import { stepEvents, PROD_STEP_PER_MIN } from '../services/activity.service.js';
import { Order } from '../models/Order.js';
import { ScheduledAssignment } from '../models/ScheduledAssignment.js';
import { applyDueSchedules } from '../services/schedule.service.js';
import { refMatch, refIn } from '../utils/machineRef.js';
import { OperatorSession } from '../models/OperatorSession.js';
import { AppConfig } from '../models/AppConfig.js';
import { User } from '../models/User.js';

interface ScopedUser { _id?: unknown; name?: string; isSuperAdmin?: boolean; assignedMachines?: string[] }

// Fire-and-forget: an audit row must never be the reason a change fails.
function audit(
  user: ScopedUser | undefined, action: string,
  entity: { type: string; id?: string; label?: string },
  before: Record<string, unknown> | null, after: Record<string, unknown> | null,
): void {
  AuditLog.create({
    at: new Date(),
    user: { id: user?._id ? String(user._id) : undefined, name: user?.name },
    action, entity, before, after,
  }).catch(() => {});
}

const slug = (s: string): string =>
  s.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

// Validate + normalise an incoming stages list. Existing stages keep the key the
// client sends back (renames don't change identity); new stages get a slug of
// their name. Returns a string error or the clean list.
function cleanStages(input: unknown): IDiaStage[] | string {
  if (!Array.isArray(input) || input.length < 1) return 'At least one stage is required';
  if (input.length > 50) return 'Too many stages';
  const out: IDiaStage[] = [];
  const keys = new Set<string>();
  for (let i = 0; i < input.length; i += 1) {
    const s = input[i] as { key?: string; name?: string; processingSec?: unknown; active?: unknown };
    const name = String(s?.name || '').trim();
    if (!name) return `Stage ${i + 1} needs a name`;
    const sec = Number(s?.processingSec);
    if (!Number.isInteger(sec) || sec < 1 || sec > 86_400) {
      return `"${name}": processing time must be 1 second to 24 hours per unit`;
    }
    const key = String(s?.key || '').trim() || slug(name);
    if (!key) return `"${name}": invalid stage name`;
    if (keys.has(key)) return `Duplicate stage "${name}"`;
    keys.add(key);
    out.push({ key, name, seq: i + 1, processingSec: sec, active: s?.active !== false });
  }
  return out;
}

// ── DIA configs ──────────────────────────────────────────────────────────────

// GET /production/dia — every config, with how many machines each is live on.
export const listDia = asyncHandler(async (_req, res) => {
  const [dias, open] = await Promise.all([
    DiaConfig.find().sort({ name: 1 }).lean(),
    MachineAssignment.aggregate([
      { $match: { effectiveTo: null } },
      { $group: { _id: '$diaId', n: { $sum: 1 } } },
    ]),
  ]);
  const usedBy = new Map(open.map((o) => [String(o._id), o.n as number]));
  return ok(res, dias.map((d) => ({ ...d, usedOn: usedBy.get(String(d._id)) || 0 })));
});

// POST /production/dia
export const createDia = asyncHandler(async (req, res) => {
  const { name, capacity, dims, stages } = req.body as Record<string, unknown>;
  if (!String(name || '').trim()) return fail(res, 400, 'Name is required');
  const clean = cleanStages(stages);
  if (typeof clean === 'string') return fail(res, 400, clean);
  const who = { id: String((req.user as ScopedUser)?._id || ''), name: (req.user as ScopedUser)?.name };
  try {
    const doc = await DiaConfig.create({
      name: String(name).trim(), capacity: String(capacity || '').trim(), dims: String(dims || '').trim(),
      stages: clean, createdBy: who, updatedBy: who,
    });
    audit(req.user as ScopedUser, 'dia.create', { type: 'dia', id: String(doc._id), label: doc.name }, null, { name: doc.name, stages: clean });
    return created(res, doc.toObject());
  } catch (e: unknown) {
    if ((e as { code?: number })?.code === 11000) return fail(res, 409, `A DIA named "${String(name).trim()}" already exists`);
    throw e;
  }
});

// PUT /production/dia/:id — edits the CONFIG only. Machines keep their frozen
// snapshots until re-assigned; the UI says so next to the save button.
export const updateDia = asyncHandler(async (req, res) => {
  const doc = await DiaConfig.findById(req.params.id);
  if (!doc) return fail(res, 404, 'DIA not found');
  const { name, capacity, dims, stages } = req.body as Record<string, unknown>;
  const before: Record<string, unknown> = {
    name: doc.name, capacity: doc.capacity, dims: doc.dims,
    stages: doc.stages.map((s) => ({ key: s.key, name: s.name, processingSec: s.processingSec, active: s.active })),
  };
  if (name !== undefined) {
    if (!String(name).trim()) return fail(res, 400, 'Name is required');
    doc.name = String(name).trim();
  }
  if (capacity !== undefined) doc.capacity = String(capacity || '').trim();
  if (dims !== undefined) doc.dims = String(dims || '').trim();
  if (stages !== undefined) {
    const clean = cleanStages(stages);
    if (typeof clean === 'string') return fail(res, 400, clean);
    doc.set('stages', clean);
  }
  doc.updatedBy = { id: String((req.user as ScopedUser)?._id || ''), name: (req.user as ScopedUser)?.name };
  try {
    await doc.save();
  } catch (e: unknown) {
    if ((e as { code?: number })?.code === 11000) return fail(res, 409, `A DIA named "${doc.name}" already exists`);
    throw e;
  }
  audit(req.user as ScopedUser, 'dia.update', { type: 'dia', id: String(doc._id), label: doc.name }, before, {
    name: doc.name, capacity: doc.capacity, dims: doc.dims,
    stages: doc.stages.map((s) => ({ key: s.key, name: s.name, processingSec: s.processingSec, active: s.active })),
  });
  return ok(res, doc.toObject());
});

// POST /production/dia/:id/active { active } — deactivate blocks NEW assignments;
// machines already running it run on (their snapshot is theirs).
export const setDiaActive = asyncHandler(async (req, res) => {
  const active = !!(req.body as { active?: unknown })?.active;
  // A retired dia can't be assigned, so any schedule pointing at it would fail
  // silently at its moment. Cancel them here, where someone is watching.
  if (!active) {
    const queued = await ScheduledAssignment.find({ diaId: req.params.id, status: 'pending' }).lean();
    if (queued.length) {
      await ScheduledAssignment.updateMany(
        { _id: { $in: queued.map((s) => s._id) } },
        { $set: { status: 'cancelled', reason: 'the dia was retired', cancelledBy: { id: String((req.user as ScopedUser)?._id || ''), name: (req.user as ScopedUser)?.name } } },
      );
      audit(req.user as ScopedUser, 'schedule.cancel',
        { type: 'schedule', label: `${queued.length} scheduled assignment${queued.length === 1 ? '' : 's'} cancelled — dia retired` },
        { schedules: queued.map((s) => `${s.machineRef} → ${s.diaName} @ ${s.applyAt.toISOString()}`) }, null);
    }
  }
  const doc = await DiaConfig.findByIdAndUpdate(
    req.params.id,
    { $set: { active, retiredAt: active ? null : new Date() } },
    { new: true },
  ).lean();
  if (!doc) return fail(res, 404, 'DIA not found');
  audit(req.user as ScopedUser, active ? 'dia.activate' : 'dia.deactivate',
    { type: 'dia', id: String(doc._id), label: doc.name }, { active: !active }, { active });
  return ok(res, doc);
});

// DELETE /production/dia/:id — permanent, and deliberately narrow: only a
// RETIRED dia, and only while no machine currently holds it. History does not
// need the record — every past assignment carries its own frozen snapshot — so
// deleting the catalogue entry rewrites nothing.
export const deleteDia = asyncHandler(async (req, res) => {
  const doc = await DiaConfig.findById(req.params.id);
  if (!doc) return fail(res, 404, 'DIA not found');
  if (doc.active) return fail(res, 400, 'Retire the dia first — delete is for retired records');
  const holding = await MachineAssignment.countDocuments({ diaId: doc._id, effectiveTo: null });
  if (holding > 0) return fail(res, 400, `${holding} machine${holding === 1 ? ' still holds' : 's still hold'} this dia — reassign them first`);
  const queued = await ScheduledAssignment.countDocuments({ diaId: doc._id, status: 'pending' });
  if (queued > 0) return fail(res, 400, `${queued} pending schedule${queued === 1 ? ' still points' : 's still point'} at this dia — cancel ${queued === 1 ? 'it' : 'them'} first`);
  await doc.deleteOne();
  audit(req.user as ScopedUser, 'dia.delete', { type: 'dia', id: String(doc._id), label: doc.name },
    { name: doc.name, stages: doc.stages.map((s) => ({ name: s.name, processingSec: s.processingSec })) }, null);
  return ok(res, { deleted: true });
});

// ── Assignments ──────────────────────────────────────────────────────────────

// POST /production/assignments { machineRef, diaId, stageKey, note }
// One operation: close the machine's open assignment, insert the new one with a
// frozen snapshot. Both the floor-side chip and the Configure tab call this.
export const assignMachine = asyncHandler(async (req, res) => {
  const { machineRef, diaId, stageKey, note } = req.body as Record<string, string | undefined>;
  const ref = String(machineRef || '').trim();
  if (!ref || !diaId || !stageKey) return fail(res, 400, 'machineRef, diaId and stageKey are required');
  const scope = machineScope(req.user as ScopedUser);
  if (scope && !scope.includes(ref)) return fail(res, 403, 'You are not assigned to this machine');
  if (!mongoose.isValidObjectId(diaId)) return fail(res, 400, 'Invalid DIA id');

  const dia = await DiaConfig.findById(diaId).lean();
  if (!dia) return fail(res, 404, 'DIA not found');
  if (!dia.active) return fail(res, 400, `"${dia.name}" is deactivated — reactivate it before assigning`);
  const stage = dia.stages.find((s) => s.key === stageKey);
  if (!stage) return fail(res, 404, 'Stage not found on this DIA');
  if (!stage.active) return fail(res, 400, `Stage "${stage.name}" is deactivated`);

  const now = new Date();
  // Read the one that mattered, then close EVERY open row for this machine: one
  // machine can only be making one thing, and a stray open row would double its
  // target in every report from here on.
  const prev = await MachineAssignment.findOne({ machineRef: refMatch(ref), effectiveTo: null })
    .sort({ effectiveFrom: -1 }).lean();
  await MachineAssignment.updateMany(
    { machineRef: refMatch(ref), effectiveTo: null },
    { $set: { effectiveTo: now } },
  );

  const who = { id: String((req.user as ScopedUser)?._id || ''), name: (req.user as ScopedUser)?.name };
  const doc = await MachineAssignment.create({
    machineRef: ref, diaId: dia._id, stageKey: stage.key,
    snapshot: {
      diaName: dia.name, capacity: dia.capacity, dims: dia.dims,
      stageName: stage.name, processingSec: stage.processingSec,
    },
    effectiveFrom: now, effectiveTo: null,
    assignedBy: who, note: String(note || ''),
  });
  audit(req.user as ScopedUser, 'assignment.create',
    { type: 'assignment', id: String(doc._id), label: `${ref} → ${dia.name} / ${stage.name}` },
    prev ? { diaName: prev.snapshot?.diaName, stageName: prev.snapshot?.stageName, processingSec: prev.snapshot?.processingSec } : null,
    { diaName: dia.name, stageName: stage.name, processingSec: stage.processingSec });
  return created(res, doc.toObject());
});

// DELETE /production/assignments/current/:machineRef — unassign.
export const unassignMachine = asyncHandler(async (req, res) => {
  const ref = String(req.params.machineRef || '').trim();
  const scope = machineScope(req.user as ScopedUser);
  if (scope && !scope.includes(ref)) return fail(res, 403, 'You are not assigned to this machine');
  const prev = await MachineAssignment.findOneAndUpdate(
    { machineRef: ref, effectiveTo: null },
    { $set: { effectiveTo: new Date() } },
  ).lean();
  if (!prev) return fail(res, 404, 'This machine has no active assignment');
  audit(req.user as ScopedUser, 'assignment.end',
    { type: 'assignment', id: String(prev._id), label: `${ref} — ${prev.snapshot?.diaName} / ${prev.snapshot?.stageName}` },
    { diaName: prev.snapshot?.diaName, stageName: prev.snapshot?.stageName }, null);
  return ok(res, { ended: true });
});

// GET /production/assignments/current — one row per machine that has one.
export const currentAssignments = asyncHandler(async (req, res) => {
  const scope = machineScope(req.user as ScopedUser);
  const q: Record<string, unknown> = { effectiveTo: null };
  if (scope) q.machineRef = { $in: scope };
  const rows = await MachineAssignment.find(q).sort({ machineRef: 1 }).lean();
  return ok(res, rows);
});

// GET /production/assignments?machineRef= — history, newest first.
export const listAssignments = asyncHandler(async (req, res) => {
  const { machineRef, limit = '50' } = req.query as Record<string, string | undefined>;
  const scope = machineScope(req.user as ScopedUser);
  const q: Record<string, unknown> = {};
  if (machineRef) {
    if (scope && !scope.includes(machineRef)) return ok(res, []);
    q.machineRef = machineRef;
  } else if (scope) {
    q.machineRef = { $in: scope };
  }
  const rows = await MachineAssignment.find(q)
    .sort({ effectiveFrom: -1 }).limit(Math.min(Number(limit) || 50, 200)).lean();
  return ok(res, rows);
});

// ── Scheduled assignments ────────────────────────────────────────────────────

// GET /production/schedule?machineRef=&unacked=1
// unacked=1 is the operator popup's view: their machines' pending schedules,
// plus ones applied in the last 3 days, minus anything THEY already dismissed.
// The plain list is the supervisor queue: all pending, plus the last 48h of
// applied/failed so outcomes stay visible.
export const listSchedules = asyncHandler(async (req, res) => {
  await applyDueSchedules().catch(() => {});   // whoever looks sees the truth
  const q = req.query as Record<string, unknown>;
  const user = req.user as ScopedUser;
  const scope = machineScope(user);
  const f: Record<string, unknown> = {};
  const ref = typeof q.machineRef === 'string' ? q.machineRef.trim() : '';
  const unacked = q.unacked === '1';

  if (unacked) {
    // The operator notice is about MY machines — not about what I'm allowed to
    // see. A super admin who also runs three machines gets those three, not the
    // whole plant; someone with no machines gets nothing.
    const mine = (user?.assignedMachines || []).filter(Boolean);
    if (!mine.length) return ok(res, []);
    f.machineRef = { $in: mine.map(refMatch) };
    f.$or = [
      { status: 'pending' },
      { status: { $in: ['applied', 'failed'] }, updatedAt: { $gte: new Date(Date.now() - 3 * 24 * 3_600_000) } },
    ];
    f['acks.userId'] = { $ne: String(user?._id || '') };
  } else {
    if (ref) {
      if (!refIn(scope, ref) && scope) return ok(res, []);
      f.machineRef = refMatch(ref);
    } else if (scope) f.machineRef = { $in: scope.map(refMatch) };
    f.$or = [
      { status: 'pending' },
      { status: { $in: ['applied', 'failed'] }, updatedAt: { $gte: new Date(Date.now() - 48 * 3_600_000) } },
    ];
  }
  const rows = await ScheduledAssignment.find(f).sort({ applyAt: 1 }).limit(200).lean();
  return ok(res, rows);
});

// POST /production/schedule { machineRef, diaId, stageKey, applyAt, note }
// Validation mirrors assignMachine; the snapshot is NOT frozen here — it
// freezes at apply time, exactly as if someone clicked Assign at that moment.
export const createSchedule = asyncHandler(async (req, res) => {
  const { machineRef, diaId, stageKey, applyAt, note } = req.body as Record<string, string | undefined>;
  const ref = String(machineRef || '').trim();
  if (!ref || !diaId || !stageKey || !applyAt) return fail(res, 400, 'machineRef, diaId, stageKey and applyAt are required');
  if (ref.length > 60) return fail(res, 400, 'machineRef is too long');
  if (String(note || '').length > 500) return fail(res, 400, 'Note is too long (500 characters max)');
  const scope = machineScope(req.user as ScopedUser);
  if (scope && !refIn(scope, ref)) return fail(res, 403, 'You are not assigned to this machine');
  if (!mongoose.isValidObjectId(diaId)) return fail(res, 400, 'Invalid DIA id');
  const at = new Date(applyAt);
  if (Number.isNaN(at.getTime())) return fail(res, 400, 'applyAt must be a valid date');
  if (at.getTime() < Date.now() - 60_000) return fail(res, 400, 'That moment has passed — assign directly instead');
  if (at.getTime() > Date.now() + 90 * 24 * 3_600_000) return fail(res, 400, 'applyAt is more than 90 days out');

  const dia = await DiaConfig.findById(diaId).lean();
  if (!dia) return fail(res, 404, 'DIA not found');
  if (!dia.active) return fail(res, 400, `"${dia.name}" is deactivated — reactivate it before scheduling`);
  const stage = dia.stages.find((s) => s.key === stageKey);
  if (!stage) return fail(res, 404, 'Stage not found on this DIA');
  if (!stage.active) return fail(res, 400, `Stage "${stage.name}" is deactivated`);

  const who = { id: String((req.user as ScopedUser)?._id || ''), name: (req.user as ScopedUser)?.name };
  const doc = await ScheduledAssignment.create({
    machineRef: ref, diaId: dia._id, diaName: dia.name,
    stageKey: stage.key, stageName: stage.name,
    applyAt: at, status: 'pending', createdBy: who, note: String(note || ''),
  });
  audit(req.user as ScopedUser, 'schedule.create',
    { type: 'schedule', id: String(doc._id), label: `${ref} → ${dia.name} / ${stage.name} @ ${at.toISOString()}` },
    null, { diaName: dia.name, stageName: stage.name, applyAt: at.toISOString() });
  return created(res, doc.toObject());
});

// DELETE /production/schedule/:id — cancel while still pending.
export const cancelSchedule = asyncHandler(async (req, res) => {
  const found = await ScheduledAssignment.findById(req.params.id).lean();
  if (!found) return fail(res, 404, 'Schedule not found');
  const scope = machineScope(req.user as ScopedUser);
  if (scope && !refIn(scope, found.machineRef)) return fail(res, 403, 'You are not assigned to this machine');
  // Atomic: the apply path flips pending→applied from the ticker AND from every
  // list request. A read-then-save here could stamp "cancelled" over a switch
  // that already happened on the floor.
  const doc = await ScheduledAssignment.findOneAndUpdate(
    { _id: found._id, status: 'pending' },
    { $set: { status: 'cancelled', cancelledBy: { id: String((req.user as ScopedUser)?._id || ''), name: (req.user as ScopedUser)?.name } } },
    { new: true },
  ).lean();
  if (!doc) {
    const now = await ScheduledAssignment.findById(found._id).lean();
    return fail(res, 400, `Already ${now?.status || 'gone'} — only pending schedules can be cancelled`);
  }
  audit(req.user as ScopedUser, 'schedule.cancel',
    { type: 'schedule', id: String(doc._id), label: `${doc.machineRef} → ${doc.diaName} @ ${doc.applyAt.toISOString()}` },
    { diaName: doc.diaName, applyAt: doc.applyAt.toISOString() }, null);
  return ok(res, doc);
});

// POST /production/schedule/:id/ack — this reader marks the notice read. The
// popup filters on acks.userId, so each person dismisses for themselves only.
export const ackSchedule = asyncHandler(async (req, res) => {
  const doc = await ScheduledAssignment.findById(req.params.id).lean();
  if (!doc) return fail(res, 404, 'Schedule not found');
  const user = req.user as ScopedUser;
  const scope = machineScope(user);
  // An operator acks their own machines' notices; the unacked list is scoped to
  // assignedMachines, so accept that list too (a super admin has no scope).
  if (scope && !refIn(scope, doc.machineRef) && !refIn(user?.assignedMachines, doc.machineRef)) {
    return fail(res, 403, 'You are not assigned to this machine');
  }
  const uid = String((req.user as ScopedUser)?._id || '');
  await ScheduledAssignment.updateOne(
    { _id: doc._id, 'acks.userId': { $ne: uid } },
    { $push: { acks: { userId: uid, name: (req.user as ScopedUser)?.name, at: new Date() } } },
  );
  return ok(res, { acked: true });
});

// GET /production/targets?from&to&machineId&groupBy=hour|day&page&limit
// Target-vs-actual rows plus per-DIA and grand rollups. Targets and actuals are
// both DERIVED at read time (frozen snapshots ÷ assigned seconds; confirmed
// counter steps) — see services/targets.service. downtimeSec ships with every
// row so "subtract downtime from targets" can be a client-side VIEW, not a
// different report.
export const targetsReport = asyncHandler(async (req, res) => {
  const q = req.query as Record<string, string | undefined>;
  const fromD = q.from ? new Date(q.from) : null;
  const toRaw = q.to ? new Date(q.to) : new Date();
  if (!fromD || Number.isNaN(fromD.getTime()) || Number.isNaN(toRaw.getTime())) {
    return fail(res, 400, 'from (and optionally to) must be valid dates');
  }
  const toD = new Date(Math.min(toRaw.getTime(), Date.now()));
  if (toD <= fromD) return fail(res, 400, 'from must be before to');
  if (toD.getTime() - fromD.getTime() > 92 * 24 * 3_600_000) {
    return fail(res, 400, 'This report covers at most 92 days at a time');
  }

  const scope = machineScope(req.user as ScopedUser);
  const one = q.machineId?.trim();
  if (one && scope && !scope.includes(one)) return ok(res, [], { total: 0, page: 1, limit: 0 });
  const refs = one ? [one] : scope;

  const groupBy = q.groupBy === 'hour' ? 'hour' : 'day';
  const basis = q.basis === 'window' ? 'window' as const : 'assignment' as const;
  const lim = Math.min(Math.max(Number(q.limit) || 50, 1), 2000);
  const page = Math.max(Number(q.page) || 1, 1);

  const key = `targets:${basis}:${fromD.toISOString()}:${toD.toISOString()}:${(refs || []).join(',') || '*'}`;
  const { rows: hourly, machines } = await cached(key, 60_000, () => computeTargets(fromD, toD, refs ?? null, basis));

  let rows = groupBy === 'day' ? rollupToDays(hourly) : hourly;
  // Everyone who appears in the window — feeds the report's operator filter.
  const operators = [...new Set(hourly.map((r) => r.operator).filter(Boolean))].sort() as string[];
  if (q.operator) rows = rows.filter((r) => r.operator === q.operator);
  rows.sort((a, b) => b.bucket.localeCompare(a.bucket) || a.machineRef.localeCompare(b.machineRef));

  // Rollups cover the WHOLE window, whatever page the table is on.
  const byDiaMap = new Map<string, { dia: string; dims: string; target: number; targetAdj: number; actual: number; downtimeSec: number; machines: Set<string> }>();
  const totals = { target: 0, targetAdj: 0, actual: 0, downtimeSec: 0 };
  for (const r of hourly) {
    totals.target += r.target; totals.targetAdj += r.targetAdj; totals.actual += r.actual; totals.downtimeSec += r.downtimeSec;
    const d = byDiaMap.get(r.dia) || { dia: r.dia, dims: r.dims, target: 0, targetAdj: 0, actual: 0, downtimeSec: 0, machines: new Set<string>() };
    d.target += r.target; d.targetAdj += r.targetAdj; d.actual += r.actual; d.downtimeSec += r.downtimeSec; d.machines.add(r.machineRef);
    byDiaMap.set(r.dia, d);
  }
  const byDia = [...byDiaMap.values()]
    .map((d) => ({ dia: d.dia, dims: d.dims, target: d.target, targetAdj: d.targetAdj, actual: d.actual, downtimeSec: d.downtimeSec, machines: d.machines.size }))
    .sort((a, b) => b.actual - a.actual || a.dia.localeCompare(b.dia));

  const skip = (page - 1) * lim;
  return ok(res, rows.slice(skip, skip + lim) as TargetRow[], {
    total: rows.length, page, limit: lim, groupBy,
    from: fromD.toISOString(), to: toD.toISOString(),
    machines: machines.length, byDia, totals, operators,
  });
});

// ── Break schedule ───────────────────────────────────────────────────────────

// PUT /production/breaks { breaks: [{name, start, end}] } — the plant's daily
// planned pauses. Targets exclude them (see targets.service), so lunch never
// reads as "behind target". Lives in app_config; gated by production.update
// because it changes what every target means.
const TIME_RE = /^\d{2}:\d{2}$/;
export const setBreaks = asyncHandler(async (req, res) => {
  const breaks = (req.body as { breaks?: unknown })?.breaks;
  if (!Array.isArray(breaks) || breaks.length > 10) return fail(res, 400, 'breaks must be a list of at most 10 entries');
  for (const b of breaks as { name?: string; start?: string; end?: string }[]) {
    if (!b?.name?.trim() || !TIME_RE.test(b.start || '') || !TIME_RE.test(b.end || '')) {
      return fail(res, 400, 'each break needs a name and HH:MM start/end');
    }
  }
  const clean = (breaks as { name: string; start: string; end: string }[])
    .map((b) => ({ name: b.name.trim(), start: b.start, end: b.end }));
  const beforeDoc = await AppConfig.findOne({ key: 'global' }).select({ breaks: 1 }).lean();
  const doc = await AppConfig.findOneAndUpdate(
    { key: 'global' }, { $set: { breaks: clean } }, { new: true, upsert: true },
  ).lean();
  audit(req.user as ScopedUser, 'breaks.update', { type: 'config', label: 'Break schedule' },
    { breaks: beforeDoc?.breaks || [] }, { breaks: clean });
  return ok(res, { breaks: doc.breaks });
});

// ── Orders ───────────────────────────────────────────────────────────────────

// Progress is DERIVED: pieces counted on machines running the order's DIA since
// the order opened. Capped at 92 days of lookback (same as the report).
async function orderProgress(o: { _id: unknown; diaName: string; startedAt: Date; closedAt: Date | null }): Promise<number> {
  const from = new Date(o.startedAt);
  const to = new Date(Math.min(o.closedAt ? new Date(o.closedAt).getTime() : Date.now(), from.getTime() + 92 * 24 * 3_600_000, Date.now()));
  if (to <= from) return 0;
  return cached(`orderprog:${String(o._id)}:${to.getTime() > Date.now() - 120_000 ? 'live' : to.toISOString()}`, 60_000, async () => {
    const { rows } = await computeTargets(from, to, null);
    return rows.filter((r) => r.dia === o.diaName).reduce((n, r) => n + r.actual, 0);
  });
}

// GET /production/orders — newest first, with derived progress.
export const listOrders = asyncHandler(async (_req, res) => {
  const orders = await Order.find().sort({ status: 1, createdAt: -1 }).limit(100).lean();
  const out = [];
  for (const o of orders) {
    out.push({ ...o, produced: await orderProgress(o) });
  }
  return ok(res, out);
});

// POST /production/orders { orderNo, diaId, quantity, notes }
export const createOrder = asyncHandler(async (req, res) => {
  const { orderNo, diaId, quantity, notes } = req.body as Record<string, unknown>;
  const no = String(orderNo || '').trim();
  const qty = Number(quantity);
  if (!no) return fail(res, 400, 'Order number is required');
  if (!Number.isInteger(qty) || qty < 1 || qty > 1_000_000) return fail(res, 400, 'Quantity must be a whole number of pieces');
  if (!mongoose.isValidObjectId(String(diaId || ''))) return fail(res, 400, 'Pick a DIA');
  const dia = await DiaConfig.findById(String(diaId)).lean();
  if (!dia) return fail(res, 404, 'DIA not found');
  const who = { id: String((req.user as ScopedUser)?._id || ''), name: (req.user as ScopedUser)?.name };
  try {
    const doc = await Order.create({
      orderNo: no, diaId: dia._id, diaName: dia.name, quantity: qty,
      notes: String(notes || ''), startedAt: new Date(), createdBy: who,
    });
    audit(req.user as ScopedUser, 'order.create', { type: 'order', id: String(doc._id), label: `${no} — ${dia.name} × ${qty}` }, null, { orderNo: no, dia: dia.name, quantity: qty });
    return created(res, { ...doc.toObject(), produced: 0 });
  } catch (e: unknown) {
    if ((e as { code?: number })?.code === 11000) return fail(res, 409, `Order "${no}" already exists`);
    throw e;
  }
});

// PATCH /production/orders/:id { status } — done / cancelled / reopen.
export const updateOrder = asyncHandler(async (req, res) => {
  const { status } = req.body as { status?: string };
  if (!['open', 'done', 'cancelled'].includes(String(status))) return fail(res, 400, 'status must be open, done or cancelled');
  const doc = await Order.findById(req.params.id);
  if (!doc) return fail(res, 404, 'Order not found');
  const before = doc.status;
  doc.status = status as 'open' | 'done' | 'cancelled';
  doc.closedAt = status === 'open' ? null : new Date();
  await doc.save();
  audit(req.user as ScopedUser, 'order.status', { type: 'order', id: String(doc._id), label: doc.orderNo },
    { status: before }, { status });
  return ok(res, { ...doc.toObject(), produced: await orderProgress(doc) });
});

// ── Operator sessions ────────────────────────────────────────────────────────

// GET /production/operators/current — who is on which machine right now.
export const currentOperators = asyncHandler(async (req, res) => {
  const scope = machineScope(req.user as ScopedUser);
  const q: Record<string, unknown> = { endedAt: null };
  if (scope) q.machineRef = { $in: scope };
  return ok(res, await OperatorSession.find(q).sort({ machineRef: 1 }).lean());
});

// POST /production/operators { machineRef, userId } — handover: closes the
// machine's open session, starts the new one. The report splits its rows at
// this instant, so each person answers for their own pieces.
export const setOperator = asyncHandler(async (req, res) => {
  const { machineRef, userId } = req.body as Record<string, string | undefined>;
  const ref = String(machineRef || '').trim();
  if (!ref || !userId) return fail(res, 400, 'machineRef and userId are required');
  const scope = machineScope(req.user as ScopedUser);
  if (scope && !scope.includes(ref)) return fail(res, 403, 'You are not assigned to this machine');
  const user = await User.findById(userId).select({ name: 1 }).lean();
  if (!user) return fail(res, 404, 'Employee not found');
  const now = new Date();
  const prev = await OperatorSession.findOneAndUpdate(
    { machineRef: ref, endedAt: null }, { $set: { endedAt: now } },
  ).lean();
  const who = { id: String((req.user as ScopedUser)?._id || ''), name: (req.user as ScopedUser)?.name };
  const doc = await OperatorSession.create({
    machineRef: ref, userId: String(userId), userName: user.name || 'Unknown',
    startedAt: now, endedAt: null, startedBy: who,
  });
  audit(req.user as ScopedUser, 'operator.start', { type: 'operator', id: String(doc._id), label: `${ref} → ${user.name}` },
    prev ? { operator: prev.userName } : null, { operator: user.name });
  return created(res, doc.toObject());
});

// DELETE /production/operators/current/:machineRef — nobody on the machine.
export const endOperator = asyncHandler(async (req, res) => {
  const ref = String(req.params.machineRef || '').trim();
  const scope = machineScope(req.user as ScopedUser);
  if (scope && !scope.includes(ref)) return fail(res, 403, 'You are not assigned to this machine');
  const prev = await OperatorSession.findOneAndUpdate(
    { machineRef: ref, endedAt: null }, { $set: { endedAt: new Date() } },
  ).lean();
  if (!prev) return fail(res, 404, 'No operator is signed on to this machine');
  audit(req.user as ScopedUser, 'operator.end', { type: 'operator', id: String(prev._id), label: `${ref} — ${prev.userName}` },
    { operator: prev.userName }, null);
  return ok(res, { ended: true });
});

// GET /production/trace?machineRef=&dia= — the dia-wise story: every
// assignment ever made, each carrying the pieces COUNTED while it was live.
// "Which machines ran dia X, since when, and what did each one produce under
// it — and what changed after the dia changed" answers itself from these rows.
// Actuals ride the same confirmed-counter-step engine as every other figure
// (per-bin max, physics-capped), summed inside each assignment's own span.
export const traceDias = asyncHandler(async (req, res) => {
  const q = req.query as Record<string, string | undefined>;
  const scope = machineScope(req.user as ScopedUser);
  const ref = q.machineRef?.trim();
  if (ref && scope && !scope.includes(ref)) return ok(res, []);

  const filter: Record<string, unknown> = {};
  if (ref) filter.machineRef = ref;
  else if (scope) filter.machineRef = { $in: scope };
  if (q.dia) filter['snapshot.diaName'] = q.dia.trim();

  // Optional window: pieces are then counted INSIDE it (clipped to each
  // assignment's own span), and runs that never touch it drop out — "what did
  // this dia do yesterday / on shift B / on the 26th" without a new endpoint.
  const winFrom = q.from ? new Date(q.from) : null;
  const winTo = q.to ? new Date(q.to) : null;
  if ((winFrom && Number.isNaN(winFrom.getTime())) || (winTo && Number.isNaN(winTo.getTime()))) {
    return fail(res, 400, 'from/to must be valid dates');
  }

  const cacheKey = `diatrace:${ref || '*'}:${q.dia || '*'}:${winFrom?.toISOString() || '*'}:${winTo?.toISOString() || '*'}:${(scope || []).join(',') || '*'}`;
  const rows = await cached(cacheKey, 60_000, async () => {
    const asgs = await MachineAssignment.find(filter)
      .sort({ effectiveFrom: -1 }).limit(500).lean();
    if (!asgs.length) return [];
    const now = Date.now();
    // Counting is bounded to 92 days of telemetry (the report's own cap);
    // an older assignment still lists, flagged truncated.
    const capFrom = new Date(Math.max(
      now - 92 * 24 * 3_600_000,
      winFrom ? winFrom.getTime() : -Infinity,
      Math.min(...asgs.map((a) => +new Date(a.effectiveFrom))),
    ));
    const machines = [...new Set(asgs.map((a) => a.machineRef))];

    // Each machine's counter key, from its latest payload — the shared picker.
    const keyed: { ref: string; key: string }[] = [];
    for (const m of machines) {
      const last = await Telemetry.findOne({ machineId: m }).sort({ timestamp: -1 })
        .select({ data: 1 }).lean();
      const k = last?.data ? pickProductionKey(flattenData(last.data as Record<string, unknown>)) : null;
      if (k && !k.includes('.')) keyed.push({ ref: m, key: k });
    }

    // ONE aggregation for every machine: per-bin max counter, stepped in Node.
    const evBy = new Map<string, { t: number; made: number }[]>();
    if (keyed.length) {
      const binMinutes = now - capFrom.getTime() > 2 * 24 * 3_600_000 ? 5 : 1;
      const agg = await Telemetry.aggregate([
        { $match: { machineId: { $in: keyed.map((k) => k.ref) }, timestamp: { $gte: capFrom } } },
        { $addFields: { pv: { $switch: {
          branches: keyed.map((k) => ({
            case: { $eq: ['$machineId', k.ref] },
            then: { $getField: { field: k.key, input: '$data' } },
          })),
          default: null,
        } } } },
        { $match: { pv: { $type: ['int', 'long', 'double', 'decimal'] } } },
        { $group: { _id: { m: '$machineId', t: { $dateTrunc: { date: '$timestamp', unit: 'minute', binSize: binMinutes } } }, pv: { $max: '$pv' } } },
        { $group: { _id: '$_id.m', pts: { $push: { t: '$_id.t', v: '$pv' } } } },
      ]).option({ maxTimeMS: 30_000 }).exec() as { _id: string; pts: { t: Date; v: number }[] }[];
      for (const m of agg) {
        const series = m.pts.map((p) => ({ t: +new Date(p.t), v: Number(p.v) }))
          .filter((p) => Number.isFinite(p.v)).sort((a, b) => a.t - b.t);
        evBy.set(m._id, stepEvents(series, PROD_STEP_PER_MIN));
      }
    }

    const out = [];
    for (const a of asgs) {
      const s = Math.max(+new Date(a.effectiveFrom), capFrom.getTime());
      const e = Math.min(
        a.effectiveTo ? +new Date(a.effectiveTo) : now,
        winTo ? winTo.getTime() : now,
        now,
      );
      if ((winFrom || winTo) && e <= s) continue;   // the run never touches the window
      const evs = evBy.get(a.machineRef);
      const produced = evs ? evs.reduce((n, ev) => (ev.t >= s && ev.t < e ? n + ev.made : n), 0) : null;
      out.push({
        machineRef: a.machineRef,
        dia: a.snapshot.diaName,
        dims: a.snapshot.dims || '',
        stage: a.snapshot.stageName,
        processingSec: a.snapshot.processingSec,
        from: a.effectiveFrom,
        to: a.effectiveTo,
        produced,                                   // null = machine counts nothing
        assignedBy: a.assignedBy?.name || '',
        truncated: !winFrom && +new Date(a.effectiveFrom) < capFrom.getTime(),
      });
    }
    return out;
  });
  return ok(res, rows);
});

// GET /production/audit — the change history, newest first.
export const listAudit = asyncHandler(async (req, res) => {
  const { page = '1', limit = '50' } = req.query as Record<string, string | undefined>;
  const lim = Math.min(Number(limit) || 50, 200);
  const skip = (Math.max(Number(page) || 1, 1) - 1) * lim;
  const [rows, total] = await Promise.all([
    AuditLog.find().sort({ at: -1 }).skip(skip).limit(lim).lean(),
    AuditLog.estimatedDocumentCount(),
  ]);
  return ok(res, rows, { total, page: Number(page), limit: lim });
});

// ── Compatibility surface: the teammate build's dia API ──────────────────────
// Same routes their client calls (/machines/dias, /machines/:code/dia,
// /machines/:code/dia/history), served from THIS app's machine_assignments —
// one store, so a dia set through either surface is the same record, keeps its
// frozen processing time, and lands in the audit trail. Their shape is
// {machine, dia, assignedAt, endedAt}; ours carries the stage and rate too, so
// both are returned and old clients simply ignore the extras.
const asDiaRow = (a: {
  machineRef: string; stageKey: string; snapshot: { diaName: string; stageName: string; processingSec: number };
  effectiveFrom: Date; effectiveTo: Date | null; assignedBy?: { name?: string };
}) => ({
  machine: a.machineRef,
  dia: a.snapshot.diaName,
  stage: a.snapshot.stageName,
  stageKey: a.stageKey,
  processingSec: a.snapshot.processingSec,
  assignedAt: a.effectiveFrom,
  endedAt: a.effectiveTo,
  assignedBy: a.assignedBy?.name || '',
});

// GET /machines/dias — current dia per machine, scoped.
export const machineDias = asyncHandler(async (req, res) => {
  const scope = machineScope(req.user as ScopedUser);
  const q: Record<string, unknown> = { effectiveTo: null };
  if (scope) q.machineRef = { $in: scope };
  const rows = await MachineAssignment.find(q).sort({ machineRef: 1 }).lean();
  return ok(res, rows.map(asDiaRow));
});

// POST /machines/:code/dia { dia, stage? } — assign by NAME. The stage is
// optional: without one the DIA's stage whose name matches the machine's family
// is used (CUTTINGMACHINE05 → "Cutting"), the same rule the assign modal
// pre-fills with. '' clears the assignment.
const normRef = (v: string): string => String(v || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
// The plant's abbreviations — mirrored in client lib/diaStage so the assign
// modal and this endpoint auto-pick the same stage for the same machine.
const FAMILY_STAGE_ALIASES: Record<string, string[]> = {
  SPG: ['SPINNING'],
  ISB: ['INTERNALSHOTBLASTING', 'SHOTBLASTING'],
};
export const setMachineDia = asyncHandler(async (req, res) => {
  const ref = String(req.params.code || '').trim();
  const scope = machineScope(req.user as ScopedUser);
  if (scope && !scope.includes(ref)) return fail(res, 403, 'You are not assigned to this machine');
  const body = req.body as { dia?: string; stage?: string };
  const diaName = String(body?.dia ?? '').trim();

  if (!diaName) {
    const prev = await MachineAssignment.findOneAndUpdate(
      { machineRef: ref, effectiveTo: null }, { $set: { effectiveTo: new Date() } },
    ).lean();
    if (prev) {
      audit(req.user as ScopedUser, 'assignment.end',
        { type: 'assignment', id: String(prev._id), label: `${ref} — ${prev.snapshot?.diaName}` },
        { diaName: prev.snapshot?.diaName }, null);
    }
    return ok(res, { machine: ref, dia: null });
  }

  const dia = await DiaConfig.findOne({ name: diaName }).lean();
  if (!dia) return fail(res, 404, `No DIA named "${diaName}"`);
  if (!dia.active) return fail(res, 400, `"${dia.name}" is deactivated`);
  const active = dia.stages.filter((s) => s.active);
  const wanted = String(body?.stage ?? '').trim();
  const stage = wanted
    ? active.find((s) => s.name.toLowerCase() === wanted.toLowerCase() || s.key === wanted)
    // No stage named → match the machine's family stem (and its known
    // aliases: SPG runs Spinning) against the stage names.
    : active.find((s) => {
      const n = normRef(s.name), stem = normRef(ref).replace(/\d+$/, '');
      if (!n) return false;
      return [stem, ...(FAMILY_STAGE_ALIASES[stem] ?? [])]
        .some((cand) => cand.includes(n) || n.includes(cand));
    }) || (active.length === 1 ? active[0] : undefined);
  if (!stage) {
    return fail(res, 400, wanted
      ? `"${dia.name}" has no active stage "${wanted}"`
      : `Which stage of "${dia.name}" does ${ref} run? Send { stage } — no stage name matches this machine.`);
  }

  const now = new Date();
  const prev = await MachineAssignment.findOneAndUpdate(
    { machineRef: ref, effectiveTo: null }, { $set: { effectiveTo: now } }, { sort: { effectiveFrom: -1 } },
  ).lean();
  const who = { id: String((req.user as ScopedUser)?._id || ''), name: (req.user as ScopedUser)?.name };
  const doc = await MachineAssignment.create({
    machineRef: ref, diaId: dia._id, stageKey: stage.key,
    snapshot: {
      diaName: dia.name, capacity: dia.capacity, dims: dia.dims,
      stageName: stage.name, processingSec: stage.processingSec,
    },
    effectiveFrom: now, effectiveTo: null, assignedBy: who,
  });
  audit(req.user as ScopedUser, 'assignment.create',
    { type: 'assignment', id: String(doc._id), label: `${ref} → ${dia.name} / ${stage.name}` },
    prev ? { diaName: prev.snapshot?.diaName, stageName: prev.snapshot?.stageName } : null,
    { diaName: dia.name, stageName: stage.name, processingSec: stage.processingSec });
  return created(res, asDiaRow(doc.toObject() as unknown as Parameters<typeof asDiaRow>[0]));
});

// GET /machines/:code/dia/history — every assignment this machine has held.
export const machineDiaHistory = asyncHandler(async (req, res) => {
  const ref = String(req.params.code || '').trim();
  const scope = machineScope(req.user as ScopedUser);
  if (scope && !scope.includes(ref)) return ok(res, []);
  const rows = await MachineAssignment.find({ machineRef: ref })
    .sort({ effectiveFrom: -1 }).limit(200).lean();
  return ok(res, rows.map(asDiaRow));
});
