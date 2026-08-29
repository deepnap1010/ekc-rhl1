// server/src/models/ScheduledAssignment.ts
// A dia assignment that hasn't happened yet: "from tomorrow 07:00, this machine
// runs DM 20 X 40". A ticker applies it at its time by writing a NORMAL
// MachineAssignment (snapshot frozen at apply time, audited) — so once applied,
// nothing downstream knows or cares that it was scheduled.
//
// The row doubles as the operator's notice: it stays on their dashboard until
// they acknowledge it, and each ack lands in `acks` so the popup is per-person,
// not per-browser.
import mongoose from 'mongoose';

export type ScheduleStatus = 'pending' | 'applied' | 'cancelled' | 'failed';

export interface IScheduledAssignment {
  machineRef: string;                 // Machine.code, exactly as the app uses it
  diaId: mongoose.Types.ObjectId;
  diaName: string;                    // denormalised for lists + notices
  stageKey: string;
  stageName: string;
  applyAt: Date;                      // the intended switch moment
  status: ScheduleStatus;
  claimedAt?: Date | null;            // an apply is in progress since this instant
  reason?: string;                    // why it failed / was skipped as duplicate
  appliedAt?: Date | null;
  createdBy?: { id?: string; name?: string };
  cancelledBy?: { id?: string; name?: string };
  acks: { userId: string; name?: string; at: Date }[];
  note?: string;
}

const schema = new mongoose.Schema<IScheduledAssignment>(
  {
    machineRef: { type: String, required: true, index: true },
    diaId: { type: mongoose.Schema.Types.ObjectId, ref: 'DiaConfig', required: true },
    diaName: { type: String, required: true },
    stageKey: { type: String, required: true },
    stageName: { type: String, required: true },
    applyAt: { type: Date, required: true },
    status: { type: String, enum: ['pending', 'applied', 'cancelled', 'failed'], default: 'pending', index: true },
    claimedAt: { type: Date, default: null },
    reason: { type: String, default: '' },
    appliedAt: { type: Date, default: null },
    createdBy: { id: String, name: String },
    cancelledBy: { id: String, name: String },
    acks: [{ userId: String, name: String, at: Date }],
    note: { type: String, default: '' },
  },
  { collection: 'scheduled_assignments', versionKey: false, timestamps: true },
);
schema.index({ status: 1, applyAt: 1 });      // the ticker's query
schema.index({ machineRef: 1, applyAt: -1 });

export const ScheduledAssignment = mongoose.model<IScheduledAssignment>('ScheduledAssignment', schema);
