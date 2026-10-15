// server/src/models/ReportMailRun.ts
// Every report email the server tried to send — scheduled, sent by hand, or a
// test — with what it covered, who took it and what went wrong. What the
// admin reads on Reports → Email reports → History. Kept for six months.
import mongoose from 'mongoose';
import type { RunStatus } from './ReportSchedule.js';

export type RunTrigger = 'schedule' | 'manual' | 'test';

export interface IReportMailRun {
  scheduleId: mongoose.Types.ObjectId | null;
  name: string;
  trigger: RunTrigger;
  due: Date | null;          // the moment it was for (a scheduled run), else when it was asked
  at: Date;                  // when it finished
  status: RunStatus;
  detail: string;
  to: string[];
  cc: string[];
  accepted: string[];
  rejected: { address: string; reason: string }[];
  window: { from: Date; to: Date; label: string } | null;
  file: string;
  bytes: number;
  durationMs: number;
  by: { id?: string; name?: string };
}

const windowSchema = new mongoose.Schema({ from: Date, to: Date, label: String }, { _id: false });

const schema = new mongoose.Schema<IReportMailRun>(
  {
    scheduleId: { type: mongoose.Schema.Types.ObjectId, default: null },
    name: { type: String, default: '' },
    trigger: { type: String, required: true },
    due: { type: Date, default: null },
    at: { type: Date, required: true },
    status: { type: String, required: true },
    detail: { type: String, default: '' },
    to: { type: [String], default: [] },
    cc: { type: [String], default: [] },
    accepted: { type: [String], default: [] },
    rejected: { type: [{ address: String, reason: String, _id: false }], default: [] },
    window: { type: windowSchema, default: null },
    file: { type: String, default: '' },
    bytes: { type: Number, default: 0 },
    durationMs: { type: Number, default: 0 },
    by: { id: String, name: String },
  },
  { collection: 'report_mail_runs', versionKey: false },
);
schema.index({ scheduleId: 1, at: -1 });
schema.index({ at: 1 }, { expireAfterSeconds: 180 * 86_400 });

export const ReportMailRun = mongoose.model<IReportMailRun>('ReportMailRun', schema);
