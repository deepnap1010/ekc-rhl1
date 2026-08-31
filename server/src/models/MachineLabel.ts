// server/src/models/MachineLabel.ts
// The name people call a machine, as opposed to the name it answers to.
//
// A supervisor renames CUTTINGMACHINE04 to "PC04" because that is what it is
// called on the floor. The PLC still posts as CUTTINGMACHINE04, every telemetry
// row and every historical assignment is still keyed by it, and nothing here
// touches any of that — this collection holds a label and nothing else.
//
// It lives server-side, not in a browser, because the whole point is that one
// name reaches everyone: the plant head, the supervisor and the operator all
// have to read the same board. Kept OUT of the `machines` collection on
// purpose — that one mirrors the factory's own system and is not ours to write.
import mongoose from 'mongoose';

export interface IMachineLabel {
  machineRef: string;                  // the machine's REAL code, never the label
  displayName: string;
  updatedBy?: { id?: string; name?: string };
}

const schema = new mongoose.Schema<IMachineLabel>(
  {
    machineRef: { type: String, required: true, unique: true, index: true },
    displayName: { type: String, required: true, maxlength: 60 },
    updatedBy: { id: String, name: String },
  },
  { collection: 'machine_labels', versionKey: false, timestamps: true },
);

export const MachineLabel = mongoose.model<IMachineLabel>('MachineLabel', schema);
