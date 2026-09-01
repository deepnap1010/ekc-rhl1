// Self-check for machine-terminal logins, on a real (in-memory) MongoDB.
//   npm i --no-save mongodb-memory-server     (one-off)
//   npm run check:kiosk
//
// Two promises: a terminal sees ONE machine, and its session never ends —
// while still being revocable, because a token nobody can switch off is a key
// that never stops working.
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import jwt from 'jsonwebtoken';
import { User } from '../src/models/User.js';
import { Role } from '../src/models/Role.js';
import { login } from '../src/controllers/auth.controller.js';
import { authenticate } from '../src/middleware/auth.js';
import { machineScope } from '../src/utils/scope.js';

let bad = 0;
const check = (c: boolean, l: string): void => { console.log(`${c ? 'ok  ' : '!!  '}${l}`); if (!c) bad++; };

function call(fn: any, opts: { body?: any; headers?: any } = {}): Promise<any> {
  return new Promise((res2, rej) => {
    const req = { body: opts.body || {}, query: {}, params: {}, headers: opts.headers || {} } as any;
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

const mem = await MongoMemoryServer.create();
await mongoose.connect(mem.getUri(), { dbName: 'test' });
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';

const role = await Role.create({ name: 'Operator', key: 'operator',
  permissions: { dashboard: ['view'], machines: ['view'], production: ['view'] } });

const term = new User({ name: 'SPG02 Operator', email: 'spg02operator@ekc.local',
  role: role._id, assignedMachines: ['SPG02'], kiosk: true, active: true });
await term.setPassword('spg02-abc123');
await term.save();

const staff = new User({ name: 'Ramesh', email: 'ramesh@ekc.local',
  role: role._id, assignedMachines: ['CUTTINGMACHINE06', 'CUTTINGMACHINE07'], active: true });
await staff.setPassword('ramesh-pw');
await staff.save();

// ── the terminal signs in ────────────────────────────────────────────────────
const s = await call(login, { body: { email: 'spg02operator@ekc.local', password: 'spg02-abc123' } });
check(!!s.accessToken, 'the terminal can sign in');
check(s.user.kiosk === true, 'the client is told this is a terminal (so it never signs itself out)');
check(JSON.stringify(s.user.assignedMachines) === '["SPG02"]', 'it is tied to exactly one machine');

// ── THE PROMISE: no expiry ───────────────────────────────────────────────────
const decoded = jwt.decode(s.accessToken) as Record<string, unknown>;
check(decoded.exp === undefined, 'the access token carries NO expiry claim');
check((jwt.decode(s.refreshToken) as Record<string, unknown>).exp === undefined, 'nor does the refresh token');

// still valid when the clock has moved on ten years
const farFuture = Math.floor(Date.now() / 1000) + 10 * 365 * 24 * 3600;
let stillValid = true;
try { jwt.verify(s.accessToken, process.env.JWT_SECRET!, { clockTimestamp: farFuture }); }
catch { stillValid = false; }
check(stillValid, 'and it still verifies ten years from now');

// ── an ordinary login is unchanged ───────────────────────────────────────────
const st = await call(login, { body: { email: 'ramesh@ekc.local', password: 'ramesh-pw' } });
check(typeof (jwt.decode(st.accessToken) as Record<string, unknown>).exp === 'number',
  'a normal staff login still expires — this is for terminals only');

// ── it sees ONE machine ──────────────────────────────────────────────────────
const who = await auth(s.accessToken);
check(who?.name === 'SPG02 Operator', 'the token authenticates');
const scope = machineScope(who);
check(JSON.stringify(scope) === '["SPG02"]', 'every scoped query is limited to SPG02');
check(!scope?.includes('CUTTINGMACHINE06'), 'and cannot reach another machine');

// ── REVOCABLE: switching the account off ends it, token or no token ─────────
await User.updateOne({ _id: term._id }, { $set: { active: false } });
let refused = false;
try { await auth(s.accessToken); } catch { refused = true; }
check(refused, 'switching the account off stops the never-expiring token at once');

await mongoose.disconnect();
await mem.stop();
console.log(bad ? `\nFAIL: ${bad}` : '\nALL OK');
process.exit(bad ? 1 : 0);
