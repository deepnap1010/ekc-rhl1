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
