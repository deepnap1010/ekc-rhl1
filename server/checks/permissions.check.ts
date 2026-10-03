// Self-check for the Production permission split, on a real (in-memory) MongoDB.
//   npm i --no-save mongodb-memory-server     (one-off)
//   npm run check:permissions
//
// The promises: the day this ships nobody gains or loses anything (old ticks
// are translated at startup, before anything serves); the admin can then let a
// supervisor SCHEDULE a dia without letting them edit its CYCLE TIMES; and a
// restart never hands back what the admin took away.
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import { User } from '../src/models/User.js';
import { Role, MODULES, ACTIONS } from '../src/models/Role.js';
import { AuditLog } from '../src/models/AuditLog.js';
import { login } from '../src/controllers/auth.controller.js';
import { listRoles, rbacMeta, updateRolePermissions, createRole } from '../src/controllers/rbac.controller.js';
import { authenticate } from '../src/middleware/auth.js';
import { runStartupMigrations } from '../src/config/migrations.js';
import { migrateProductionSplit } from '../src/utils/permissions.js';
import router from '../src/routes/index.js';

let bad = 0;
const check = (c: boolean, l: string): void => { console.log(`${c ? 'ok  ' : '!!  '}${l}`); if (!c) bad++; };

function call(fn: any, opts: { body?: any; params?: any; user?: any } = {}): Promise<any> {
  return new Promise((res2, rej) => {
    const req = { body: opts.body || {}, query: {}, params: opts.params || {}, headers: {}, user: opts.user } as any;
    const res = {
      code: 200,
      status(c: number) { this.code = c; return this; },
      json(b: any) { b?.success ? res2(b.data) : rej(new Error(`${this.code}: ${b?.error?.message}`)); },
    } as any;
    Promise.resolve(fn(req, res, (e: any) => rej(e ?? new Error('next')))).catch(rej);
  });
}
/** Run authenticate() with a bearer token; resolves with the req.user it set. */
function auth(token: string): Promise<any> {
  return new Promise((res2, rej) => {
    const req = { headers: { authorization: `Bearer ${token}` } } as any;
    const res = { status() { return this; }, json(b: any) { rej(new Error(b?.error?.message)); } } as any;
    authenticate(req, res, () => res2(req.user));
  });
}
/** Would THIS route let this person through? Runs the route's own guard — the
 *  authorize() written in routes/index — not a copy of it. */
function allowed(method: string, path: string, user: any): boolean {
  const layer = (router as any).stack.find((l: any) => l.route && l.route.path === path && l.route.methods[method.toLowerCase()]);
  if (!layer) throw new Error(`no route ${method} ${path}`);
  let passed = false;
  const res = { status() { return this; }, json() { /* refused */ } } as any;
  layer.route.stack[0].handle({ user } as any, res, () => { passed = true; });
  return passed;
}
const stored = async (id: unknown): Promise<Record<string, string[]>> => {
  const r = await Role.findById(id).lean();
  const p = r?.permissions as unknown;
  return (p instanceof Map ? Object.fromEntries(p) : (p || {})) as Record<string, string[]>;
};
const has = (m: Record<string, string[]>, mod: string, act: string): boolean => (m[mod] || []).includes(act);

// A cold mongod on a Windows laptop can take longer than the default 10 s.
const mem = await MongoMemoryServer.create({ instance: { launchTimeout: 90_000 } });
await mongoose.connect(mem.getUri(), { dbName: 'test' });
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';

// ── the plant as it stands BEFORE the deploy ─────────────────────────────────
const operatorRole = await Role.create({ name: 'Operator', key: 'operator',
  permissions: { dashboard: ['view'], machines: ['view'], production: ['view'] } });
// Exactly the grid in the plant's screenshot: Production view + update.
const supervisorRole = await Role.create({ name: 'Production Supervisor', key: 'production_supervisor',
  permissions: { dashboard: ['view'], machines: ['view'], production: ['view', 'update'], downtime: ['view'], history: ['view'], reports: ['view'] } });
const managerRole = await Role.create({ name: 'Production Manager', key: 'production_manager',
  permissions: { dashboard: ['view'], production: ['view', 'create', 'update', 'delete', 'admin'] } });
// A Super Admin ROLE written before the new rows existed.
const OLD_MODULES = ['dashboard', 'machines', 'production', 'quality', 'downtime', 'history', 'reports', 'employees', 'roles', 'orgchart', 'alerts', 'settings', 'corrections'];
const superRole = await Role.create({ name: 'Super Admin', key: 'super_admin',
  permissions: Object.fromEntries(OLD_MODULES.map((m) => [m, [...ACTIONS]])) });

const mk = async (name: string, email: string, role: unknown, extra: Record<string, unknown> = {}): Promise<void> => {
  const u = new User({ name, email, role, active: true, ...extra });
  await u.setPassword('pw-123456');
  await u.save();
};
await mk('Ramesh', 'ramesh@ekc.in', supervisorRole._id);
await mk('Meena', 'meena@ekc.in', managerRole._id);
await mk('SPG02', 'spg2@ekc.in', operatorRole._id, { assignedMachines: ['SPG02'] });
await mk('Head', 'head@ekc.in', superRole._id);                     // the ROLE, without the user flag
// "Super Admin" only when key and name are read together — still that role.
const oddSuper = await Role.create({ name: 'Admin Super', key: 'admin_super',
  permissions: Object.fromEntries(OLD_MODULES.map((m) => [m, [...ACTIONS]])) });
await mk('Odd', 'odd@ekc.in', oddSuper._id);
await mk('EKC', 'admin@ekc.in', null, { isSuperAdmin: true });
const as = async (email: string): Promise<any> =>
  auth((await call(login, { body: { email, password: 'pw-123456' } })).accessToken);

// ── the deploy: startup migrations run before anything serves ────────────────
await runStartupMigrations();

const sup = await stored(supervisorRole._id);
check(JSON.stringify(sup.production) === '["view"]', 'supervisor: the Production row is left with View');
check(['dia', 'dia_assign', 'dia_schedule', 'breaks', 'orders', 'operator_sessions'].every((m) => has(sup, m, 'update')),
  'supervisor: everything Update used to allow is now its own row');
check(!has(sup, 'dia', 'create') && !has(sup, 'dia', 'delete') && !sup.audit, 'supervisor: and nothing it did not allow');
check(JSON.stringify(sup.downtime) === '["view"]' && JSON.stringify(sup.reports) === '["view"]', 'supervisor: the other rows are untouched');
const man = await stored(managerRole._id);
check(has(man, 'audit', 'view') && has(man, 'dia', 'create') && has(man, 'dia', 'delete') && has(man, 'orders', 'create'),
  'manager: Admin became every row, and the change history');
check(JSON.stringify(await stored(operatorRole._id)) === JSON.stringify({ dashboard: ['view'], machines: ['view'], production: ['view'] }),
  'operator: a role that only looks is not rewritten');
const sa = await stored(superRole._id);
check(MODULES.every((m) => ACTIONS.every((a) => has(sa, m, a))), 'the Super Admin role holds the new rows too');
check((await AuditLog.countDocuments({ action: 'role.permissions.split' })) === 2, 'each translated role left an audit row');

// ── day one: nobody gained or lost anything ──────────────────────────────────
let ramesh = await as('ramesh@ekc.in');
const WRITES: [string, string][] = [
  ['POST', '/production/assignments'], ['DELETE', '/production/assignments/current/:machineRef'], ['POST', '/machines/:code/dia'],
  ['POST', '/production/schedule'], ['DELETE', '/production/schedule/:id'],
  ['PUT', '/production/dia/:id'], ['PUT', '/production/breaks'], ['PATCH', '/production/orders/:id'],
  ['POST', '/production/operators'], ['DELETE', '/production/operators/current/:machineRef'],
];
check(WRITES.every(([m, p]) => allowed(m, p, ramesh)), 'supervisor: every write Update allowed yesterday still passes today');
check(!allowed('POST', '/production/dia', ramesh) && !allowed('DELETE', '/production/dia/:id', ramesh) && !allowed('POST', '/production/dia/:id/active', ramesh)
  && !allowed('POST', '/production/orders', ramesh) && !allowed('GET', '/production/audit', ramesh),
  'supervisor: and what it could not do yesterday it still cannot');
const meena = await as('meena@ekc.in');
check([...WRITES, ['POST', '/production/dia'], ['DELETE', '/production/dia/:id'], ['POST', '/production/orders'], ['GET', '/production/audit']]
  .every(([m, p]) => allowed(m, p, meena)), 'manager: keeps everything, the change history included');
const opr = await as('spg2@ekc.in');
check(allowed('GET', '/production/dia', opr) && allowed('GET', '/production/class-queue', opr) && WRITES.every(([m, p]) => !allowed(m, p, opr)),
  'operator: still sees and answers, still changes nothing');
const head = await as('head@ekc.in');
check([...WRITES, ['POST', '/production/dia'], ['GET', '/production/audit']].every(([m, p]) => allowed(m, p, head)),
  'the Super Admin ROLE (no user flag) reaches the new rows without anyone opening the Roles page');
const odd = await as('odd@ekc.in');
check([...WRITES, ['POST', '/production/dia'], ['GET', '/production/audit']].every(([m, p]) => allowed(m, p, odd)),
  'and so does a Super Admin role recognised only by key and name together');

// ── THE ASK: the admin unticks one box ───────────────────────────────────────
const boss = await as('admin@ekc.in');
const grid = (await call(listRoles, { user: boss })).find((r: any) => r.key === 'production_supervisor').permissions as Record<string, string[]>;
check(has(grid, 'dia', 'update') && JSON.stringify(grid.production) === '["view"]', 'the grid shows the supervisor what the server enforces');
const { dia: _unticked, ...withoutTimes } = grid;
await call(updateRolePermissions, { user: boss, params: { id: String(supervisorRole._id) }, body: { permissions: withoutTimes } });
ramesh = await as('ramesh@ekc.in');
check(!allowed('PUT', '/production/dia/:id', ramesh), 'supervisor: can NO LONGER edit a dia’s cycle times');
check(allowed('POST', '/production/schedule', ramesh) && allowed('DELETE', '/production/schedule/:id', ramesh), 'supervisor: still schedules a dia, and cancels a schedule');
check(allowed('POST', '/production/assignments', ramesh) && allowed('POST', '/machines/:code/dia', ramesh), 'supervisor: still puts a dia on a machine');
check(allowed('GET', '/production/dia', ramesh) && allowed('GET', '/production/targets', ramesh), 'supervisor: still sees the dias and the targets');

// ── a restart never hands it back ────────────────────────────────────────────
await runStartupMigrations();
check((await migrateProductionSplit()) === 0, 'a second run finds nothing to translate');
check(!has(await stored(supervisorRole._id), 'dia', 'update'), 'and the box the admin unticked stays unticked');

// ── what the API accepts ─────────────────────────────────────────────────────
// A Roles page left open across the deploy saves the old shape.
await call(updateRolePermissions, { user: boss, params: { id: String(operatorRole._id) }, body: { permissions: { production: ['view', 'update'] } } });
const oldSave = await stored(operatorRole._id);
check(JSON.stringify(oldSave.production) === '["view"]' && has(oldSave, 'dia_schedule', 'update') && has(oldSave, 'dia', 'update'),
  'an old-shape save is stored as what it meant, never as a tick nothing reads');
const made = await call(createRole, { user: boss, body: { name: 'Planner', key: 'planner', permissions: { production: ['view', 'admin', 'approve'], dia_schedule: ['update', 'admin', 'view'] } } });
check(JSON.stringify(made.permissions.production) === '["view"]' && JSON.stringify(made.permissions.dia_schedule) === '["update"]',
  'a strict row stores only the boxes it offers');
check((await Role.countDocuments({ 'permissions.production': { $in: ['create', 'update', 'delete', 'admin'] }, key: { $nin: ['super_admin', 'admin_super'] } })) === 0,
  'no role but Super Admin carries an old Production tick');

// ── the grid's own description ───────────────────────────────────────────────
const meta = await call(rbacMeta, { user: boss });
check(JSON.stringify(meta.catalog.map((c: any) => c.module)) === JSON.stringify(meta.modules), 'the catalogue describes every row, in order');
check(meta.catalog.find((c: any) => c.module === 'dia').actions.update.includes('cycle times'), 'and says what the cycle-time box allows');

await mongoose.disconnect();
await mem.stop();
console.log(bad ? `\nFAIL: ${bad}` : '\nALL OK');
process.exit(bad ? 1 : 0);
