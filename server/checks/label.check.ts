// Self-check for shared machine names, on a real (in-memory) MongoDB.
//   npm i --no-save mongodb-memory-server     (one-off)
//   npm run check:label
//
// The rule: renaming writes ONE row in machine_labels and touches nothing else.
// The machines collection, which the factory's own system owns, must come out
// byte-identical.
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import { Machine } from '../src/models/Machine.js';
import { MachineLabel } from '../src/models/MachineLabel.js';
import { listMachineLabels, setMachineLabel } from '../src/controllers/machine.controller.js';
import { runStartupMigrations } from '../src/config/migrations.js';

let bad = 0;
const check = (c: boolean, l: string) => { console.log(`${c ? 'ok  ' : '!!  '}${l}`); if (!c) bad++; };
const ADMIN = { _id: 'admin1', name: 'EKC' };

function call(fn: any, opts: { body?: any; params?: any; user?: any } = {}): Promise<any> {
  return new Promise((res2, rej) => {
    const req = { query: {}, body: opts.body || {}, params: opts.params || {}, user: opts.user || ADMIN } as any;
    const res = { status() { return this; }, json(b: any) { b?.success ? res2(b.data) : rej(new Error(`${b?.error?.message}`)); } } as any;
    Promise.resolve(fn(req, res, rej)).catch(rej);
  });
}

const mem = await MongoMemoryServer.create();
await mongoose.connect(mem.getUri(), { dbName: 'test' });

await Machine.create([
  { code: 'CUTTINGMACHINE04', machineId: 'CUTTINGMACHINE04', name: 'Cutting 4' },
  { code: 'SPG-06', machineId: 'SPG-06', name: 'Spinner' },
]);
const before = JSON.stringify(await Machine.find().sort({ code: 1 }).lean());

// ── a stale unique index from an older shape of this collection ─────────────
// This is the real bug it shipped with: machine_labels carried a unique index
// on `machineId`, a field the current model does not write. Every document
// stored null there, so ONE machine could be renamed and the next came back as
// "Duplicate entry".
await mongoose.connection.db!.collection('machine_labels')
  .createIndex({ machineId: 1 }, { unique: true, name: 'machineId_1' });
await call(setMachineLabel, { params: { code: 'CUTTINGMACHINE04' }, body: { displayName: 'PC04' } });
let blew = false;
try { await call(setMachineLabel, { params: { code: 'SPG-06' }, body: { displayName: 'Spinner 6' } }); }
catch { blew = true; }
check(blew, 'reproduced: with the stale index, the SECOND rename fails');

await runStartupMigrations();
const names = (await mongoose.connection.db!.collection('machine_labels').indexes()).map((i) => i.name);
check(!names.includes('machineId_1'), 'the migration drops it');
check(names.includes('machineRef_1'), "and keeps the collection's own unique index");
await call(setMachineLabel, { params: { code: 'SPG-06' }, body: { displayName: 'Spinner 6' } });
check(await MachineLabel.countDocuments() === 2, 'a second machine can now be renamed');
await MachineLabel.deleteMany({});

// ── rename ───────────────────────────────────────────────────────────────────
await call(setMachineLabel, { params: { code: 'CUTTINGMACHINE04' }, body: { displayName: 'PC04' } });
let labels = await call(listMachineLabels);
check(labels.length === 1 && labels[0].displayName === 'PC04', `stored: ${labels[0]?.machineRef} → ${labels[0]?.displayName}`);
check(labels[0].machineRef === 'CUTTINGMACHINE04', 'filed under the REAL code, not the label');
check(labels[0].updatedBy?.name === 'EKC', 'records who renamed it');

// ── the machine itself is untouched — this is the whole promise ─────────────
check(JSON.stringify(await Machine.find().sort({ code: 1 }).lean()) === before,
  'the machines collection is byte-identical afterwards');

// ── everyone reads the same list (no per-user filtering) ────────────────────
const asOperator = await call(listMachineLabels, { user: { _id: 'op1', name: 'Aman', assignedMachines: ['CUTTINGMACHINE07'] } });
check(asOperator.length === 1 && asOperator[0].displayName === 'PC04',
  'an operator sees the admin\'s name, unscoped — one board, one vocabulary');

// ── the cached list updates at once, or a rename looks broken ───────────────
await call(setMachineLabel, { params: { code: 'CUTTINGMACHINE04' }, body: { displayName: 'PC-04B' } });
labels = await call(listMachineLabels);
check(labels[0].displayName === 'PC-04B', 'a second rename shows immediately (cache invalidated)');
check(await MachineLabel.countDocuments() === 1, 'and did not leave a second row behind');

// ── punctuation cannot create two labels for one machine ───────────────────
await call(setMachineLabel, { params: { code: 'SPG-06' }, body: { displayName: 'Spinner 6' } });
await call(setMachineLabel, { params: { code: 'SPG-06' }, body: { displayName: 'Spinner Six' } });
check(await MachineLabel.countDocuments({ machineRef: /^SPG/i }) === 1, 'SPG-06 has exactly one label');

// ── clearing ────────────────────────────────────────────────────────────────
await call(setMachineLabel, { params: { code: 'CUTTINGMACHINE04' }, body: { displayName: '' } });
labels = await call(listMachineLabels);
check(!labels.some((l: any) => l.machineRef === 'CUTTINGMACHINE04'), 'an empty name removes the label');

// ── guards ──────────────────────────────────────────────────────────────────
await call(setMachineLabel, { params: { code: 'NOSUCHMACHINE' }, body: { displayName: 'Ghost' } })
  .then(() => check(false, 'a name for a machine that does not exist is refused'),
    () => check(true, 'a name for a machine that does not exist is refused'));
await call(setMachineLabel, { params: { code: 'SPG-06' }, body: { displayName: 'x'.repeat(80) } })
  .then(() => check(false, 'an over-long name is refused'), () => check(true, 'an over-long name is refused'));

await mongoose.disconnect();
await mem.stop();
console.log(bad ? `\nFAIL: ${bad}` : '\nALL OK');
process.exit(bad ? 1 : 0);
