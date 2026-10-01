// client/src/lib/departments.ts
// ORG / RBAC knowledge for EKC (Everest Kanto Cylinder). This layer maps the
// REAL users (role, reportsTo, plant, assignedMachines) and REAL machines into
// the company structure:
//
//   Company → Plant → Department → Role → User
//
// The narrative below (DEPARTMENTS: purposes, stations, reporting lines) is
// the org page's and stays here. The LIST of departments roles are grouped
// by is the plant's own — server-owned, edited on the Roles page — and the
// four built-ins here are only what applies until the server answers.
import { useEffect, useReducer } from 'react';
import type { User, Machine, PermissionMatrix, DepartmentRow } from '../types/api';
import { useAppConfig } from '../hooks/useAppConfig';

export const COMPANY = { name: 'Everest Kanto Cylinder', short: 'EKC' } as const;

export const ORG_LEVELS = ['Company', 'Plant', 'Department', 'Role', 'User'] as const;

// Role keywords that belong to OTHER departments — so generic shop-floor roles
// (manager / supervisor / operator) default into Production, while explicitly
// department-named roles (QC Manager, HR Manager…) never leak into Production.
export const OTHER_DEPT_KEYWORDS = [
  'quality', 'qc', 'inspect', 'maintenance', 'electrical', 'mechanical',
  'technician', 'hr', 'human resource', 'safety',
];

export interface DeptRole {
  key: string;
  title: string;
  roleKeywords: string[];
  excludeOtherDepts?: boolean;
  reportsTo: string;
  access: string[];
  responsibilities: string[];
}

export interface DeptStation {
  label: string;
  match: string[];
}

export interface Department {
  key: string;
  name: string;
  purpose: string;
  accent: string;
  machinesLabel?: string;
  roles: DeptRole[];
  machines: DeptStation[];
}

export const DEPARTMENTS: Department[] = [
  {
    key: 'production',
    name: 'Production Department',
    purpose: 'Manufacture cylinders — billet to finished cylinder.',
    accent: '#0D9488',
    machinesLabel: 'Production Machines',
    roles: [
      {
        key: 'production_manager',
        title: 'Production Manager',
        roleKeywords: ['manager'],
        excludeOtherDepts: true,
        reportsTo: 'Plant Head',
        access: ['Production Dashboard', 'Production Reports', 'Machine Monitoring', 'OEE Dashboard', 'Shift Performance', 'Production Targets'],
        responsibilities: ['Daily Production Planning', 'Target Achievement', 'Machine Utilization', 'Production Efficiency'],
      },
      {
        key: 'production_supervisor',
        title: 'Production Supervisor',
        roleKeywords: ['supervis'],
        excludeOtherDepts: true,
        reportsTo: 'Production Manager',
        access: ['Assigned Shift', 'Assigned Machines', 'Operator Management', 'Downtime Management'],
        responsibilities: ['Shift Monitoring', 'Operator Attendance', 'Production Entries', 'Machine Downtime Verification'],
      },
      {
        key: 'production_operator',
        title: 'Production Operator',
        roleKeywords: ['operator'],
        excludeOtherDepts: true,
        reportsTo: 'Production Supervisor',
        access: ['Assigned Machines Only', 'Production Entry', 'Downtime Entry'],
        responsibilities: ['Machine Operation', 'Production Recording', 'Basic Quality Checks'],
      },
    ],
    // Conceptual production line stations → matched against the real machine list.
    machines: [
      { label: 'Bottom Milling', match: ['milling'] },
      { label: 'Necking', match: ['neck'] },
      { label: 'Hot Spinning', match: ['spin'] },
      { label: 'Furnace', match: ['furnace', 'ihf'] },
      { label: 'Threading', match: ['thread', 'lathe'] },
      { label: 'Hydro Test Feed Line', match: ['hydro'] },
      { label: 'Painting', match: ['paint'] },
    ],
  },
  {
    key: 'quality',
    name: 'Quality Department',
    purpose: 'Ensure every cylinder meets quality & safety standards.',
    accent: '#2563EB',
    machinesLabel: 'Inspection & Test Stations',
    roles: [
      {
        key: 'qc_manager', title: 'QC Manager',
        roleKeywords: ['qc_manager', 'qc manager', 'quality manager'],
        reportsTo: 'Plant Head',
        access: ['Quality Dashboard', 'Inspection Reports', 'Test Results', 'Defect Analytics', 'Batch Approvals', 'Compliance Reports'],
        responsibilities: ['Quality Planning', 'Defect Rate Control', 'Inspection Scheduling', 'Compliance & Audits'],
      },
      {
        key: 'qc_supervisor', title: 'QC Supervisor',
        roleKeywords: ['qc_supervisor', 'qc supervisor', 'quality supervisor'],
        reportsTo: 'QC Manager',
        access: ['Assigned Shift', 'Inspection Queue', 'Inspector Management', 'Defect Logging'],
        responsibilities: ['Shift Inspection Monitoring', 'Inspector Allocation', 'Sample Verification', 'Defect Verification'],
      },
      {
        key: 'qc_inspector', title: 'QC Inspector',
        roleKeywords: ['qc_inspector', 'qc inspector', 'inspector'],
        reportsTo: 'QC Supervisor',
        access: ['Assigned Inspections', 'Inspection Entry', 'Defect Entry'],
        responsibilities: ['Dimensional Inspection', 'Pressure / Hydro Test Checks', 'Visual Inspection', 'Recording Results'],
      },
    ],
    machines: [
      { label: 'Hydro Testing', match: ['hydro'] },
      { label: 'Internal Shot Blasting', match: ['shotblast', 'internalshot', 'blast'] },
      { label: 'Inspection & Marking', match: ['inspect', 'marking'] },
    ],
  },
  {
    key: 'maintenance',
    name: 'Maintenance Department',
    purpose: 'Keep plant machinery running — preventive & breakdown maintenance.',
    accent: '#D97706',
    machinesLabel: 'Maintained Equipment',
    roles: [
      {
        key: 'maintenance_manager', title: 'Maintenance Manager',
        roleKeywords: ['maintenance_manager', 'maintenance manager'],
        reportsTo: 'Plant Head',
        access: ['Maintenance Dashboard', 'Machine Health', 'Downtime Reports', 'Maintenance Schedule', 'Spare Parts', 'Breakdown Logs'],
        responsibilities: ['Preventive Maintenance Planning', 'Breakdown Response', 'Machine Uptime', 'Spare Parts Management'],
      },
      {
        key: 'electrical_engineer', title: 'Electrical Engineer',
        roleKeywords: ['electrical_engineer', 'electrical'],
        reportsTo: 'Maintenance Manager',
        access: ['Assigned Machines', 'Electrical Faults', 'Downtime Entry', 'Maintenance Logs'],
        responsibilities: ['Electrical Maintenance', 'PLC & Drive Upkeep', 'Fault Diagnosis', 'Breakdown Repair'],
      },
      {
        key: 'mechanical_engineer', title: 'Mechanical Engineer',
        roleKeywords: ['mechanical_engineer', 'mechanical'],
        reportsTo: 'Maintenance Manager',
        access: ['Assigned Machines', 'Mechanical Faults', 'Downtime Entry', 'Maintenance Logs'],
        responsibilities: ['Mechanical Maintenance', 'Hydraulics & Pneumatics', 'Fault Diagnosis', 'Breakdown Repair'],
      },
      {
        key: 'technician', title: 'Technician',
        roleKeywords: ['technician'],
        reportsTo: 'Maintenance Manager',
        access: ['Assigned Tasks', 'Maintenance Entry', 'Downtime Entry'],
        responsibilities: ['Routine Servicing', 'Lubrication & Checks', 'Assist Repairs', 'Parts Replacement'],
      },
    ],
    machines: [
      { label: 'Furnaces', match: ['furnace', 'ihf'] },
      { label: 'Milling Machines', match: ['milling'] },
      { label: 'Lathe / CNC', match: ['lathe', 'cut'] },
      { label: 'Hydraulic Systems', match: ['hydr'] },
      { label: 'Shot Blasting', match: ['blast', 'shotblast'] },
    ],
  },
  {
    key: 'safety',
    name: 'Safety Department',
    purpose: 'Ensure workplace safety & compliance across the plant.',
    accent: '#DC2626',
    machinesLabel: 'Monitored Equipment',
    roles: [
      {
        key: 'safety_manager', title: 'Safety Manager',
        roleKeywords: ['safety_manager', 'safety manager'],
        reportsTo: 'Plant Head',
        access: ['Safety Dashboard', 'Incident Reports', 'Alarm Management', 'Compliance Reports', 'Audit Logs', 'Emergency Protocols'],
        responsibilities: ['Safety Policy & Compliance', 'Incident Investigation', 'Risk Assessment', 'Safety Audits'],
      },
      {
        key: 'safety_officer', title: 'Safety Officer',
        roleKeywords: ['safety_officer', 'safety officer'],
        reportsTo: 'Safety Manager',
        access: ['Assigned Area', 'Incident Entry', 'Alarm Monitoring', 'Safety Checklists'],
        responsibilities: ['Floor Safety Monitoring', 'PPE Compliance', 'Incident Reporting', 'Emergency Response'],
      },
    ],
    machines: [
      { label: 'Furnaces (Heat)', match: ['furnace', 'ihf'] },
      { label: 'Hydro Testing (Pressure)', match: ['hydro'] },
      { label: 'Hydraulic Systems', match: ['hydr'] },
    ],
  },
];

// ── Roles & Permissions grouping ───────────────────────────────────────────────
// Lightweight department buckets used to organise the roles tree:
//   Super Admin → Plant Head → Department → roles.
// `match` are the keywords that route a role's key/name into the department, so when
// the user creates e.g. "QC Manager" it lands under Quality automatically.
// Built-in department keys; the plant's own departments contribute arbitrary
// string keys at runtime, so the type stays open while documenting the built-ins.
export type DeptKey = 'production' | 'quality' | 'maintenance' | 'safety' | (string & {});
export type RoleGroupKey = DeptKey | 'super_admin' | 'plant_head' | 'other';

export interface RoleDepartment {
  key: DeptKey;
  name: string;
  accent: string;
  match: string[];   // words that file an UNPLACED role here by its name
}

export const ROLE_DEPARTMENTS: RoleDepartment[] = [
  { key: 'production',  name: 'Production Department',  accent: '#0D9488', match: ['production'] },
  { key: 'quality',     name: 'Quality Department',     accent: '#2563EB', match: ['quality', 'qc', 'inspect'] },
  { key: 'maintenance', name: 'Maintenance Department', accent: '#D97706', match: ['maintenance', 'electrical', 'mechanical', 'technician'] },
  { key: 'safety',      name: 'Safety Department',      accent: '#DC2626', match: ['safety'] },
];

// Generic shop-floor roles (no department word in the name) default into Production.
const GENERIC_PROD_ROLES = ['manager', 'supervis', 'operator'];

// ── The plant's department list — server-owned ──────────────────────────────
// Read from the shared config (GET /config.departments), edited on the Roles
// page (PUT /rbac/departments). Kept in a module-level cache so the pure
// helpers below (classifyRoleGroup, the org chart's deptOf…) read it
// synchronously; the hook feeds the cache and re-renders its holders when
// the list changes. Until the server answers, the four built-ins apply — the
// same list the server defaults to, so nothing flickers.
let serverDepts: RoleDepartment[] | null = null;
const deptListeners = new Set<() => void>();

// Words that file an UNPLACED role into a department by its name: the curated
// list for a built-in, the department's own name for one the plant added.
const matchWordsOf = (d: DepartmentRow): string[] => {
  const builtin = ROLE_DEPARTMENTS.find((b) => b.key === d.key);
  if (builtin) return builtin.match;
  const words = d.name.toLowerCase().replace(/department/g, ' ').split(/[^a-z0-9]+/).filter((w) => w.length > 2);
  return [...new Set([d.key, ...words])];
};
/** Feed the cache; returns whether it changed. Silent — notifying is the hook's job. */
function primeServerDepts(list: DepartmentRow[]): boolean {
  const next = list.map((d) => ({ key: d.key, name: d.name, accent: d.accent, match: matchWordsOf(d) }));
  if (JSON.stringify(next) === JSON.stringify(serverDepts)) return false;
  serverDepts = next;
  return true;
}

/** The plant's departments, in the admin's order — the single source used to group roles. */
export function allRoleDepartments(): RoleDepartment[] {
  return serverDepts ?? ROLE_DEPARTMENTS;
}

/** The list, live: feeds the cache from the shared config and re-renders the
 *  holder whenever it changes. The cache is primed during render, before the
 *  holder reads it, so a form's first render (an employee's department, say)
 *  already sees the plant's list; other holders are told in the effect. */
export function useRoleDepartments(): RoleDepartment[] {
  const { departments } = useAppConfig();
  const [, force] = useReducer((c: number) => c + 1, 0);
  useEffect(() => { deptListeners.add(force); return () => { deptListeners.delete(force); }; }, []);
  const changed = !!departments?.length && primeServerDepts(departments);
  useEffect(() => { if (changed) deptListeners.forEach((fn) => fn()); }, [changed, departments]);
  return allRoleDepartments();
}

// Departments an earlier build kept on THIS device only (localStorage). The
// Roles page moves them to the plant's list once, then forgets them here.
const LEGACY_LOCAL_KEY = 'ekc.custom.departments.v1';
export function takeLocalDepartments(): { key: string; name: string; accent: string }[] {
  try {
    const raw = JSON.parse(localStorage.getItem(LEGACY_LOCAL_KEY) || '[]') as { key?: string; name?: string; accent?: string }[];
    // The old modal capped nothing; the plant's list does.
    return Array.isArray(raw)
      ? raw.filter((d) => d && d.key && d.name).map((d) => ({ key: String(d.key).toLowerCase().replace(/[^a-z0-9_]/g, '_').slice(0, 40), name: String(d.name).trim().slice(0, 60), accent: String(d.accent || '#7C3AED') }))
      : [];
  } catch { return []; }
}
export function forgetLocalDepartments(): void { try { localStorage.removeItem(LEGACY_LOCAL_KEY); } catch { /* nothing to forget */ } }

// A role-ish shape — both DB roles (Role) and trimmed user roles (UserRole) satisfy it.
export interface RoleLike {
  key?: string | null;
  name?: string | null;
  department?: string | null;   // where the admin placed it, '' = filed by its name
}

// Route a role into a group for the Roles & Permissions tree:
//   'super_admin' · 'plant_head' · <department key> · 'other'
// Leadership is recognised by name whatever else is set; after that the
// admin's placement wins, and only an unplaced role is filed by its words.
export function classifyRoleGroup(role?: RoleLike | null): RoleGroupKey {
  const s = `${role?.key || ''} ${role?.name || ''}`.toLowerCase();
  if (/super.?admin/.test(s)) return 'super_admin';
  if (/plant.?head|planthead/.test(s)) return 'plant_head';
  const placed = String(role?.department || '').trim().toLowerCase();
  if (placed && allRoleDepartments().some((d) => d.key === placed)) return placed;
  for (const d of allRoleDepartments()) if (d.match.some((k) => s.includes(k))) return d.key;
  // Generic shop-floor words mean Production — while the plant has one.
  if (GENERIC_PROD_ROLES.some((k) => s.includes(k)) && allRoleDepartments().some((d) => d.key === 'production')) return 'production';
  return 'other';
}

// A role reads as the admin named it — the Roles page renames it for real
// now, so no display-time overrides.
export function displayRoleName(role?: RoleLike | null): string {
  return role ? (role.name || role.key || '') : '';
}

// Ready-to-create department roles with sensible baseline permissions. Created via
// the normal /roles API (same as the "New role" form) — the user can fine-tune each
// role's matrix afterwards. Keys are chosen so classifyRoleGroup routes them to the
// right department automatically (qc_* → Quality, *_engineer → Maintenance, etc.).
export interface RoleTemplate {
  name: string;
  key: string;
  description: string;
  permissions: PermissionMatrix;
}

export const DEFAULT_ROLE_TEMPLATES: RoleTemplate[] = [
  // Quality Department
  { name: 'QC Manager', key: 'qc_manager', description: 'Heads Quality Control for the plant.',
    permissions: { dashboard: ['view'], machines: ['view'], quality: ['view', 'create', 'update', 'execute', 'approve'], reports: ['view'], history: ['view'], downtime: ['view'], alerts: ['view'] } },
  { name: 'QC Supervisor', key: 'qc_supervisor', description: 'Supervises QC inspections on the floor.',
    permissions: { dashboard: ['view'], machines: ['view'], quality: ['view', 'create', 'update'], downtime: ['view', 'update'], history: ['view'] } },
  { name: 'QC Inspector', key: 'qc_inspector', description: 'Performs quality inspections and records results.',
    permissions: { dashboard: ['view'], machines: ['view'], quality: ['view', 'create'], history: ['view'] } },

  // Maintenance Department
  { name: 'Maintenance Manager', key: 'maintenance_manager', description: 'Heads plant maintenance.',
    permissions: { dashboard: ['view'], machines: ['view', 'update'], downtime: ['view', 'create', 'update', 'approve'], reports: ['view'], history: ['view'], alerts: ['view', 'update'] } },
  { name: 'Electrical Engineer', key: 'electrical_engineer', description: 'Handles electrical maintenance.',
    permissions: { dashboard: ['view'], machines: ['view'], downtime: ['view', 'create', 'update'], history: ['view'], alerts: ['view'] } },
  { name: 'Mechanical Engineer', key: 'mechanical_engineer', description: 'Handles mechanical maintenance.',
    permissions: { dashboard: ['view'], machines: ['view'], downtime: ['view', 'create', 'update'], history: ['view'], alerts: ['view'] } },
  { name: 'Technician', key: 'technician', description: 'Carries out maintenance tasks on the floor.',
    permissions: { dashboard: ['view'], machines: ['view'], downtime: ['view', 'create'], history: ['view'] } },

  // Safety Department
  { name: 'Safety Manager', key: 'safety_manager', description: 'Heads plant safety.',
    permissions: { dashboard: ['view'], machines: ['view'], alerts: ['view', 'create', 'update', 'approve'], downtime: ['view', 'approve'], reports: ['view'], history: ['view'] } },
  { name: 'Safety Officer', key: 'safety_officer', description: 'Monitors and enforces safety on the floor.',
    permissions: { dashboard: ['view'], machines: ['view'], alerts: ['view', 'create', 'update'], downtime: ['view'], history: ['view'] } },
];

// ── matching helpers (pure, read-only) ─────────────────────────────────────────
const norm = (s: unknown): string => String(s ?? '').toLowerCase();
const strip = (s: unknown): string => norm(s).replace(/[^a-z0-9]/g, '');

export const isSuperAdminUser = (u: Pick<User, 'isSuperAdmin' | 'role'>): boolean =>
  !!u.isSuperAdmin || /super.?admin/.test(norm(`${u.role?.key} ${u.role?.name}`));
export const isPlantHead = (u: Pick<User, 'role'>): boolean =>
  /plant.?head|planthead/.test(norm(`${u.role?.key} ${u.role?.name}`));

// Users that fill a given department role (by their role key/name).
export function usersForRole(users: User[] | undefined, role: DeptRole): User[] {
  return (users || []).filter((u) => {
    if (u.isSuperAdmin) return false; // super admins sit above all departments
    const s = norm(`${u.role?.key} ${u.role?.name}`);
    if (!role.roleKeywords.some((k) => s.includes(k))) return false;
    if (role.excludeOtherDepts && OTHER_DEPT_KEYWORDS.some((k) => s.includes(k))) return false;
    return true;
  });
}

// The stable id we route on (route is /machines/:code in this app).
export function machineKey(m: Machine): string {
  return String(m.code || m.machineId || m.id || m._id || '');
}

// Real machines whose id/name/type matches any of the station keywords.
export function machinesForKeywords(machines: Machine[] | undefined, keywords: string[]): Machine[] {
  return (machines || []).filter((m) => {
    const hay = strip(`${machineKey(m)} ${m.name || ''} ${m.type || ''}`);
    return keywords.some((k) => hay.includes(strip(k)));
  });
}
