// server/src/utils/bootstrap.ts
// First-access bootstrap. While the `users` collection is empty, the app accepts
// the env admin credentials and runs as a synthetic super-admin — WITHOUT writing
// any document. The instant a real user is created, bootstrap mode turns itself off.
import mongoose from 'mongoose';
import { User } from '../models/User.js';
import { EmployeeHistory } from '../models/EmployeeHistory.js';
import { env }  from '../config/env.js';
import type { AuthUser } from '../types/auth.js';

export const BOOTSTRAP_SUB = '__bootstrap__';

interface BootstrapCache {
  val: boolean | null;
  exp: number;
}

// estimatedDocumentCount is metadata-only (no scan); cache it briefly so we don't
// hit the DB on every authenticated request.
let cache: BootstrapCache = { val: null, exp: 0 };

export async function isBootstrapMode(): Promise<boolean> {
  const now = Date.now();
  if (cache.val !== null && now < cache.exp) return cache.val;
  const count = await User.estimatedDocumentCount();
  const val = count === 0;
  cache = { val, exp: now + 30_000 };
  return val;
}

export function invalidateBootstrapCache(): void {
  cache = { val: null, exp: 0 };
}

// Legacy permanent-delete shape, as stored on the User doc by earlier builds.
interface LegacyPermDelete {
  _id: mongoose.Types.ObjectId;
  name: string;
  email: string;
  plant?: string;
  role?: { name?: string; key?: string } | null;
  isSuperAdmin?: boolean;
  assignedMachines?: string[];
  deletion?: { reason?: string; at?: Date; by?: mongoose.Types.ObjectId | null } | null;
  createdAt?: Date;
}

// One-time / self-healing migration. Earlier builds "permanently deleted" an employee
// by only soft-deleting the User (deletion.type='permanent', active:false) — which
// left the unique email occupied, so re-creating a user with that email failed with a
// duplicate-key error. Convert any such leftovers into history tombstones and
// hard-delete the User, freeing the email. Idempotent: once converted the source
// users are gone, so re-runs find nothing.
export async function migratePermanentDeletes(): Promise<{ migrated: number }> {
  const legacy = await User.find({ 'deletion.type': 'permanent' })
    .populate('role', 'name key').lean() as unknown as LegacyPermDelete[];
  if (!legacy.length) return { migrated: 0 };

  await EmployeeHistory.insertMany(legacy.map((u) => ({
    userId: u._id, name: u.name, email: u.email, plant: u.plant || '',
    roleName: u.role?.name || null, roleKey: u.role?.key || null,
    isSuperAdmin: !!u.isSuperAdmin, assignedMachines: u.assignedMachines || [],
    reason: u.deletion?.reason || '', at: u.deletion?.at || new Date(), by: u.deletion?.by || null,
    joinedAt: u.createdAt || null,
  })), { ordered: false });
  await User.deleteMany({ _id: { $in: legacy.map((u) => u._id) } });
  return { migrated: legacy.length };
}

export function bootstrapUser(): AuthUser {
  return {
    _id: BOOTSTRAP_SUB,
    name: env.adminName,
    email: env.adminEmail,
    plant: '',
    isSuperAdmin: true,   // bypasses every permission check
    role: null,
    assignedMachines: [],
    active: true,
    bootstrap: true,
  };
}
