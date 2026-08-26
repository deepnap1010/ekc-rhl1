// server/src/models/AuditLog.ts
// Who changed what in the production configuration — one row per mutation,
// written by the same controller that performs it. Because supervisors can
// change what a machine is held to, every change carries its author, its
// moment, and the before/after of the fields that moved.
import mongoose from 'mongoose';

export interface IAuditLog {
  at: Date;
  user: { id?: string; name?: string };
  action: string;                       // 'dia.create' | 'dia.update' | 'assignment.create' | ...
  entity: { type: string; id?: string; label?: string };
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
}

const schema = new mongoose.Schema<IAuditLog>(
  {
    at: { type: Date, required: true, index: true },
    user: { id: String, name: String },
    action: { type: String, required: true },
    entity: { type: { type: String }, id: String, label: String },
    before: { type: mongoose.Schema.Types.Mixed, default: null },
    after: { type: mongoose.Schema.Types.Mixed, default: null },
  },
  { collection: 'audit_log', versionKey: false },
);

export const AuditLog = mongoose.model<IAuditLog>('AuditLog', schema);
