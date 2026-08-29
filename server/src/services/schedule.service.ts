// server/src/services/schedule.service.ts
// Applies due dia schedules. Every 30s (and once at startup, so schedules that
// came due while the server was down still land), each pending row whose
// applyAt has passed becomes a NORMAL MachineAssignment: close the machine's
// open row, insert the new one with the snapshot frozen from the dia's
// CURRENT rates — exactly as if a supervisor had clicked Assign at that moment.
//
// effectiveFrom is the SCHEDULED time, not the tick time: if the server was
// down over 07:00 and applies at 09:00, production since 07:00 still counts
// under the new dia — that was the instruction.
//
// Two invariants this file exists to hold:
//   · ONE run at a time, and one open assignment per machine. The ticker and
//     every schedule-list request ask for a run, so overlapping runs are
//     routine; interleaved close-then-create would leave a machine with two
//     "current" dias and double its target for good.
//   · A claim is not an outcome. Claiming stamps claimedAt and leaves the row
//     pending; only a finished apply writes applied/failed. A crash in between
//     therefore retries instead of vanishing.
import { ScheduledAssignment, type IScheduledAssignment } from '../models/ScheduledAssignment.js';
import { MachineAssignment } from '../models/MachineAssignment.js';
import { DiaConfig } from '../models/DiaConfig.js';
import { AuditLog } from '../models/AuditLog.js';
import { refMatch } from '../utils/machineRef.js';

/** A claim older than this is treated as abandoned (the process died holding it). */
const STALE_CLAIM_MS = 120_000;

let inFlight: Promise<number> | null = null;

/** Apply every due pending schedule, oldest first. Concurrent callers join the
 *  run already in progress rather than starting a second one. */
export function applyDueSchedules(): Promise<number> {
  if (!inFlight) inFlight = runDue().finally(() => { inFlight = null; });
  return inFlight;
}

async function runDue(): Promise<number> {
  let n = 0;
  for (let guard = 0; guard < 200; guard += 1) {     // runaway backstop
    const now = new Date();
    const s = await ScheduledAssignment.findOneAndUpdate(
      {
        status: 'pending',
        applyAt: { $lte: now },
        $or: [{ claimedAt: null }, { claimedAt: { $lt: new Date(now.getTime() - STALE_CLAIM_MS) } }],
      },
      { $set: { claimedAt: now } },
      { sort: { applyAt: 1 }, new: true },
    );
    if (!s) return n;
    n += 1;
    try {
      await applyOne(s);
    } catch (e) {
      // Deliberately left pending: an unexpected failure (DB blip, restart,
      // quota) must be retried, never silently swallowed. The stale-claim
      // window keeps it out of a hot loop until a later tick.
      console.error(`[schedule] ${s.machineRef} → ${s.diaName} apply failed, will retry:`, e);
    }
  }
  return n;
}

async function applyOne(s: IScheduledAssignment & { _id: unknown }): Promise<void> {
  const finish = async (patch: Record<string, unknown>): Promise<void> => {
    await ScheduledAssignment.updateOne({ _id: s._id }, { $set: patch });
  };

  const dia = await DiaConfig.findById(s.diaId).lean();
  if (!dia) return finish({ status: 'failed', reason: 'the dia was deleted before this could apply' });
  if (!dia.active) return finish({ status: 'failed', reason: `"${dia.name}" was retired before this could apply` });
  const stage = dia.stages.find((st) => st.key === s.stageKey && st.active);
  if (!stage) return finish({ status: 'failed', reason: `stage "${s.stageName}" is no longer active on "${dia.name}"` });

  const where = { machineRef: refMatch(s.machineRef), effectiveTo: null };
  const open = await MachineAssignment.findOne(where).sort({ effectiveFrom: -1 }).lean();

  // Already on exactly this dia + stage → nothing to churn. This is also what
  // makes a retry after a crash idempotent: the assignment this schedule
  // already created is recognised as its own work.
  if (open && String(open.diaId) === String(dia._id) && open.stageKey === stage.key) {
    return finish({ status: 'applied', appliedAt: new Date(), reason: 'the machine was already running this dia' });
  }

  // Someone assigned this machine AFTER the scheduled moment. A human acting
  // later is later information — the schedule defers to them instead of
  // reversing a decision taken with the floor in view.
  if (open && +new Date(open.effectiveFrom) >= s.applyAt.getTime()) {
    return finish({
      status: 'failed',
      reason: `superseded — "${open.snapshot?.diaName}" was assigned after the scheduled time`,
    });
  }

  const from = s.applyAt;
  // updateMany, not findOneAndUpdate: if an older race ever left a phantom open
  // row, this is where it stops being current.
  await MachineAssignment.updateMany(where, { $set: { effectiveTo: from } });

  const doc = await MachineAssignment.create({
    machineRef: s.machineRef, diaId: dia._id, stageKey: stage.key,
    snapshot: {
      diaName: dia.name, capacity: dia.capacity, dims: dia.dims,
      stageName: stage.name, processingSec: stage.processingSec,
    },
    effectiveFrom: from, effectiveTo: null,
    assignedBy: { id: s.createdBy?.id, name: s.createdBy?.name },
    note: 'scheduled',
  });
  await finish({ status: 'applied', appliedAt: new Date() });

  AuditLog.create({
    at: new Date(),
    user: { id: s.createdBy?.id, name: s.createdBy?.name },
    action: 'assignment.create',
    entity: { type: 'assignment', id: String(doc._id), label: `${s.machineRef} → ${dia.name} / ${stage.name} (scheduled)` },
    before: open ? { diaName: open.snapshot?.diaName, stageName: open.snapshot?.stageName, processingSec: open.snapshot?.processingSec } : null,
    after: { diaName: dia.name, stageName: stage.name, processingSec: stage.processingSec, scheduledFor: s.applyAt.toISOString() },
  }).catch(() => {});
  console.log(`[schedule] ${s.machineRef} → ${dia.name} / ${stage.name} (due ${s.applyAt.toISOString()})`);
}

let timer: NodeJS.Timeout | null = null;

export function startScheduleTicker(): void {
  applyDueSchedules().catch((e) => console.error('[schedule] startup apply failed:', e));
  timer = setInterval(() => {
    applyDueSchedules().catch((e) => console.error('[schedule] tick failed:', e));
  }, 30_000);
}

export function stopScheduleTicker(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
