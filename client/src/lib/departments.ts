// client/src/lib/departments.ts
// Frontend-only ORG / RBAC knowledge for EKC (Everest Kanto Cylinder). The database
// is NEVER modified — this layer maps the REAL users (role, reportsTo, plant,
// assignedMachines) and REAL machines into the company structure:
//
//   Company → Plant → Department → Role → User
//
// Departments are switched on here as they're approved. Production is live first;
// Quality / Maintenance / HR / Safety follow by adding more entries to DEPARTMENTS.
import { useEffect, useReducer } from 'react';
import type { User, Machine, PermissionMatrix } from '../types/api';

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
// Built-in department keys; custom (user-added) departments contribute arbitrary
// string keys at runtime, so the type stays open while documenting the built-ins.
export type DeptKey = 'production' | 'quality' | 'maintenance' | 'safety' | (string & {});
export type RoleGroupKey = DeptKey | 'super_admin' | 'plant_head' | 'other';

export interface RoleDepartment {
  key: DeptKey;
  name: string;
  accent: string;
  match: string[];
  custom?: boolean;
}

export const ROLE_DEPARTMENTS: RoleDepartment[] = [
  { key: 'production',  name: 'Production Department',  accent: '#0D9488', match: ['production'] },
  { key: 'quality',     name: 'Quality Department',     accent: '#2563EB', match: ['quality', 'qc', 'inspect'] },
  { key: 'maintenance', name: 'Maintenance Department', accent: '#D97706', match: ['maintenance', 'electrical', 'mechanical', 'technician'] },
  { key: 'safety',      name: 'Safety Department',      accent: '#DC2626', match: ['safety'] },
];

// Generic shop-floor roles (no department word in the name) default into Production.
const GENERIC_PROD_ROLES = ['manager', 'supervis', 'operator'];

// ── User-added (custom) departments — stored locally only, never in the DB ──────
const CUSTOM_DEPT_KEY = 'ekc.custom.departments.v1';
const CUSTOM_DEPT_ACCENTS = ['#7C3AED', '#0EA5E9', '#DB2777', '#65A30D', '#EA580C', '#0891B2'];
const deptListeners = new Set<() => void>();

function readCustomDepts(): RoleDepartment[] {
  try { return JSON.parse(localStorage.getItem(CUSTOM_DEPT_KEY) || '[]') as RoleDepartment[]; } catch { return []; }
}
function writeCustomDepts(list: RoleDepartment[]): void {
  localStorage.setItem(CUSTOM_DEPT_KEY, JSON.stringify(list));
  deptListeners.forEach((fn) => fn());
}

export function getCustomDepartments(): RoleDepartment[] { return readCustomDepts(); }

// Built-in + user-added departments — the single source used to group roles.
export function allRoleDepartments(): RoleDepartment[] {
  return [...ROLE_DEPARTMENTS, ...readCustomDepts()];
}

// Add a department from a display name. Returns the new dept, or null if the name is
// empty/invalid or duplicates an existing department.
export function addCustomDepartment(name: string, accent?: string): RoleDepartment | null {
  const clean = String(name || '').replace(/department/i, '').trim();
  const key = clean.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  if (!key) return null;
  if (allRoleDepartments().some((d) => d.key === key)) return null;
  const list = readCustomDepts();
  const words = clean.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const dept: RoleDepartment = {
    key,
    name: /department$/i.test(name) ? name.trim() : `${clean} Department`,
    accent: accent || CUSTOM_DEPT_ACCENTS[list.length % CUSTOM_DEPT_ACCENTS.length] || '#7C3AED',
    match: [...new Set([key, ...words])],
    custom: true,
  };
  writeCustomDepts([...list, dept]);
  return dept;
}

export function removeCustomDepartment(key: string): void {
  writeCustomDepts(readCustomDepts().filter((d) => d.key !== key));
}

// Re-renders the holder whenever the custom-department list changes.
export function useRoleDepartments(): RoleDepartment[] {
  const [, force] = useReducer((c: number) => c + 1, 0);
  useEffect(() => { deptListeners.add(force); return () => { deptListeners.delete(force); }; }, []);
  return allRoleDepartments();
}

// A role-ish shape — both DB roles (Role) and trimmed user roles (UserRole) satisfy it.
export interface RoleLike {
  key?: string | null;
  name?: string | null;
}

// Route a role into a group for the Roles & Permissions tree:
//   'super_admin' · 'plant_head' · <department key> · 'other'
export function classifyRoleGroup(role?: RoleLike | null): RoleGroupKey {
  const s = `${role?.key || ''} ${role?.name || ''}`.toLowerCase();
  if (/super.?admin/.test(s)) return 'super_admin';
  if (/plant.?head|planthead/.test(s)) return 'plant_head';
  for (const d of allRoleDepartments()) if (d.match.some((k) => s.includes(k))) return d.key;
  if (GENERIC_PROD_ROLES.some((k) => s.includes(k))) return 'production';
  return 'other';
}

// Display-name overrides for generic shop-floor roles so they read with their
// department context. Display-only — the role's key/name in the DB is unchanged.
export const ROLE_DISPLAY_OVERRIDES: Record<string, string> = {
  manager: 'Production Manager',
  supervisor: 'Production Supervisor',
};
export function displayRoleName(role?: RoleLike | null): string {
  if (!role) return '';
  const key = (role.key || '').toLowerCase();
  return ROLE_DISPLAY_OVERRIDES[key] || role.name || role.key || '';
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
