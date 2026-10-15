// server/src/controllers/reportMail.controller.ts
// Reports → Email reports: who receives the review workbook, how often, and
// what it covers — plus "send it now", a test email, and the log of what went
// out. Reading needs report_mail.view; every change, a send and a test need
// report_mail.update (its own row under Reports on the Roles grid), and each
// change is in the audit log with its before and after. The sending itself is
// services/reportMail.
import { z } from 'zod';
import mongoose from 'mongoose';
import { ReportSchedule, FREQUENCIES, PERIODS, EVERY_HOURS, type IReportSchedule } from '../models/ReportSchedule.js';
import { ReportMailRun } from '../models/ReportMailRun.js';
import { AuditLog } from '../models/AuditLog.js';
import { ok, fail, asyncHandler } from '../utils/http.js';
import { isEmail } from '../utils/smtp.js';
import { loadShifts } from './config.controller.js';
import {
  nextRunAfter, windowFor, describeSchedule, subjectFor, mailStatus as status,
  deliver, sendTestEmail,
} from '../services/reportMail.service.js';
import type { AuthUser } from '../types/auth.js';

const MAX_SCHEDULES = 50;
const MAX_RECIPIENTS = 50;
const MANUAL_GAP_MS = 60_000;      // "Send now" twice in a minute is a double click
const HM_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

const body = z.object({
  name: z.string().trim().min(1, 'Give the email a name').max(80),
  enabled: z.boolean().default(true),
  to: z.array(z.string()).max(MAX_RECIPIENTS).default([]),
  cc: z.array(z.string()).max(MAX_RECIPIENTS).default([]),
  frequency: z.enum(FREQUENCIES),
  everyHours: z.number().int().refine((n) => (EVERY_HOURS as readonly number[]).includes(n), 'Every 1, 2, 3, 4, 6, 8, 12 or 24 hours').default(12),
  time: z.string().regex(HM_RE, 'A time as HH:MM').default('07:30'),
  weekday: z.number().int().min(0).max(6).default(1),
  monthDay: z.number().int().min(1).max(28).default(1),
  shifts: z.array(z.string().trim().min(1).max(40)).max(12).default([]),
  delayMin: z.number().int().min(0).max(180).default(10),
  period: z.enum(PERIODS).default('auto'),
  periodHours: z.number().int().min(1).max(168).default(12),
  machines: z.array(z.string().trim().min(1).max(80)).max(200).default([]),
  subject: z.string().max(150).default(''),
  message: z.string().max(2000).default(''),
  includeSummary: z.boolean().default(true),
  attachWorkbook: z.boolean().default(true),
  skipIfIdle: z.boolean().default(false),
});
type Body = z.infer<typeof body>;

/** Recipients: trimmed, each a real address, each once (case-insensitively). */
function addresses(list: string[]): { ok: string[]; bad: string[] } {
  const seen = new Set<string>();
  const out: string[] = [];
  const bad: string[] = [];
  for (const raw of list) {
    const a = String(raw || '').trim();
    if (!a) continue;
    if (!isEmail(a)) { bad.push(a); continue; }
    if (seen.has(a.toLowerCase())) continue;
    seen.add(a.toLowerCase());
    out.push(a);
  }
  return { ok: out, bad };
}

/** The request body as a schedule, or the one sentence that says what is wrong. */
function parse(raw: unknown): { value: Body } | { error: string } {
  const r = body.safeParse(raw);
  if (!r.success) {
    const i = r.error.issues[0];
    return { error: `${i.path.join('.') || 'body'}: ${i.message}` };
  }
  const v = r.data;
  const to = addresses(v.to);
  const cc = addresses(v.cc);
  const bad = [...to.bad, ...cc.bad];
  if (bad.length) return { error: `Not an email address: ${bad.slice(0, 5).join(', ')}` };
  // An address in both lists goes once, in To.
  const ccOnly = cc.ok.filter((a) => !to.ok.some((b) => b.toLowerCase() === a.toLowerCase()));
  if (!to.ok.length) return { error: 'Add at least one person to send it to' };
  if (to.ok.length + ccOnly.length > MAX_RECIPIENTS) return { error: `At most ${MAX_RECIPIENTS} people per email` };
  if (!v.includeSummary && !v.attachWorkbook) return { error: 'The email needs the summary, the workbook, or both' };
  return { value: { ...v, to: to.ok, cc: ccOnly, machines: [...new Set(v.machines.map((m) => m.toUpperCase()))] } };
}

const actor = (req: { user?: unknown }): { id: string; name: string } => {
  const u = req.user as AuthUser | undefined;
  return { id: u?._id ? String(u._id) : '', name: u?.name || u?.email || '' };
};

/** What the audit log keeps of a schedule — the fields a reviewer asks about. */
const auditView = (s: Partial<IReportSchedule>): Record<string, unknown> => ({
  name: s.name, enabled: s.enabled, to: s.to, cc: s.cc, frequency: s.frequency, everyHours: s.everyHours,
  time: s.time, weekday: s.weekday, monthDay: s.monthDay, shifts: s.shifts, delayMin: s.delayMin,
  period: s.period, periodHours: s.periodHours, machines: s.machines, attachWorkbook: s.attachWorkbook, includeSummary: s.includeSummary,
});

function audit(req: { user?: unknown }, action: string, id: string, label: string, before: Record<string, unknown> | null, after: Record<string, unknown> | null): void {
  AuditLog.create({ at: new Date(), user: actor(req), action, entity: { type: 'report_mail', id, label }, before, after }).catch(() => {});
}

type ShiftDef = { name: string; start: string; end: string };
/** A schedule as the screen shows it: the stored fields plus its sentences. */
function present(s: IReportSchedule & { _id: unknown }, shifts: ShiftDef[]): Record<string, unknown> {
  const next = s.enabled && s.nextRunAt ? +s.nextRunAt : null;
  const { due: _due, attempt: _attempt, claimedAt: _claimed, ...rest } = s as IReportSchedule & { _id: unknown; [k: string]: unknown };
  return {
    ...rest,
    describe: {
      ...describeSchedule(s, shifts),
      // The period the NEXT email covers — retries keep theirs.
      nextWindow: next ? windowFor(s, s.due ? +s.due : next, shifts).label : null,
      retrying: !!s.due,
    },
  };
}

// GET /report-mails
export const listSchedules = asyncHandler(async (_req, res) => {
  const [rows, shifts] = await Promise.all([ReportSchedule.find({}).sort({ createdAt: 1 }).lean(), loadShifts()]);
  return ok(res, rows.map((s) => present(s as IReportSchedule & { _id: unknown }, shifts)));
});

// GET /report-mails/status — the mail settings as the admin may see them
export const mailStatus = asyncHandler(async (_req, res) => ok(res, status()));

// GET /report-mails/preview?draft={…} — when a draft would send and what each
// email would cover, before anything is saved (a GET: it changes nothing, so
// it also works on the review copy).
export const previewSchedule = asyncHandler(async (req, res) => {
  let raw: unknown;
  try { raw = JSON.parse(String((req.query as Record<string, string>).draft || '{}')); } catch { return fail(res, 400, 'draft must be JSON'); }
  // A preview of an unfinished form: placeholder recipients and name, so the
  // timing can be shown before they are typed.
  const draft = { name: 'Preview', to: ['preview@example.com'], ...(raw as Record<string, unknown>) } as Record<string, unknown>;
  if (!Array.isArray(draft.to) || !(draft.to as unknown[]).length) draft.to = ['preview@example.com'];
  const p = parse(draft);
  if ('error' in p) return fail(res, 400, p.error);
  const shifts = await loadShifts();
  const now = Date.now();
  const next: { at: Date; window: ReturnType<typeof windowFor> }[] = [];
  for (let t = nextRunAfter(p.value, now, shifts); t !== null && next.length < 3; t = nextRunAfter(p.value, t, shifts)) {
    next.push({ at: new Date(t), window: windowFor(p.value, t, shifts) });
  }
  return ok(res, {
    describe: describeSchedule(p.value, shifts),
    next,
    subject: next[0] ? subjectFor(p.value, next[0].window, p.value.machines.length ? `${p.value.machines.length} machine${p.value.machines.length === 1 ? '' : 's'}` : 'All machines') : '',
  });
});

// GET /report-mails/runs?scheduleId=&limit= — what went out, newest first
export const listRuns = asyncHandler(async (req, res) => {
  const q = req.query as Record<string, string | undefined>;
  const filter: Record<string, unknown> = {};
  if (q.scheduleId) {
    if (!mongoose.isValidObjectId(q.scheduleId)) return fail(res, 400, 'scheduleId is not an id');
    filter.scheduleId = new mongoose.Types.ObjectId(q.scheduleId);
  }
  const limit = Math.min(200, Math.max(1, Number(q.limit) || 50));
  return ok(res, await ReportMailRun.find(filter).sort({ at: -1 }).limit(limit).lean());
});

// POST /report-mails
export const createSchedule = asyncHandler(async (req, res) => {
  const p = parse(req.body);
  if ('error' in p) return fail(res, 400, p.error);
  if (await ReportSchedule.countDocuments({}) >= MAX_SCHEDULES) return fail(res, 400, `At most ${MAX_SCHEDULES} scheduled emails`);
  const shifts = await loadShifts();
  const next = p.value.enabled ? nextRunAfter(p.value, Date.now(), shifts) : null;
  const who = actor(req);
  const doc = await ReportSchedule.create({ ...p.value, nextRunAt: next ? new Date(next) : null, createdBy: who, updatedBy: who });
  audit(req, 'report_mail.create', String(doc._id), doc.name, null, auditView(p.value));
  return ok(res, present(doc.toObject() as IReportSchedule & { _id: unknown }, shifts));
});

// PUT /report-mails/:id
export const updateSchedule = asyncHandler(async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return fail(res, 404, 'Scheduled email not found');
  const p = parse(req.body);
  if ('error' in p) return fail(res, 400, p.error);
  const before = await ReportSchedule.findById(req.params.id).lean();
  if (!before) return fail(res, 404, 'Scheduled email not found');
  const shifts = await loadShifts();
  const next = p.value.enabled ? nextRunAfter(p.value, Date.now(), shifts) : null;
  // A changed schedule starts afresh: no retry of the old timing, and a run in
  // flight finds its claim gone and leaves the new timing alone.
  const after = await ReportSchedule.findByIdAndUpdate(req.params.id, { $set: {
    ...p.value, nextRunAt: next ? new Date(next) : null, due: null, attempt: 0, claimedAt: null, updatedBy: actor(req),
  } }, { new: true }).lean();
  if (!after) return fail(res, 404, 'Scheduled email not found');
  audit(req, 'report_mail.update', String(after._id), after.name, auditView(before), auditView(p.value));
  return ok(res, present(after as IReportSchedule & { _id: unknown }, shifts));
});

// DELETE /report-mails/:id
export const deleteSchedule = asyncHandler(async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return fail(res, 404, 'Scheduled email not found');
  const gone = await ReportSchedule.findByIdAndDelete(req.params.id).lean();
  if (!gone) return fail(res, 404, 'Scheduled email not found');
  audit(req, 'report_mail.delete', String(gone._id), gone.name, auditView(gone), null);
  return ok(res, { deleted: true });
});

// POST /report-mails/:id/send — this email, now, for the period it would cover
// if it were due this minute. The schedule's own timing is not touched.
export const sendNow = asyncHandler(async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return fail(res, 404, 'Scheduled email not found');
  const s = await ReportSchedule.findById(req.params.id).lean();
  if (!s) return fail(res, 404, 'Scheduled email not found');
  const recent = await ReportMailRun.exists({ scheduleId: s._id, trigger: 'manual', at: { $gte: new Date(Date.now() - MANUAL_GAP_MS) } });
  if (recent) return fail(res, 429, 'This email was just sent — wait a minute before sending it again');
  const who = actor(req);
  const out = await deliver(s as IReportSchedule & { _id: unknown }, Date.now(), 'manual', who);
  await ReportSchedule.updateOne({ _id: s._id }, { $set: {
    lastRun: { at: new Date(), status: out.status, detail: `${out.detail} (sent now by ${who.name || 'hand'})`, recipients: out.accepted || s.to.length + s.cc.length },
  } });
  audit(req, 'report_mail.send', String(s._id), s.name, null, { status: out.status, detail: out.detail });
  if (out.status === 'failed') return fail(res, 502, out.detail);
  return ok(res, out);
});

// POST /report-mails/test { to? } — a short email that proves the settings,
// to the address given or the signed-in person's own.
export const sendTest = asyncHandler(async (req, res) => {
  const u = req.user as AuthUser | undefined;
  const to = String((req.body as { to?: string } | undefined)?.to || u?.email || '').trim();
  if (!isEmail(to)) return fail(res, 400, to ? `Not an email address: ${to}` : 'Type the address to send the test to');
  const out = await sendTestEmail(to, actor(req));
  if (out.status === 'failed') return fail(res, 502, out.detail);
  return ok(res, out);
});
