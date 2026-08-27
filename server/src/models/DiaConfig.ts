// server/src/models/DiaConfig.ts
// A DIA product (capacity + dimensions) with its production stages. Each stage
// carries the processing time per unit, in INTEGER SECONDS — targets divide
// cleanly out of seconds where decimal minutes would drift.
//
// Editing a DIA never changes what any machine is currently held to: machines
// run on the frozen snapshot inside their MachineAssignment until a supervisor
// re-assigns. That is what keeps historical reports immutable.
import mongoose from 'mongoose';

export interface IDiaStage {
  key: string;           // stable slug — survives renames
  name: string;          // "Cutting"
  seq: number;           // display order
  processingSec: number; // per unit
  active: boolean;
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
    processingSec: { type: Number, required: true, min: 1, max: 86_400 },
    active: { type: Boolean, default: true },
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
