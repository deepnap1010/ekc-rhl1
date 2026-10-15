// server/src/models/ReportSchedule.ts
// A report email the admin has set up: the review workbook (the file Export
// Excel downloads), for a period, mailed to the people they picked, on the
// plant's clock. Sent by services/reportMail; managed on Reports → Email
// reports by whoever holds report_mail on the Roles grid.
import mongoose from 'mongoose';

// How often it goes out.
//   shift   — a set time after each shift ends (Shift A ends 15:00 → 15:10)
//   hours   — every N hours from a starting time (12 → 07:00 and 19:00)
//   daily · weekly · monthly — at a time of day (on a weekday / a date)
export const FREQUENCIES = ['shift', 'hours', 'daily', 'weekly', 'monthly'] as const;
export type Frequency = typeof FREQUENCIES[number];
// Hours that divide the day, so a cycle lands on the same clock times daily.
export const EVERY_HOURS = [1, 2, 3, 4, 6, 8, 12, 24] as const;

// What the report covers. 'auto' = what the frequency implies: the shift that
// just ended, the hours since the last email, the previous production day,
// the last 7 days, the previous month.
export const PERIODS = ['auto', 'shift', 'hours', 'day', 'today', 'week', 'month_to_date', 'month'] as const;
export type Period = typeof PERIODS[number];

export type RunStatus = 'sent' | 'failed' | 'skipped';

export interface IReportSchedule {
  name: string;
  enabled: boolean;
  to: string[];
  cc: string[];
  frequency: Frequency;
  everyHours: number;      // 'hours': one of EVERY_HOURS
  time: string;            // 'HH:MM' plant clock — the send time, or the first send of an 'hours' cycle
  weekday: number;         // 'weekly': 0 = Sunday … 6 = Saturday
  monthDay: number;        // 'monthly': 1–28, so every month has it
  shifts: string[];        // 'shift': which shifts' ends; [] = every shift
  delayMin: number;        // 'shift': minutes after the shift ends
  period: Period;
  periodHours: number;     // period 'hours' under another frequency
  machines: string[];      // [] = all machines
  subject: string;         // '' = the default
  message: string;         // a note at the top of the email
  includeSummary: boolean; // the cover's figures in the email body
  attachWorkbook: boolean;
  skipIfIdle: boolean;     // nothing made and nothing ran → no email
  // The runner's bookkeeping.
  nextRunAt: Date | null;  // null = paused, or nothing to schedule
  due: Date | null;        // the moment being retried, so a retry keeps its period
  attempt: number;
  claimedAt: Date | null;
  lastRun: { at: Date; status: RunStatus; detail: string; recipients: number } | null;
  createdBy: { id?: string; name?: string };
  updatedBy: { id?: string; name?: string };
}

const who = { id: String, name: String };
const lastRunSchema = new mongoose.Schema(
  { at: Date, status: String, detail: String, recipients: Number },
  { _id: false },
);

const schema = new mongoose.Schema<IReportSchedule>(
  {
    name: { type: String, required: true, trim: true },
    enabled: { type: Boolean, default: true },
    to: { type: [String], default: [] },
    cc: { type: [String], default: [] },
    frequency: { type: String, enum: FREQUENCIES, required: true },
    everyHours: { type: Number, default: 12 },
    time: { type: String, default: '07:30' },
    weekday: { type: Number, default: 1 },
    monthDay: { type: Number, default: 1 },
    shifts: { type: [String], default: [] },
    delayMin: { type: Number, default: 10 },
    period: { type: String, enum: PERIODS, default: 'auto' },
    periodHours: { type: Number, default: 12 },
    machines: { type: [String], default: [] },
    subject: { type: String, default: '' },
    message: { type: String, default: '' },
    includeSummary: { type: Boolean, default: true },
    attachWorkbook: { type: Boolean, default: true },
    skipIfIdle: { type: Boolean, default: false },
    nextRunAt: { type: Date, default: null },
    due: { type: Date, default: null },
    attempt: { type: Number, default: 0 },
    claimedAt: { type: Date, default: null },
    lastRun: { type: lastRunSchema, default: null },
    createdBy: who,
    updatedBy: who,
  },
  { collection: 'report_schedules', timestamps: true, versionKey: false },
);
// The runner's question every minute: what is due?
schema.index({ enabled: 1, nextRunAt: 1 });

export const ReportSchedule = mongoose.model<IReportSchedule>('ReportSchedule', schema);
