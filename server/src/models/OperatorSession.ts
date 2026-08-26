// server/src/models/OperatorSession.ts
// Who is running which machine, as a TIME-RANGED record — the handover flow.
// Starting a session closes the machine's open one, so the collection is its
// own history and report rows can be attributed to the person on the machine
// at the time. Nothing here touches production numbers; it only labels them.
import mongoose from 'mongoose';

export interface IOperatorSession {
  machineRef: string;
  userId: string;
  userName: string;                // denormalized — reports must survive user edits
  startedAt: Date;
  endedAt: Date | null;            // null = on the machine now
  startedBy?: { id?: string; name?: string };
}

const schema = new mongoose.Schema<IOperatorSession>(
  {
    machineRef: { type: String, required: true, index: true },
    userId: { type: String, required: true },
    userName: { type: String, required: true },
    startedAt: { type: Date, required: true },
    endedAt: { type: Date, default: null },
    startedBy: { id: String, name: String },
  },
  { collection: 'operator_sessions', versionKey: false, timestamps: true },
);
schema.index({ machineRef: 1, startedAt: -1 });

export const OperatorSession = mongoose.model<IOperatorSession>('OperatorSession', schema);
