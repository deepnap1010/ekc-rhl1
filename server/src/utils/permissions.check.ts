// Self-check for the Roles grid's catalogue and the Production split.
// Run: npx tsx server/src/utils/permissions.check.ts
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MODULES, ACTIONS } from '../models/Role.js';
import {
  PERMISSION_CATALOG, PRODUCTION_SPLIT, applicableActions, splitProduction, normalizePermissions,
} from './permissions.js';

const eq = (what: string, got: unknown, want: unknown): void => {
  if (JSON.stringify(got) !== JSON.stringify(want)) throw new Error(`${what}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
};
const ok = (what: string, cond: boolean): void => { if (!cond) throw new Error(what); };
const sorted = (m: Record<string, string[]>): Record<string, string[]> =>
  Object.fromEntries(Object.keys(m).sort().map((k) => [k, [...m[k]].sort()]));

// ── the catalogue describes the grid, nothing more and nothing less ──────────
eq('one catalogue entry per module, in grid order', PERMISSION_CATALOG.map((c) => c.module), MODULES);
for (const c of PERMISSION_CATALOG) {
  for (const a of Object.keys(c.actions)) ok(`${c.module}.${a} is not an action`, ACTIONS.includes(a));
  if (c.parent) ok(`${c.module}: parent ${c.parent} is not a module`, MODULES.includes(c.parent));
  if (c.strict) ok(`${c.module}: a strict row offers at least one action`, Object.keys(c.actions).length > 0);
}
for (const [old, grants] of Object.entries(PRODUCTION_SPLIT)) {
  for (const [m, a] of grants) ok(`split of production.${old} → ${m}.${a} is not offered by that row`, applicableActions(m).includes(a));
}
eq('the Production row itself only lets a person see', applicableActions('production'), ['view']);

// ── the plant's own case: a supervisor with Production view + update ─────────
const supervisor = splitProduction({ dashboard: ['view'], production: ['view', 'update'], downtime: ['view'] });
eq('the supervisor keeps everything Update used to allow, each as its own row', sorted(supervisor.perms), sorted({
  dashboard: ['view'], downtime: ['view'], production: ['view'],
  dia: ['update'], dia_assign: ['update'], dia_schedule: ['update'],
  breaks: ['update'], orders: ['update'], operator_sessions: ['update'],
}));
ok('the split reports a change', supervisor.changed);
eq('…and translating again changes nothing', splitProduction(supervisor.perms).changed, false);
// The admin then unticks the one box: cycle times go, scheduling stays.
const after = normalizePermissions({ ...supervisor.perms, dia: [] });
ok('unticked: no dia cycle-time edit', !after.dia);
eq('unticked: still schedules', after.dia_schedule, ['update']);
eq('unticked: still assigns', after.dia_assign, ['update']);

// ── every old tick lands where it used to reach ──────────────────────────────
eq('create → new dia + new order', sorted(splitProduction({ production: ['create'] }).perms), sorted({ dia: ['create'], orders: ['create'] }));
eq('delete → retire / delete a dia', sorted(splitProduction({ production: ['delete'] }).perms), sorted({ dia: ['delete'] }));
eq('admin meant every action, and the change history', sorted(splitProduction({ production: ['admin'] }).perms), sorted({
  production: ['view'], dia: ['create', 'update', 'delete'], dia_assign: ['update'], dia_schedule: ['update'],
  breaks: ['update'], orders: ['create', 'update'], operator_sessions: ['update'], audit: ['view'],
}));
eq('a role that only looks is left alone', splitProduction({ production: ['view'] }), { perms: { production: ['view'] }, changed: false });
eq('grants already held are not doubled', splitProduction({ production: ['update'], dia: ['update', 'create'] }).perms.dia, ['update', 'create']);

// ── what the API stores ──────────────────────────────────────────────────────
// A screen still open from before the deploy saves the old shape: read as what it meant.
eq('an old save is translated, not dropped', sorted(normalizePermissions({ production: ['view', 'update'] })), sorted({
  production: ['view'], dia: ['update'], dia_assign: ['update'], dia_schedule: ['update'],
  breaks: ['update'], orders: ['update'], operator_sessions: ['update'],
}));
eq('a strict row keeps only what it offers', normalizePermissions({ dia_assign: ['view', 'update', 'admin'], production: ['view', 'execute'] }),
  { dia_assign: ['update'], production: ['view'] });
eq('a row that is not strict keeps every box', normalizePermissions({ quality: ['view', 'approve'], downtime: ['view', 'create'] }),
  { quality: ['view', 'approve'], downtime: ['view', 'create'] });
eq('unknown modules and actions are dropped', normalizePermissions({ nope: ['view'], dashboard: ['view', 'fly'] }), { dashboard: ['view'] });
eq('the legacy flat shape still heals — and splits', sorted(normalizePermissions({ 0: 'production:delete', 1: ['dashboard:view'] })),
  sorted({ dia: ['delete'], dashboard: ['view'] }));

// ── nothing in the code still asks the old question ──────────────────────────
// A gate left on production create/update/delete/admin would now refuse
// everyone but a Super Admin — and one on a strict row's undescribed action
// could never be granted from the grid.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const walk = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
  const p = path.join(dir, e.name);
  if (e.isDirectory()) return e.name === 'node_modules' || e.name === 'dist' ? [] : walk(p);
  return /\.(ts|tsx)$/.test(e.name) && !/\.check\.ts$/.test(e.name) ? [p] : [];
});
const GATE = /\b(?:authorize|userCan|can|canOf)\)?\(\s*(?:[\w.?]+\s*,\s*)?'([a-z_]+)'(?:\s*,\s*'([a-z]+)')?\s*\)/g;
let gates = 0;
for (const file of [...walk(path.join(root, 'server/src')), ...walk(path.join(root, 'client/src'))]) {
  const src = fs.readFileSync(file, 'utf8');
  for (const m of src.matchAll(GATE)) {
    const [, mod, act = 'view'] = m;
    if (!MODULES.includes(mod)) continue;   // not a permission call (some other can())
    gates += 1;
    ok(`${path.relative(root, file)} asks for ${mod}.${act}, which the grid cannot grant`, applicableActions(mod).includes(act));
  }
}
ok(`the scan found the gates (${gates})`, gates > 60);

console.log(`permissions: all checks passed (${gates} gates scanned)`);
