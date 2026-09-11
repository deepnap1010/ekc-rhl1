// server/src/models/DiaConfig.ts
// A DIA product (capacity + dimensions) with its production stages. Each stage
// carries the processing time per unit, in INTEGER SECONDS — targets divide
// cleanly out of seconds where decimal minutes would drift.
//
// Machines run on the frozen snapshot inside their MachineAssignment. Editing a
// dia's cycle time re-times the machines currently running it from that moment
// (their open row closes, a new one opens); closed rows are never touched, and
// that is what keeps historical reports immutable.
import mongoose from 'mongoose';

export interface IMachineTime {
  machineRef: string;    // Machine.code, upper-cased
  processingSec: number; // per unit, on THIS machine
}

export interface IDiaStage {
  key: string;           // stable slug — survives renames
  name: string;          // "Cutting"
  seq: number;           // display order
  // Default per unit. 0 = no default: the stage is machine-specific only, and
  // a machine without its own time below cannot be assigned this dia.
  processingSec: number;
  active: boolean;
  // The same dia cuts faster on one machine than another — the machine's own
  // time wins over the default (utils/cycleTime.ts is the one resolver).
  machineTimes?: IMachineTime[];
}

export interface IDiaConfig {
  name: string;          // "40L" — unique
  capacity: string;      // "40L"
  dims: string;          // "316 × 40" — the plant's own notation, free text
  active: boolean;
  retiredAt?: Date | null;   // set on retire, cleared on restore
  stages: IDiaStage[];
  createdBy?: { id?: string; name?: string };
  updatedBy?: { id?: string; name?: string };
}

const stageSchema = new mongoose.Schema<IDiaStage>(
  {
    key: { type: String, required: true },
    name: { type: String, required: true },
    seq: { type: Number, required: true },
    processingSec: { type: Number, required: true, min: 0, max: 86_400 },
    active: { type: Boolean, default: true },
    machineTimes: {
      type: [new mongoose.Schema<IMachineTime>(
        { machineRef: { type: String, required: true }, processingSec: { type: Number, required: true, min: 1, max: 86_400 } },
        { _id: false },
      )],
      default: undefined,
    },
  },
  { _id: false },
);

const diaSchema = new mongoose.Schema<IDiaConfig>(
  {
    name: { type: String, required: true, unique: true, trim: true },
    capacity: { type: String, default: '', trim: true },
    dims: { type: String, default: '', trim: true },
    active: { type: Boolean, default: true },
    retiredAt: { type: Date, default: null },
    stages: { type: [stageSchema], default: [] },
    createdBy: { id: String, name: String },
    updatedBy: { id: String, name: String },
  },
  { collection: 'dia_configs', versionKey: false, timestamps: true },
);

export const DiaConfig = mongoose.model<IDiaConfig>('DiaConfig', diaSchema);
