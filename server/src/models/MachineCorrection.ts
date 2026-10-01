// server/src/models/MachineCorrection.ts
// A correction to what the telemetry says about a machine over a period —
// the error-correction book. The PLC's figures are never edited: a correction
// is a separate, signed, revocable record that says "between FROM and TO this
// machine was <state> and made <pieces>", and every figure the app shows for a
// window that overlaps the period (cards, reports, targets, the Excel review)
// uses the correction for that period instead of the recorded data. The case
// it exists for: the collector started at noon, the machine had been running
// since seven and had 50 pieces on the floor that nothing counted.
//
// Nothing is deleted — a wrong correction is REVOKED and stays in the book
// with who revoked it and when, because a figure that changed twice must be
// explainable twice.
import mongoose from 'mongoose';

export type CorrectionState = 'running' | 'idle' | 'stopped';
/** How the period's time really divided — the card's own tiles, as amounts.
 *  What the three do not add up to is time nobody can account for: signal
 *  lost, exactly as the engines book silence. */
export interface CorrectionTime { runningMs: number; idleMs: number; stoppedMs: number }
export interface IMachineCorrection {
  machineRef: string;                // Machine.code, exactly as the app uses it
  from: Date;
  to: Date;
  time: CorrectionTime | null;       // the period's time split — null = as recorded
  state: CorrectionState | null;     // older rows: the WHOLE period in one state (time wins when both exist)
  pieces: number | null;             // pieces actually made in the period — null = as recorded
  downtimeReason: string;            // for an idle/stopped period: the reason the review sheets file it under
  reason: string;                    // why the correction is being made (required)
  createdBy: { id: string; name: string };
  createdAt: Date;
  revokedAt: Date | null;
  revokedBy: { id: string; name: string } | null;
  revokeReason: string;
}

const who = new mongoose.Schema({ id: { type: String, default: '' }, name: { type: String, default: '' } }, { _id: false });

const schema = new mongoose.Schema<IMachineCorrection>(
  {
    machineRef: { type: String, required: true, index: true },
    from: { type: Date, required: true },
    to: { type: Date, required: true },
    time: { type: new mongoose.Schema({ runningMs: { type: Number, default: 0 }, idleMs: { type: Number, default: 0 }, stoppedMs: { type: Number, default: 0 } }, { _id: false }), default: null },
    state: { type: String, enum: ['running', 'idle', 'stopped', null], default: null },
    pieces: { type: Number, default: null },
    downtimeReason: { type: String, default: '' },
    reason: { type: String, required: true },
    createdBy: { type: who, required: true },
    createdAt: { type: Date, required: true },
    revokedAt: { type: Date, default: null },
    revokedBy: { type: who, default: null },
    revokeReason: { type: String, default: '' },
  },
  { collection: 'machine_corrections', versionKey: false },
);
schema.index({ machineRef: 1, from: 1 });
schema.index({ from: 1 });

export const MachineCorrection = mongoose.model<IMachineCorrection>('MachineCorrection', schema);
