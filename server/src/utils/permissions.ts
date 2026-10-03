// server/src/utils/permissions.ts
// What each tick on the Roles grid allows — and the one-time split of the old
// "Production" row.
//
// Production used to be one row: its Update tick let a person put a dia on a
// machine, schedule one, edit a dia's CYCLE TIMES, change the break schedule,
// close an order and hand a machine over — all or nothing. A supervisor who
// should schedule dias could therefore also re-time them. Each of those is now
// its own row (models/Role MODULES), and the old ticks are translated into
// the rows that carry what they used to mean, so nobody gains or loses
// anything the day this ships; the admin then unticks what a role should not
// have.
import { Role, MODULES, ACTIONS, FULL_PERMISSIONS, isSuperAdminRole } from '../models/Role.js';
import { AuditLog } from '../models/AuditLog.js';

export type PermissionMatrix = Record<string, string[]>;

export interface CatalogEntry {
  module: string;
  label: string;
  hint?: string;      // one line under the label
  parent?: string;    // drawn indented under this module's row
  // strict: the row offers ONLY the actions described here — the others gate
  // nothing, are not drawn and are not stored. A row that is not strict keeps
  // every box it always had; the descriptions are tooltips.
  strict?: boolean;
  actions: Record<string, string>;
}

// One entry per module, in grid order. The description of an action is what
// the routes (routes/index) and the screens really gate on it — a tick the
// app never asks about has no description.
export const PERMISSION_CATALOG: CatalogEntry[] = [
  { module: 'dashboard', label: 'Dashboard', actions: { view: 'Open the Dashboard.' } },
  { module: 'machines', label: 'Machines', actions: {
    view: 'See the machines, their live state and their figures.',
    admin: 'Give a machine its own display name.',
  } },
  { module: 'production', label: 'Production', strict: true,
    hint: 'Production Targets, the target boards, the operator popups',
    actions: {
      view: 'Open Production Targets and Dia Trace, see targets and what each machine is making, and answer the operator popups. The rows below change things; this one lets a person see them.',
    } },
  { module: 'dia', parent: 'production', label: 'Dia & cycle times', strict: true,
    hint: 'The dia catalogue and the time each dia takes',
    actions: {
      create: 'Add a new dia with its cycle times.',
      update: 'Edit an existing dia’s cycle times — per stage and per machine. Targets move with them.',
      delete: 'Retire, restore or permanently delete a dia.',
    } },
  { module: 'dia_assign', parent: 'production', label: 'Dia on machines', strict: true,
    hint: 'What a machine is making right now',
    actions: { update: 'Put a dia on a machine now, change it, or clear it.' } },
  { module: 'dia_schedule', parent: 'production', label: 'Dia schedule', strict: true,
    hint: 'A dia switch set for a later moment',
    actions: { update: 'Schedule a dia to switch onto a machine at a future time, and cancel a pending schedule.' } },
  { module: 'breaks', parent: 'production', label: 'Break schedule', strict: true,
    hint: 'Planned breaks — left out of targets and downtime asks',
    actions: { update: 'Change the plant’s break schedule.' } },
  { module: 'orders', parent: 'production', label: 'Orders', strict: true,
    hint: 'Orders counted against a quantity',
    actions: {
      create: 'Open a new order.',
      update: 'Mark an order done, cancel it or reopen it.',
    } },
  { module: 'operator_sessions', parent: 'production', label: 'Operator on machine', strict: true,
    hint: 'Who is running a machine',
    actions: { update: 'Start, hand over or end the operator session on a machine. Picking the person from the list also needs Employees → View.' } },
  { module: 'audit', parent: 'production', label: 'Change history', strict: true,
    hint: 'The log of who changed what',
    actions: { view: 'See the change history on Production Targets.' } },
  { module: 'quality', label: 'Quality', actions: {} },
  { module: 'downtime', label: 'Downtime', actions: {
    view: 'Open the Downtime page and a machine’s stops.',
    update: 'Add or edit the reason for a stop, and acknowledge a stop.',
  } },
  { module: 'history', label: 'History', actions: {
    view: 'Open the History Log and a machine’s history and timeline.',
    update: 'Correct how a production event was classified.',
  } },
  { module: 'reports', label: 'Reports', actions: { view: 'Open Reports and export the Excel workbook.' } },
  { module: 'employees', label: 'Employees', actions: {
    view: 'See the employee list.',
    create: 'Add an employee.',
    update: 'Edit an employee, and restore a removed one.',
    delete: 'Remove an employee.',
  } },
  { module: 'roles', label: 'Roles', actions: {
    view: 'Open Roles & Permissions.',
    create: 'Create a role.',
    update: 'Change a role’s permissions, name or department, and edit the departments.',
    delete: 'Delete a role.',
  } },
  { module: 'orgchart', label: 'Org chart', actions: { view: 'Open the Org Chart and Departments pages.' } },
  { module: 'alerts', label: 'Alerts', actions: { view: 'Open the Alerts page.' } },
  { module: 'settings', label: 'Settings', actions: {
    view: 'Open Settings.',
    update: 'Change the shared settings — company, shifts, stages, alert rules, popups and the notification workflow.',
  } },
  { module: 'corrections', label: 'Error correction', actions: {
    view: 'Open Error Correction and read the book.',
    create: 'Record what a machine really did over a period.',
    delete: 'Revoke a correction.',
  } },
];

const ENTRY = new Map(PERMISSION_CATALOG.map((c) => [c.module, c]));

/** The actions a module's row offers: its described ones when the row is
 *  strict, every action otherwise. */
export function applicableActions(module: string): string[] {
  const c = ENTRY.get(module);
  return c?.strict ? ACTIONS.filter((a) => a in c.actions) : ACTIONS;
}

// ── the split ────────────────────────────────────────────────────────────────
// What each old Production tick used to allow, as the rows that carry it now.
// Admin meant "every action of the module" (middleware/auth#userCan), so it
// becomes all of them plus the change history it alone unlocked.
type Grant = [module: string, action: string];
const OLD_CREATE: Grant[] = [['dia', 'create'], ['orders', 'create']];
const OLD_UPDATE: Grant[] = [
  ['dia', 'update'], ['dia_assign', 'update'], ['dia_schedule', 'update'],
  ['breaks', 'update'], ['orders', 'update'], ['operator_sessions', 'update'],
];
const OLD_DELETE: Grant[] = [['dia', 'delete']];
export const PRODUCTION_SPLIT: Record<string, Grant[]> = {
  create: OLD_CREATE,
  update: OLD_UPDATE,
  delete: OLD_DELETE,
  admin: [['production', 'view'], ...OLD_CREATE, ...OLD_UPDATE, ...OLD_DELETE, ['audit', 'view']],
};
export const OLD_PRODUCTION_ACTIONS = Object.keys(PRODUCTION_SPLIT);
const isOld = (a: string): boolean => Object.prototype.hasOwnProperty.call(PRODUCTION_SPLIT, a);

/** Translate a matrix's old Production ticks into the rows that replaced
 *  them. Every other module is returned as it came. Once translated there is
 *  nothing left to translate, so running it again changes nothing. */
export function splitProduction(perms: PermissionMatrix): { perms: PermissionMatrix; changed: boolean } {
  const prod = Array.isArray(perms.production) ? perms.production : [];
  const old = prod.filter(isOld);
  if (!old.length) return { perms, changed: false };
  const out: PermissionMatrix = { ...perms, production: prod.filter((a) => !isOld(a)) };
  for (const a of old) {
    for (const [m, act] of PRODUCTION_SPLIT[a]) {
      const cur = Array.isArray(out[m]) ? out[m] : [];
      if (!cur.includes(act)) out[m] = [...cur, act];
    }
  }
  if (!out.production.length) delete out.production;
  return { perms: out, changed: true };
}

// Coerce ANY stored/incoming permissions shape into a clean { module: [actions] }
// matrix, filtered to valid modules × actions. Self-heals legacy/corrupt data that
// older seeds wrote — flat "module:action" arrays (→ numeric Map keys) and even
// char-exploded strings (a bare "dashboard:view" stored as ['d','a','s',…]).
// An old Production tick — from a matrix saved before the split, or a screen
// still open from before the deploy — is read as what it meant, never dropped;
// then a strict row keeps only the actions it offers.
export function normalizePermissions(raw: unknown): PermissionMatrix {
  const healed: PermissionMatrix = {};
  const add = (mod: string, act: string): void => {
    const m = mod.trim(); const a = act.trim();
    if (MODULES.includes(m) && ACTIONS.includes(a)) {
      if (!healed[m]) healed[m] = [];
      if (!healed[m].includes(a)) healed[m].push(a);
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
  const { perms } = splitProduction(healed);
  const out: PermissionMatrix = {};
  for (const [m, acts] of Object.entries(perms)) {
    const offered = applicableActions(m);
    const kept = acts.filter((a) => offered.includes(a));
    if (kept.length) out[m] = kept;
  }
  return out;
}

// ── stored roles ─────────────────────────────────────────────────────────────

// The Super Admin grid is read-only in the UI, so nobody could ever tick its boxes:
// the role was created with an empty matrix and stayed that way. Its access came
// solely from the user-level isSuperAdmin flag, which left the page claiming "full
// access" above 84 empty checkboxes — and an employee given the ROLE without the
// flag got nothing at all. Self-heal: the role that means everything holds
// everything — including a row added since. Idempotent. Which role that is, is
// decided by isSuperAdminRole — the same test createRole, the grid's lock and
// the split below use, so no role can be "Super Admin" to one and not another.
export async function grantSuperAdminEverything(): Promise<void> {
  const ids = (await Role.find().select('key name').lean()).filter((r) => isSuperAdminRole(r)).map((r) => r._id);
  if (!ids.length) return;
  await Role.updateMany({ _id: { $in: ids } }, { $set: { permissions: FULL_PERMISSIONS } });
}

/** Rewrite every stored role that still carries an old Production tick, so
 *  what authorize() reads is the split matrix. Only that translation is
 *  written — the role's other rows stay exactly as stored. Idempotent: a
 *  translated role no longer matches. Returns how many roles moved. */
export async function migrateProductionSplit(): Promise<number> {
  const roles = await Role.find({ 'permissions.production': { $in: OLD_PRODUCTION_ACTIONS } })
    .select('key name permissions').lean();
  let moved = 0;
  for (const r of roles) {
    if (isSuperAdminRole(r)) continue;   // holds everything (grantSuperAdminEverything)
    const stored = (r.permissions instanceof Map ? Object.fromEntries(r.permissions) : (r.permissions || {})) as PermissionMatrix;
    const { perms, changed } = splitProduction(stored);
    if (!changed) continue;
    // Only if the row is still the one we read: a save from the Roles page in
    // between has already been translated on its way in.
    const done = await Role.updateOne({ _id: r._id, 'permissions.production': stored.production }, { $set: { permissions: perms } });
    if (!done.modifiedCount) continue;
    moved += 1;
    // An audit row must never be the reason the translation fails.
    await AuditLog.create({
      at: new Date(), user: { id: '', name: 'system' }, action: 'role.permissions.split',
      entity: { type: 'role', id: String(r._id), label: r.name },
      before: { production: stored.production },
      after: Object.fromEntries(Object.entries(perms).filter(([m]) => m === 'production' || ENTRY.get(m)?.parent === 'production')),
    }).catch(() => {});
    console.log(`[migrate] role "${r.name}": production [${stored.production.join(', ')}] → its own rows`);
  }
  return moved;
}
