// server/src/models/MachineAssignment.ts
// Which DIA + stage a machine is running, as a TIME-RANGED record. Assigning
// closes the machine's open row and inserts a new one, so the collection IS the
// assignment history — "what was this machine's target at 10:40 last Tuesday?"
// is answered by the row whose range covers that instant.
//
// The snapshot is frozen at assignment time. Editing the DIA afterwards reaches
// nothing here; a supervisor rolls a new time out by re-assigning (explicit,
// audited). That single decision is what makes historical reports immutable.
import mongoose from 'mongoose';

export interface IAssignmentSnapshot {
  diaName: string;
  capacity: string;
  dims: string;
  stageName: string;
  processingSec: number;
}

export interface IMachineAssignment {
  machineRef: string;                 // Machine.code, exactly as the app uses it
  diaId: mongoose.Types.ObjectId;
  stageKey: string;
  snapshot: IAssignmentSnapshot;
  effectiveFrom: Date;
  effectiveTo: Date | null;           // null = the machine's current assignment
  assignedBy?: { id?: string; name?: string };
  note?: string;
}

const schema = new mongoose.Schema<IMachineAssignment>(
  {
    machineRef: { type: String, required: true, index: true },
    diaId: { type: mongoose.Schema.Types.ObjectId, ref: 'DiaConfig', required: true, index: true },
    stageKey: { type: String, required: true },
    snapshot: {
      diaName: String, capacity: String, dims: String, stageName: String,
      processingSec: { type: Number, required: true },
    },
    effectiveFrom: { type: Date, required: true },
    effectiveTo: { type: Date, default: null },
    assignedBy: { id: String, name: String },
    note: { type: String, default: '' },
  },
  { collection: 'machine_assignments', versionKey: false, timestamps: true },
);
schema.index({ machineRef: 1, effectiveFrom: -1 });

export const MachineAssignment = mongoose.model<IMachineAssignment>('MachineAssignment', schema);
