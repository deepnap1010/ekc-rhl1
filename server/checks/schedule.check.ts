// Self-check for the scheduled-dia engine, on a real (in-memory) MongoDB.
// Every case here is a defect this feature actually had before it shipped, so a
// regression fails here instead of on the floor at 07:00.
//
//   npm i --no-save mongodb-memory-server     (one-off; NOT a dependency — it
//   npm run check:schedule                     downloads a mongod binary, and
//                                              deploys must not pay for that)
//
// Lives outside src/ on purpose: tsconfig covers src only, so the missing
// module never breaks typecheck or the build.
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import { ScheduledAssignment } from '../src/models/ScheduledAssignment.js';
import { MachineAssignment } from '../src/models/MachineAssignment.js';
import { DiaConfig } from '../src/models/DiaConfig.js';
import { applyDueSchedules } from '../src/services/schedule.service.js';
import { listSchedules, createSchedule, cancelSchedule, ackSchedule, setDiaActive, assignMachine, deleteDia } from '../src/controllers/production.controller.js';

let bad = 0;
const check = (cond: boolean, label: string): void => {
  console.log(`${cond ? 'ok  ' : '!!  '}${label}`);
  if (!cond) bad += 1;
};

const ADMIN = { _id: 'admin1', name: 'ADMIN', assignedMachines: [] as string[] };
const OP = { _id: 'op1', name: 'OP', assignedMachines: ['MC-01'] };
const OP2 = { _id: 'op2', name: 'OP2', assignedMachines: ['MC-01'] };
const STRANGER = { _id: 'op3', name: 'STR', assignedMachines: ['MC-99'] };

function call(fn: any, opts: { query?: any; body?: any; params?: any; user?: any } = {}): Promise<any> {
  return new Promise((resolve, reject) => {
    const req = { query: opts.query || {}, body: opts.body || {}, params: opts.params || {}, user: opts.user || ADMIN } as any;
    const res = {
      code: 200,
      status(c: number) { this.code = c; return this; },
      json(b: any) { b?.success ? resolve(b.data) : reject(new Error(`${this.code}: ${b?.error?.message}`)); },
    } as any;
    Promise.resolve(fn(req, res, ((e: any) => reject(e)) as any)).catch(reject);
  });
}
const openRows = (ref: string) => MachineAssignment.countDocuments({ machineRef: ref, effectiveTo: null });
const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
const ahead = (min: number) => new Date(Date.now() + min * 60_000).toISOString();

/** Create a schedule and let its moment arrive. */
async function due(body: Record<string, unknown>, minsAgo: number, user?: unknown): Promise<any> {
  const row = await call(createSchedule, { user, body: { ...body, applyAt: ahead(30) } });
  await ScheduledAssignment.updateOne({ _id: row._id }, { $set: { applyAt: new Date(Date.now() - minsAgo * 60_000) } });
  return { ...row, applyAt: new Date(Date.now() - minsAgo * 60_000).toISOString() };
}

async function main() {
  const mem = await MongoMemoryServer.create();
  await mongoose.connect(mem.getUri(), { dbName: 'check' });

  const dia = await DiaConfig.create({
    name: 'DIA-A', capacity: '', dims: '20 X 40', active: true,
    stages: [{ key: 'cutting', name: 'Cutting', seq: 1, processingSec: 180, active: true }],
  });
  const diaB = await DiaConfig.create({
    name: 'DIA-B', capacity: '', dims: '30 X 50', active: true,
    stages: [{ key: 'cutting', name: 'Cutting', seq: 1, processingSec: 120, active: true }],
  });
  const base = { diaId: String(dia._id), stageKey: 'cutting' };

  // ── 1. the happy path ─────────────────────────────────────────────────────
  const s1 = await due({ ...base, machineRef: 'MC-01' }, 5);
  check(s1.status === 'pending', 'created pending');
  await applyDueSchedules();
  const s1b = await ScheduledAssignment.findById(s1._id).lean();
  const a1 = await MachineAssignment.findOne({ machineRef: 'MC-01', effectiveTo: null }).lean();
  check(s1b?.status === 'applied', 'applied at its moment');
  check(!!a1 && a1.snapshot.processingSec === 180, 'snapshot frozen from the dia at apply time');
  check(!!a1 && Math.abs(+new Date(a1.effectiveFrom) - +new Date(s1b!.applyAt)) < 1500,
    'effectiveFrom is the SCHEDULED minute, not the tick');

  // ── 2. HIGH: concurrent runs must not leave two "current" rows ─────────────
  await due({ ...base, diaId: String(diaB._id), machineRef: 'MC-01' }, 4);
  await due({ ...base, machineRef: 'MC-01' }, 3);
  await Promise.all([applyDueSchedules(), applyDueSchedules(), applyDueSchedules(), applyDueSchedules()]);
  check((await openRows('MC-01')) === 1, 'four concurrent apply runs leave exactly ONE open assignment');
  const cur = await MachineAssignment.findOne({ machineRef: 'MC-01', effectiveTo: null }).lean();
  check(String(cur?.diaId) === String(dia._id), 'the LAST-scheduled dia wins (applied in applyAt order)');
  const spans = await MachineAssignment.find({ machineRef: 'MC-01' }).sort({ effectiveFrom: 1 }).lean();
  check(spans.every((s, i) => !spans[i + 1] || +new Date(s.effectiveTo!) <= +new Date(spans[i + 1].effectiveFrom)),
    'assignment spans never overlap');

  // ── 3. HIGH: a crash between claim and write must RETRY, not vanish ────────
  await MachineAssignment.deleteMany({});
  const s4 = await due({ ...base, machineRef: 'MC-02' }, 2);
  // simulate the crash: the row was claimed, the process died before writing
  await ScheduledAssignment.updateOne({ _id: s4._id }, { $set: { claimedAt: new Date(Date.now() - 10 * 60_000) } });
  await applyDueSchedules();
  const s4b = await ScheduledAssignment.findById(s4._id).lean();
  check(s4b?.status === 'applied' && (await openRows('MC-02')) === 1,
    'a stale claim is retried on the next run (crash recovery)');
  // a FRESH claim belongs to a run still in flight — do not steal it
  const s5 = await due({ ...base, machineRef: 'MC-03' }, 1);
  await ScheduledAssignment.updateOne({ _id: s5._id }, { $set: { claimedAt: new Date() } });
  await applyDueSchedules();
  check((await ScheduledAssignment.findById(s5._id).lean())?.status === 'pending',
    'a fresh claim is left alone (no double-apply)');

  // ── 4. a manual assignment made AFTER the scheduled time wins ─────────────
  const s6 = await due({ ...base, machineRef: 'MC-04' }, 10);
  await call(assignMachine, { body: { machineRef: 'MC-04', diaId: String(diaB._id), stageKey: 'cutting' } });
  await applyDueSchedules();
  const s6b = await ScheduledAssignment.findById(s6._id).lean();
  const a6 = await MachineAssignment.findOne({ machineRef: 'MC-04', effectiveTo: null }).lean();
  check(s6b?.status === 'failed' && /superseded/.test(s6b?.reason || ''), 'schedule defers to a later human assignment');
  check(String(a6?.diaId) === String(diaB._id), "the human's dia is still on the machine");
  check((await openRows('MC-04')) === 1, 'and still exactly one open row');

  // ── 5. idempotence: same dia already running ──────────────────────────────
  const s7 = await due({ ...base, diaId: String(diaB._id), machineRef: 'MC-04' }, 0.2);
  await applyDueSchedules();
  const s7b = await ScheduledAssignment.findById(s7._id).lean();
  check(s7b?.status === 'applied' && /already/.test(s7b?.reason || ''), 'already-running dia → applied, no churn');
  check((await MachineAssignment.countDocuments({ machineRef: 'MC-04' })) === 1, 'no duplicate assignment row written');

  // ── 6. cancel is atomic and cannot overwrite an apply ─────────────────────
  const s8 = await call(createSchedule, { body: { ...base, machineRef: 'MC-05', applyAt: ahead(60) } });
  check((await call(cancelSchedule, { params: { id: String(s8._id) } })).status === 'cancelled', 'pending cancels');
  await applyDueSchedules();
  check((await openRows('MC-05')) === 0, 'a cancelled schedule never applies');
  const s9 = await due({ ...base, machineRef: 'MC-06' }, 1);
  await applyDueSchedules();
  await call(cancelSchedule, { params: { id: String(s9._id) } })
    .then(() => check(false, 'cancelling an applied schedule is refused'),
      () => check(true, 'cancelling an applied schedule is refused'));
  check((await ScheduledAssignment.findById(s9._id).lean())?.status === 'applied',
    'the applied status survives the cancel attempt');

  // ── 7. retiring a dia cancels its pending schedules (no silent 07:00 no-op) ─
  const s10 = await call(createSchedule, { body: { ...base, machineRef: 'MC-07', applyAt: ahead(120) } });
  await call(setDiaActive, { params: { id: String(dia._id) }, body: { active: false } });
  const s10b = await ScheduledAssignment.findById(s10._id).lean();
  check(s10b?.status === 'cancelled' && /retired/.test(s10b?.reason || ''), 'retiring a dia cancels its pending schedules');
  await DiaConfig.updateOne({ _id: dia._id }, { $set: { active: true } });

  // ── 8. a schedule that FAILS still reaches the operator ────────────────────
  const s11 = await due({ ...base, machineRef: 'MC-01' }, 1);
  await DiaConfig.updateOne({ _id: dia._id }, { $set: { active: false } });   // retired behind its back
  await applyDueSchedules();
  const s11b = await ScheduledAssignment.findById(s11._id).lean();
  check(s11b?.status === 'failed', 'a schedule whose dia went away fails');
  const opFeed = await call(listSchedules, { user: OP, query: { unacked: '1' } });
  check(opFeed.some((r: any) => String(r._id) === String(s11._id)), 'the operator IS told the switch did not happen');
  await DiaConfig.updateOne({ _id: dia._id }, { $set: { active: true } });

  // ── 9. the popup: per-person, own machines only ────────────────────────────
  const before = await call(listSchedules, { user: OP, query: { unacked: '1' } });
  check(before.length > 0 && before.every((r: any) => r.machineRef === 'MC-01'), 'operator sees only their own machines');
  for (const r of before) await call(ackSchedule, { user: OP, params: { id: String(r._id) } });
  check((await call(listSchedules, { user: OP, query: { unacked: '1' } })).length === 0, 'after ack, their popup is empty');
  check((await call(listSchedules, { user: OP2, query: { unacked: '1' } })).length === before.length,
    "one person's ack does not dismiss it for their colleague");
  check((await call(listSchedules, { user: STRANGER, query: { unacked: '1' } })).length === 0, 'a stranger sees none of it');
  check((await call(listSchedules, { user: ADMIN, query: { unacked: '1' } })).length === 0,
    'an admin with no assigned machines is not nagged with the whole plant');

  // ── 10. scope + input guards ──────────────────────────────────────────────
  await call(createSchedule, { user: STRANGER, body: { ...base, machineRef: 'MC-01', applyAt: ahead(10) } })
    .then(() => check(false, 'out-of-scope create refused'), () => check(true, 'out-of-scope create refused'));
  await call(createSchedule, { body: { ...base, machineRef: 'MC-08', applyAt: ago(120) } })
    .then(() => check(false, 'a moment in the past is refused'), () => check(true, 'a moment in the past is refused'));
  await call(createSchedule, { body: { ...base, machineRef: 'MC-08', applyAt: ahead(10), note: 'x'.repeat(600) } })
    .then(() => check(false, 'an oversized note is refused'), () => check(true, 'an oversized note is refused'));
  await call(listSchedules, { query: { machineRef: ['A', 'B'] } })
    .then(() => check(true, 'a repeated machineRef query param does not 500'), () => check(false, 'a repeated machineRef query param does not 500'));

  // ── 11. case-insensitive refs (PLC codes are not normalised anywhere) ─────
  await MachineAssignment.deleteMany({});
  await ScheduledAssignment.deleteMany({});
  await call(assignMachine, { body: { machineRef: 'mc-01', diaId: String(diaB._id), stageKey: 'cutting' } });
  const s12 = await due({ ...base, machineRef: 'MC-01' }, 1);
  await applyDueSchedules();
  check((await MachineAssignment.countDocuments({ effectiveTo: null })) === 1,
    'a case-different ref closes the SAME machine, not a second one');
  check((await call(listSchedules, { user: OP, query: { unacked: '1' } })).some((r: any) => String(r._id) === String(s12._id)),
    'the operator popup finds it despite the case difference');

  // ── 12. deleting a dia takes its runs and its schedules with it ───────────
  await MachineAssignment.deleteMany({});
  await ScheduledAssignment.deleteMany({});
  const doomed = await DiaConfig.create({
    name: 'DIA-GONE', capacity: '', dims: '', active: true,
    stages: [{ key: 'cutting', name: 'Cutting', seq: 1, processingSec: 60, active: true }],
  });
  await call(assignMachine, { body: { machineRef: 'MC-01', diaId: String(doomed._id), stageKey: 'cutting' } });
  await call(createSchedule, { body: { machineRef: 'MC-01', diaId: String(doomed._id), stageKey: 'cutting', applyAt: ahead(60) } });
  await call(deleteDia, { params: { id: String(doomed._id) } })
    .then(() => check(false, 'an ACTIVE dia cannot be deleted'), () => check(true, 'an ACTIVE dia cannot be deleted'));
  await call(setDiaActive, { params: { id: String(doomed._id) }, body: { active: false } });
  const gone = await call(deleteDia, { params: { id: String(doomed._id) } });
  check(gone.deleted === true, 'a retired dia deletes even while machines still hold it');
  check((await MachineAssignment.countDocuments({ diaId: doomed._id })) === 0, 'its runs are gone (so it leaves Dia Trace)');
  check((await openRows('MC-01')) === 0, 'the machine that held it drops to no dia');
  check((await ScheduledAssignment.countDocuments({ diaId: doomed._id })) === 0, 'its schedules go with it');

  console.log(bad ? `\nFAIL: ${bad} check(s)` : '\nALL OK');
  await mongoose.disconnect();
  await mem.stop();
  process.exit(bad ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
