// server/src/controllers/rbac.controller.ts
import type { FilterQuery, Types } from 'mongoose';
import { Role, MODULES, ACTIONS } from '../models/Role.js';
import type { IRole } from '../models/Role.js';
import { User } from '../models/User.js';
import type { IUser, Deletion } from '../models/User.js';
import { EmployeeHistory } from '../models/EmployeeHistory.js';
import { ok, created, fail, asyncHandler } from '../utils/http.js';
import { invalidateBootstrapCache, migratePermanentDeletes } from '../utils/bootstrap.js';

// Coerce ANY stored/incoming permissions shape into a clean { module: [actions] }
// matrix, filtered to valid modules × actions. Self-heals legacy/corrupt data that
// older seeds wrote — flat "module:action" arrays (→ numeric Map keys) and even
// char-exploded strings (a bare "dashboard:view" stored as ['d','a','s',…]).
function normalizePermissions(raw: unknown): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  const add = (mod: string, act: string): void => {
    const m = mod.trim(); const a = act.trim();
    if (MODULES.includes(m) && ACTIONS.includes(a)) {
      if (!out[m]) out[m] = [];
      if (!out[m].includes(a)) out[m].push(a);
    }
  };
  const parseToken = (tok: string): void => {
    const i = tok.indexOf(':');
    if (i > 0) add(tok.slice(0, i), tok.slice(i + 1));
  };
  const obj: Record<string, unknown> = raw instanceof Map ? Object.fromEntries(raw) : ((raw as Record<string, unknown>) || {});
  for (const [k, v] of Object.entries(obj)) {
    if (MODULES.includes(k)) {
      (Array.isArray(v) ? v : [v]).forEach((a) => add(k, String(a)));   // proper { module: [actions] }
    } else if (Array.isArray(v)) {
      if (v.length && v.every((x) => typeof x === 'string' && (x as string).length === 1)) {
        parseToken(v.join(''));                                         // char-exploded "module:action"
      } else {
        v.forEach((tok) => parseToken(String(tok)));                    // ["module:action", …]
      }
    } else if (typeof v === 'string') {
      parseToken(v);
    }
  }
  return out;
}

// Structural view of a user as handed to stripUser: a lean/plain object with the
// role populated to its name/key (or null).
interface StripableUser {
  _id: unknown;
  name?: string;
  email?: string;
  plant?: string;
  isSuperAdmin?: boolean;
  role?: { _id?: unknown; name?: string; key?: string } | null;
  reportsTo?: unknown;
  assignedMachines?: string[];
  active?: boolean;
  deletion?: unknown;
}

// ---- Roles ----
export const listRoles = asyncHandler(async (req, res) => {
  const roles = await Role.find().sort({ isSystem: -1, name: 1 }).lean();
  return ok(res, roles.map((r) => ({ ...r, permissions: normalizePermissions(r.permissions) })));
});

export const rbacMeta = asyncHandler(async (req, res) =>
  ok(res, { modules: MODULES, actions: ACTIONS })
);

export const createRole = asyncHandler(async (req, res) => {
  const { name, key, description, permissions } = req.body as {
    name?: string;
    key?: string;
    description?: string;
    permissions?: Record<string, string[]>;
  };
  if (!name || !key) return fail(res, 400, 'name and key required');
  const clean = normalizePermissions(permissions);
  const role = await Role.create({ name, key, description, permissions: clean as unknown as IRole['permissions'] });
  return created(res, { ...role.toObject(), permissions: normalizePermissions(role.permissions) });
});

export const updateRolePermissions = asyncHandler(async (req, res) => {
  const { permissions } = req.body as { permissions?: Record<string, string[]> };
  const clean = normalizePermissions(permissions);
  const role = await Role.findByIdAndUpdate(
    req.params.id,
    { $set: { permissions: clean } },
    { new: true }
  ).lean();
  if (!role) return fail(res, 404, 'Role not found');
  return ok(res, { ...role, permissions: normalizePermissions(role.permissions) });
});

export const deleteRole = asyncHandler(async (req, res) => {
  const role = await Role.findById(req.params.id);
  if (!role) return fail(res, 404, 'Role not found');
  if (role.isSystem) return fail(res, 403, 'System roles cannot be deleted');
  await role.deleteOne();
  return ok(res, { deleted: true });
});

// ---- Users / Employees ----

// Lazily auto-restore temporary deletions whose window has elapsed, so an expired
// suspension silently returns the employee to the active roster (no scheduler needed).
async function reactivateExpiredSuspensions(): Promise<void> {
  await User.updateMany(
    { 'deletion.type': 'temporary', 'deletion.until': { $ne: null, $lte: new Date() } },
    { $set: { active: true, deletion: null } },
  );
}

export const listUsers = asyncHandler(async (req, res) => {
  await reactivateExpiredSuspensions();
  const { search, page = 1, limit = 20 } = req.query as Record<string, string | undefined>;
  // Only live employees; temporarily/permanently deleted ones live in /users/deleted.
  const q: FilterQuery<IUser> = { deletion: null };
  if (search) q.$or = [{ name: new RegExp(search, 'i') }, { email: new RegExp(search, 'i') }];
  const skip = (Number(page) - 1) * Number(limit);
  const [items, total] = await Promise.all([
    User.find(q).populate('role', 'name key').sort({ name: 1 }).skip(skip).limit(Number(limit)).lean(),
    User.countDocuments(q),
  ]);
  return ok(res, (items as unknown as StripableUser[]).map(stripUser), { total, page: Number(page), limit: Number(limit) });
});

export const createUser = asyncHandler(async (req, res) => {
  const { name, email, password, role, plant, reportsTo, assignedMachines, isSuperAdmin } = req.body as {
    name?: string;
    email?: string;
    password?: string;
    role?: unknown;
    plant?: string;
    reportsTo?: unknown;
    assignedMachines?: string[];
    isSuperAdmin?: boolean;
  };
  if (!name || !email || !password || !role) return fail(res, 400, 'name, email, password, role required');
  const user = new User({ name, email, role, plant, reportsTo: reportsTo || null, assignedMachines, isSuperAdmin });
  await user.setPassword(password);
  await user.save();
  invalidateBootstrapCache();   // first real user → bootstrap login disables immediately
  const populated = await user.populate('role', 'name key');
  return created(res, stripUser(populated.toObject() as unknown as StripableUser));
});

export const updateUser = asyncHandler(async (req, res) => {
  const { password, ...rest } = req.body as { password?: string } & Record<string, unknown>;
  const user = await User.findById(req.params.id);
  if (!user) return fail(res, 404, 'User not found');
  Object.assign(user, rest);
  if (password) await user.setPassword(password);
  await user.save();
  const populated = await user.populate('role', 'name key');
  return ok(res, stripUser(populated.toObject() as unknown as StripableUser));
});

export const deleteUser = asyncHandler(async (req, res) => {
  const user = await User.findByIdAndUpdate(req.params.id, { active: false }, { new: true });
  if (!user) return fail(res, 404, 'User not found');
  return ok(res, { deactivated: true });
});

// POST /users/:id/delete — temporary (suspend with window + reason) or permanent.
export const deleteEmployee = asyncHandler(async (req, res) => {
  const { type, reason, from, until } = req.body as { type?: string; reason?: string; from?: string; until?: string };
  if (type !== 'temporary' && type !== 'permanent') return fail(res, 400, "type must be 'temporary' or 'permanent'");

  const user = await User.findById(req.params.id);
  if (!user) return fail(res, 404, 'User not found');
  if (user.isSuperAdmin) return fail(res, 403, 'A Super Admin cannot be deleted');
  if (String(user._id) === String((req.user as { _id?: unknown })?._id)) return fail(res, 403, 'You cannot delete your own account');

  const now = new Date();
  const by = ((req.user as { _id?: Types.ObjectId })?._id) ?? null;

  // PERMANENT: hard-delete the User so the (unique) email is freed for re-use, and
  // keep a read-only snapshot in employee_history. This is what lets you re-create a
  // user with the same email later without a duplicate-key error.
  if (type === 'permanent') {
    const populated = await user.populate('role', 'name key');
    const prole = populated.role as unknown as { name?: string; key?: string } | null;
    await EmployeeHistory.create({
      userId: user._id, name: user.name, email: user.email, plant: user.plant || '',
      roleName: prole?.name || null, roleKey: prole?.key || null,
      isSuperAdmin: !!user.isSuperAdmin, assignedMachines: user.assignedMachines || [],
      reason: (reason || '').trim(), at: now, by,
      joinedAt: (user as { createdAt?: Date }).createdAt || null,
    });
    await user.deleteOne();
    return ok(res, { deleted: true, permanent: true, email: user.email });
  }

  // TEMPORARY: suspend for a window with a reason; auto-restores when it elapses.
  const fromD = from ? new Date(from) : now;
  const untilD = until ? new Date(until) : null;
  if (untilD && fromD && untilD <= fromD) return fail(res, 400, 'The end date must be after the start date');

  const deletion: Deletion = {
    type,
    reason: (reason || '').trim(),
    at: now,
    by,
    from: fromD,
    until: untilD,
  };
  user.deletion = deletion;
  user.active = false; // suspended accounts can no longer sign in
  await user.save();
  const populated = await user.populate('role', 'name key');
  return ok(res, stripUser(populated.toObject() as unknown as StripableUser));
});

// POST /users/:id/restore — bring a deleted employee back into the active roster.
export const restoreEmployee = asyncHandler(async (req, res) => {
  const user = await User.findById(req.params.id);
  if (!user) return fail(res, 404, 'User not found');
  if (!user.deletion) return fail(res, 400, 'Employee is already active');
  user.deletion = null;
  user.active = true;
  await user.save();
  const populated = await user.populate('role', 'name key');
  return ok(res, stripUser(populated.toObject() as unknown as StripableUser));
});

// A row in the Employee History feed (temporary suspension OR permanent tombstone).
interface DeletedRow {
  id: string;
  name?: string;
  email?: string;
  plant?: string;
  isSuperAdmin?: boolean;
  role: { id: unknown; name?: string; key?: string } | null;
  reportsTo: unknown;
  assignedMachines: string[];
  active: boolean;
  removedBy: string | null;
  joinedAt: Date | null;
  deletion: { type: string; reason: string; at: Date | null; by: unknown; from: Date | null; until: Date | null };
  permanent: boolean;
}

// Lean shape of a populated EmployeeHistory tombstone.
interface PermRow {
  _id: unknown;
  name: string; email: string; plant?: string;
  roleName?: string | null; roleKey?: string | null;
  isSuperAdmin?: boolean; assignedMachines?: string[];
  reason?: string; at?: Date;
  by?: { _id?: unknown; name?: string } | null;
  joinedAt?: Date | null;
}

// GET /users/deleted — the Employee History. Temporary suspensions still live on the
// User doc; permanent removals live as tombstones in employee_history. Merge both,
// newest removal first.
export const listDeletedEmployees = asyncHandler(async (req, res) => {
  await reactivateExpiredSuspensions();
  await migratePermanentDeletes();   // self-heal any legacy permanent soft-deletes
  const { search, type } = req.query as Record<string, string | undefined>;
  const rx = search ? new RegExp(search, 'i') : null;
  const wantTemp = !type || type === 'temporary';
  const wantPerm = !type || type === 'permanent';

  const [temps, perms] = await Promise.all([
    wantTemp
      ? User.find({ 'deletion.type': 'temporary', ...(rx ? { $or: [{ name: rx }, { email: rx }] } : {}) })
          .populate('role', 'name key').populate('deletion.by', 'name').sort({ 'deletion.at': -1 }).lean()
      : Promise.resolve([]),
    wantPerm
      ? EmployeeHistory.find(rx ? { $or: [{ name: rx }, { email: rx }] } : {}).populate('by', 'name').sort({ at: -1 }).lean()
      : Promise.resolve([]),
  ]);

  const tempRows: DeletedRow[] = (temps as unknown as StripableUser[]).map((u) => {
    const s = stripUser(u);
    const del = (u.deletion as { type?: string; reason?: string; at?: Date; by?: { _id?: unknown; name?: string } | null; from?: Date | null; until?: Date | null } | null) || null;
    return {
      id: String(s.id), name: s.name, email: s.email, plant: s.plant, isSuperAdmin: s.isSuperAdmin,
      role: s.role, reportsTo: s.reportsTo, assignedMachines: s.assignedMachines, active: s.active ?? false,
      removedBy: del?.by?.name || null,
      joinedAt: (u as { createdAt?: Date }).createdAt || null,
      deletion: { type: del?.type || 'temporary', reason: del?.reason || '', at: del?.at || null, by: del?.by?._id || null, from: del?.from || null, until: del?.until || null },
      permanent: false,
    };
  });

  const permRows: DeletedRow[] = (perms as unknown as PermRow[]).map((h) => ({
    id: String(h._id), name: h.name, email: h.email, plant: h.plant || '', isSuperAdmin: !!h.isSuperAdmin,
    role: h.roleName ? { id: null, name: h.roleName, key: h.roleKey ?? undefined } : null,
    reportsTo: null, assignedMachines: h.assignedMachines || [], active: false,
    removedBy: h.by?.name || null, joinedAt: h.joinedAt || null,
    deletion: { type: 'permanent', reason: h.reason || '', at: h.at || null, by: h.by?._id || null, from: null, until: null },
    permanent: true,
  }));

  const rows = [...tempRows, ...permRows].sort(
    (a, b) => new Date(b.deletion.at || 0).getTime() - new Date(a.deletion.at || 0).getTime(),
  );
  return ok(res, rows, { total: rows.length, page: 1, limit: rows.length });
});

// GET /users/orgchart — the reporting tree
export const orgChart = asyncHandler(async (req, res) => {
  const users = await User.find({ active: true }).populate('role', 'name key').lean();
  return ok(res, (users as unknown as StripableUser[]).map(stripUser));
});

function stripUser(u: StripableUser) {
  return {
    id: u._id,
    name: u.name,
    email: u.email,
    plant: u.plant,
    isSuperAdmin: u.isSuperAdmin,
    role: u.role ? { id: u.role._id, name: u.role.name, key: u.role.key } : null,
    reportsTo: u.reportsTo || null,
    assignedMachines: u.assignedMachines || [],
    active: u.active,
    deletion: u.deletion || null,
  };
}
