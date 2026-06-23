// server/src/models/DowntimeEvent.ts
// Records each idle/stopped span. Closed when machine resumes.
import mongoose from 'mongoose';

export interface IDowntimeEvent {
  machineId: string;
  type: 'idle' | 'stopped' | 'offline';
  startedAt: Date;
  endedAt: Date | null; // null = ongoing
  durationMs: number;
  reason: string;       // operator-reported reason
  reportedBy: string;
  acknowledged: boolean;       // supervisor reviewed/accepted this event
  acknowledgedBy: string;
  acknowledgedAt: Date | null;
}

const downtimeSchema = new mongoose.Schema<IDowntimeEvent>(
  {
    machineId: { type: String, required: true, index: true },
    type: { type: String, enum: ['idle', 'stopped', 'offline'], required: true },
    startedAt: { type: Date, required: true },
    endedAt: { type: Date, default: null }, // null = ongoing
    durationMs: { type: Number, default: 0 },
    reason: { type: String, default: '' },  // operator-reported reason
    reportedBy: { type: String, default: '' },
    acknowledged: { type: Boolean, default: false, index: true },
    acknowledgedBy: { type: String, default: '' },
    acknowledgedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

// Indexes tuned for the Downtime page at production scale (millions of spans):
downtimeSchema.index({ machineId: 1, startedAt: -1 });                  // per-machine history
downtimeSchema.index({ startedAt: -1 });                                // default list sort + time-window range scans
downtimeSchema.index({ type: 1, startedAt: -1 });                       // type filter + sort
downtimeSchema.index({ startedAt: -1 }, { name: 'open_events_idx', partialFilterExpression: { endedAt: null } }); // fast "open events" lookup (only open spans)

export const DowntimeEvent = mongoose.model<IDowntimeEvent>('DowntimeEvent', downtimeSchema, 'downtime_reports');
