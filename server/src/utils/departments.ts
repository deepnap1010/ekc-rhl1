// server/src/utils/departments.ts
// The plant's departments — the groups roles sit in. One list, shared by
// every screen that groups roles (Roles & Permissions, the Employees form,
// the org chart, the notification matrix), kept in the app_config singleton
// under `departments` and edited from the Roles page. Until an admin saves
// one, the four EKC built-ins apply — the same list the client has always
// grouped by, so nothing changes until someone changes it.
//
// A role points at a department by KEY (models/Role.department); renaming a
// department keeps its key, so roles follow the rename for free. Deleting one
// clears that key on its roles, which then fall back to being filed by the
// words in their names (the client's rule for unplaced roles).
import { AppConfig } from '../models/AppConfig.js';

export interface Department {
  key: string;     // slug, stable: roles point at it
  name: string;    // what people see
  accent: string;  // #rrggbb — the dot beside the name
}

export const DEFAULT_DEPARTMENTS: readonly Department[] = [
  { key: 'production',  name: 'Production Department',  accent: '#0D9488' },
  { key: 'quality',     name: 'Quality Department',     accent: '#2563EB' },
  { key: 'maintenance', name: 'Maintenance Department', accent: '#D97706' },
  { key: 'safety',      name: 'Safety Department',      accent: '#DC2626' },
];
const ACCENTS = ['#7C3AED', '#0EA5E9', '#DB2777', '#65A30D', '#EA580C', '#0891B2'];
export const MAX_DEPARTMENTS = 30;
export const KEY_RE = /^[a-z0-9][a-z0-9_]{0,39}$/;
// Group keys the client reserves beside the departments (leadership, the
// unplaced bucket), and names a plain object already answers to.
const RESERVED = new Set(['super_admin', 'plant_head', 'leadership', 'other']);
const ACCENT_RE = /^#[0-9a-f]{6}$/i;

/** A key from a display name: "HR & Admin" → "hr_admin". */
export const departmentKeyOf = (name: string): string =>
  String(name || '').toLowerCase().replace(/\s*department\s*$/i, '').replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40);

/** Validate + normalize a stored or admin-submitted list. Returns the clean
 *  list, or a human-readable error. null/undefined = nothing stored = the
 *  built-ins. Order is the admin's: it is the order every screen shows. */
export function normalizeDepartments(raw: unknown): Department[] | string {
  if (raw == null) return DEFAULT_DEPARTMENTS.map((d) => ({ ...d }));
  if (!Array.isArray(raw)) return 'departments must be a list';
  if (raw.length > MAX_DEPARTMENTS) return `at most ${MAX_DEPARTMENTS} departments`;
  const out: Department[] = [];
  const keys = new Set<string>();
  const names = new Set<string>();
  for (const d of raw as Record<string, unknown>[]) {
    if (!d || typeof d !== 'object') return 'invalid department';
    const name = String(d.name ?? '').trim();
    if (!name || name.length > 60) return 'a department name must be 1–60 characters';
    const key = String(d.key ?? '').trim().toLowerCase() || departmentKeyOf(name);
    if (!KEY_RE.test(key)) return `department key "${key}" must be 1–40 characters: letters, digits and _`;
    if (RESERVED.has(key) || key in Object.prototype) return `"${key}" cannot be a department key`;
    if (keys.has(key)) return `duplicate department key "${key}"`;
    if (names.has(name.toLowerCase())) return `duplicate department name "${name}"`;
    const accent = typeof d.accent === 'string' && ACCENT_RE.test(d.accent) ? d.accent.toUpperCase() : ACCENTS[out.length % ACCENTS.length];
    keys.add(key); names.add(name.toLowerCase());
    out.push({ key, name, accent });
  }
  if (!out.length) return 'keep at least one department';
  return out;
}

/** The stored list, or the built-ins; a corrupt document reads as the built-ins. */
export async function loadDepartments(): Promise<Department[]> {
  try {
    const doc = await AppConfig.findOne({ key: 'global' }).select({ departments: 1 }).lean();
    const norm = normalizeDepartments(doc?.departments);
    if (typeof norm !== 'string') return norm;
  } catch { /* DB hiccup → built-ins */ }
  return DEFAULT_DEPARTMENTS.map((d) => ({ ...d }));
}
