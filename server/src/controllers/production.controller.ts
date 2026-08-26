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
import { Order } from '../models/Order.js';
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
  const doc = await DiaConfig.findByIdAndUpdate(req.params.id, { $set: { active } }, { new: true }).lean();
  if (!doc) return fail(res, 404, 'DIA not found');
  audit(req.user as ScopedUser, active ? 'dia.activate' : 'dia.deactivate',
    { type: 'dia', id: String(doc._id), label: doc.name }, { active: !active }, { active });
  return ok(res, doc);
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
  const prev = await MachineAssignment.findOneAndUpdate(
    { machineRef: ref, effectiveTo: null },
    { $set: { effectiveTo: now } },
    { sort: { effectiveFrom: -1 } },
  ).lean();

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
  const lim = Math.min(Math.max(Number(q.limit) || 50, 1), 2000);
  const page = Math.max(Number(q.page) || 1, 1);

  const key = `targets:${fromD.toISOString()}:${toD.toISOString()}:${(refs || []).join(',') || '*'}`;
  const { rows: hourly, machines } = await cached(key, 60_000, () => computeTargets(fromD, toD, refs ?? null));

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
