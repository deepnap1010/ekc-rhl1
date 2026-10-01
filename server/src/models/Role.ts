// server/src/models/Role.ts
// Dynamic RBAC. Each role holds a permission matrix: module -> set of actions.
// Matches the "Roles & Permissions" grid in the reference UI.
import mongoose from 'mongoose';

// The canonical action set per module
export const ACTIONS = ['view', 'create', 'update', 'delete', 'execute', 'approve', 'admin'];

// The modules the system exposes (single source of truth for the grid)
export const MODULES = [
  'dashboard',
  'machines',
  'production',
  'quality',
  'downtime',
  'history',
  'reports',
  'employees',
  'roles',
  'orgchart',
  'alerts',
  'settings',
  // The error-correction book: who may say what a machine really did over a
  // period (view the book, create a correction, revoke one). Nobody until
  // the admin ticks it.
  'corrections',
];

// Super Admin means "everything", so it is defined by a matrix, not by a flag a
// caller might forget to tick. Every reader — the permission grid, authorize(),
// the login payload — then sees the same access.
export const SUPER_ADMIN_RE = /super[\s_-]*admin/i;

export const isSuperAdminRole = (r?: { key?: string; name?: string } | null): boolean =>
  SUPER_ADMIN_RE.test(`${r?.key || ''} ${r?.name || ''}`);

export const FULL_PERMISSIONS: Record<string, string[]> =
  Object.fromEntries(MODULES.map((m) => [m, [...ACTIONS]]));

export interface IRole {
  name: string;
  key: string;
  description: string;
  // The department this role sits in (a key from the plant's department list,
  // utils/departments) — '' = not placed, so the client files it by the words
  // in its name, as it always did.
  department: string;
  isSystem: boolean;
  // { dashboard: ['view'], machines: ['view','update'], ... }
  permissions: Map<string, string[]>;
}

const roleSchema = new mongoose.Schema<IRole>(
  {
    name: { type: String, required: true },          // "Production Supervisor"
    key: { type: String, required: true, unique: true }, // "supervisor"
    description: { type: String, default: '' },
    department: { type: String, default: '' },       // department key, '' = unplaced
    isSystem: { type: Boolean, default: false },     // system roles can't be deleted

    // { dashboard: ['view'], machines: ['view','update'], ... }
    permissions: {
      type: Map,
      of: [String],
      default: {},
    },
  },
  { timestamps: true }
);

export const Role = mongoose.model<IRole>('Role', roleSchema);
