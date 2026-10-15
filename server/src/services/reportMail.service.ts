// server/src/services/reportMail.service.ts
// Scheduled report emails: the review workbook — the very file Export Excel
// downloads (controllers/export#buildWorkbook) — mailed to the people the
// admin picked, on the plant's clock (IST, the workbook's own).
//
// Every minute the ticker CLAIMS a due schedule in one atomic update, so two
// processes can never send it twice (a deploy's overlap, a restart mid-run);
// works out the period from the run's DUE moment, not from when it happens to
// run — an email held up by a restart still reports the shift it was for;
// builds the workbook; mails it; and logs the attempt (models/ReportMailRun).
// A send that fails for a passing reason (network, firewall, server busy) is
// tried again 5, 15 and 45 minutes later for the same period; a wrong password
// or a missing setting is not retried — it is logged for the admin to fix. A
// server that was off through several due moments sends the latest one once,
// not a burst.
//
// Never on the review copy (READ_ONLY): it mirrors this database, schedules
// included, and would mail every report a second time.
import { env } from '../config/env.js';
import { ReportSchedule, type IReportSchedule, type RunStatus } from '../models/ReportSchedule.js';
import { ReportMailRun, type RunTrigger } from '../models/ReportMailRun.js';
import { loadShifts } from '../controllers/config.controller.js';
import { buildWorkbook, PLANT_TZ_MIN, type WorkbookDigest } from '../controllers/export.controller.js';
import { bucketOf, dayStartMs, shiftLengthSec } from './plantReport.service.js';
import { sendMail, MailError, RETRYABLE, type SmtpConfig } from '../utils/smtp.js';
import { errMessage } from '../utils/http.js';

type ShiftDef = { name: string; start: string; end: string };
/** What the clock arithmetic needs of a schedule — a saved one or a draft. */
export type ScheduleShape = Pick<IReportSchedule,
  'frequency' | 'everyHours' | 'time' | 'weekday' | 'monthDay' | 'shifts' | 'delayMin' | 'period' | 'periodHours'>;
type Who = { id?: string; name?: string };

const MIN = 60_000;
const HOUR = 60 * MIN;
const TZ_MS = PLANT_TZ_MIN * MIN;
const TICK_MS = 60_000;
const STALE_CLAIM_MS = 15 * MIN;              // a month's workbook can take a while to build
const RETRY_MIN = [5, 15, 45];
const MAX_ATTACH_BYTES = 15 * 1024 * 1024;    // most mail servers take 20–25 MB, base64 adds a third
const XLSX_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

// ── the plant clock ──────────────────────────────────────────────────────────
const pad = (n: number): string => String(n).padStart(2, '0');
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
export const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const hm = (s: string): [number, number] => {
  const [h, m] = String(s || '').split(':').map(Number);
  return [Number.isFinite(h) ? Math.min(23, Math.max(0, h)) : 0, Number.isFinite(m) ? Math.min(59, Math.max(0, m)) : 0];
};
/** An instant's plant-clock calendar date. */
const plantDate = (t: number): { y: number; m: number; d: number; dow: number } => {
  const x = new Date(t + TZ_MS);
  return { y: x.getUTCFullYear(), m: x.getUTCMonth(), d: x.getUTCDate(), dow: x.getUTCDay() };
};
/** The instant of plant-clock y-m-d hh:mm (m 0-based; overflowing days roll over). */
const plantAt = (y: number, m: number, d: number, [h, mi]: [number, number]): number => Date.UTC(y, m, d, h, mi) - TZ_MS;
const clock = (t: number): string => { const x = new Date(t + TZ_MS); return `${pad(x.getUTCHours())}:${pad(x.getUTCMinutes())}`; };
const dayText = (t: number, year = true): string => {
  const x = new Date(t + TZ_MS);
  return `${x.getUTCDate()} ${MONTHS[x.getUTCMonth()]}${year ? ` ${x.getUTCFullYear()}` : ''}`;
};
const stampText = (t: number): string => `${dayText(t, false)} ${clock(t)}`;
// Production days ("YYYY-MM-DD"): they roll at the first shift's start, and a
// night shift belongs to the day it started — plantReport's own rules.
const isoDay = (t: number): string => { const x = new Date(t); return `${x.getUTCFullYear()}-${pad(x.getUTCMonth() + 1)}-${pad(x.getUTCDate())}`; };
const dayUtc = (day: string): number => Date.UTC(Number(day.slice(0, 4)), Number(day.slice(5, 7)) - 1, Number(day.slice(8, 10)));
const addDays = (day: string, n: number): string => isoDay(dayUtc(day) + n * 86_400_000);
const monthFirst = (day: string, delta = 0): string => isoDay(Date.UTC(Number(day.slice(0, 4)), Number(day.slice(5, 7)) - 1 + delta, 1));
const dayLabel = (day: string): string => { const t = dayUtc(day); const x = new Date(t); return `${x.getUTCDate()} ${MONTHS[x.getUTCMonth()]} ${x.getUTCFullYear()}`; };
const andList = (xs: string[]): string => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);
const ordinal = (n: number): string => `${n}${n % 10 === 1 && n % 100 !== 11 ? 'st' : n % 10 === 2 && n % 100 !== 12 ? 'nd' : n % 10 === 3 && n % 100 !== 13 ? 'rd' : 'th'}`;

const shiftPool = (s: ScheduleShape, shifts: ShiftDef[]): ShiftDef[] => {
  const picked = s.shifts?.length ? shifts.filter((x) => s.shifts.includes(x.name)) : [];
  return picked.length ? picked : shifts;
};

/** The first send strictly after `after`, or null when there is none (no shifts). */
export function nextRunAfter(s: ScheduleShape, after: number, shifts: ShiftDef[]): number | null {
  const { y, m, d } = plantDate(after);
  switch (s.frequency) {
    case 'shift': {
      let best = Infinity;
      for (const sh of shiftPool(s, shifts)) {
        for (let k = -1; k <= 2; k += 1) {
          const t = plantAt(y, m, d + k, hm(sh.end)) + (s.delayMin || 0) * MIN;
          if (t > after && t < best) best = t;
        }
      }
      return Number.isFinite(best) ? best : null;
    }
    case 'hours': {
      const step = Math.max(1, s.everyHours || 12) * HOUR;
      const base = plantAt(y, m, d, hm(s.time));
      return base + (Math.floor((after - base) / step) + 1) * step;
    }
    case 'daily': {
      const t = plantAt(y, m, d, hm(s.time));
      return t > after ? t : plantAt(y, m, d + 1, hm(s.time));
    }
    case 'weekly': {
      for (let k = 0; k <= 7; k += 1) {
        const t = plantAt(y, m, d + k, hm(s.time));
        if (t > after && plantDate(t).dow === s.weekday) return t;
      }
      return null;
    }
    case 'monthly': {
      for (let k = 0; k <= 2; k += 1) {
        const t = plantAt(y, m + k, Math.min(28, Math.max(1, s.monthDay || 1)), hm(s.time));
        if (t > after) return t;
      }
      return null;
    }
    default:
      return null;
  }
}

type Covered = 'shift' | 'hours' | 'day' | 'today' | 'week' | 'month_to_date' | 'month';
/** What a run covers: the schedule's choice, or what its frequency implies. */
export function coveredPeriod(s: ScheduleShape): Covered {
  if (s.period && s.period !== 'auto') return s.period;
  return ({ shift: 'shift', hours: 'hours', daily: 'day', weekly: 'week', monthly: 'month' } as const)[s.frequency];
}

export interface ReportWindow { from: Date; to: Date; label: string }

/** The period a run due at `due` reports, in the plant's words. */
export function windowFor(s: ScheduleShape, due: number, shifts: ShiftDef[]): ReportWindow {
  const win = (from: number, to: number, label: string): ReportWindow => ({ from: new Date(from), to: new Date(to), label });
  const hoursWin = (h: number): ReportWindow => win(due - h * HOUR, due, `Last ${h} hours · ${stampText(due - h * HOUR)} – ${stampText(due)}`);
  const dayOf = (t: number): string => bucketOf(t, PLANT_TZ_MIN, shifts).day;
  const start = (day: string): number => dayStartMs(day, PLANT_TZ_MIN, shifts);
  const cur = dayOf(due);
  switch (coveredPeriod(s)) {
    case 'shift': {
      // The latest shift that had ended by the due moment.
      const { y, m, d } = plantDate(due);
      let best: { from: number; to: number; name: string } | null = null;
      for (const sh of shiftPool(s, shifts)) {
        for (let k = -2; k <= 0; k += 1) {
          const end = plantAt(y, m, d + k, hm(sh.end));
          if (end <= due && (!best || end > best.to)) best = { from: end - shiftLengthSec(sh) * 1000, to: end, name: sh.name };
        }
      }
      if (!best) return hoursWin(8);
      return win(best.from, best.to, `${best.name} · ${dayText(best.from)} (${clock(best.from)}–${clock(best.to)})`);
    }
    case 'hours':
      return hoursWin(s.frequency === 'hours' ? Math.max(1, s.everyHours || 12) : Math.max(1, s.periodHours || 12));
    case 'day': {
      const prev = addDays(cur, -1);
      return win(start(prev), start(cur), `Production day · ${dayLabel(prev)} (${clock(start(prev))} → ${clock(start(cur))})`);
    }
    case 'today':
      return win(start(cur), due, `Today so far · ${dayLabel(cur)}`);
    case 'week': {
      const first = addDays(cur, -7);
      return win(start(first), start(cur), `Last 7 days · ${dayLabel(first).replace(/ \d{4}$/, '')} – ${dayLabel(addDays(cur, -1))}`);
    }
    case 'month_to_date': {
      const first = monthFirst(cur);
      return win(start(first), due, `${MONTH_NAMES[Number(first.slice(5, 7)) - 1]} ${first.slice(0, 4)} so far`);
    }
    case 'month': {
      const prev = monthFirst(cur, -1);
      return win(start(prev), start(monthFirst(cur)), `${MONTH_NAMES[Number(prev.slice(5, 7)) - 1]} ${prev.slice(0, 4)}`);
    }
  }
}

/** The schedule in a sentence or two, for its row and its preview. */
export function describeSchedule(s: ScheduleShape, shifts: ShiftDef[]): { when: string; covers: string } {
  const t = s.time || '07:30';
  let when: string;
  switch (s.frequency) {
    case 'shift': {
      const pool = shiftPool(s, shifts);
      const times = pool.map((sh) => clock(plantAt(2026, 0, 1, hm(sh.end)) + (s.delayMin || 0) * MIN));
      const which = s.shifts?.length && pool.length < shifts.length ? andList(pool.map((x) => x.name)) : 'every shift';
      when = `${s.delayMin ? `${s.delayMin} min after` : 'When'} ${which} ends · ${andList(times)}`;
      break;
    }
    case 'hours': {
      const n = Math.max(1, s.everyHours || 12);
      const base = plantAt(2026, 0, 1, hm(t));
      const times = Array.from({ length: Math.round(24 / n) }, (_, i) => clock(base + i * n * HOUR));
      when = n === 24 ? `Every 24 hours · ${t}` : n >= 4 ? `Every ${n} hours · ${andList(times)}` : `Every ${n} hour${n === 1 ? '' : 's'} from ${t}`;
      break;
    }
    case 'daily': when = `Every day at ${t}`; break;
    case 'weekly': when = `Every ${WEEKDAYS[s.weekday] || 'Monday'} at ${t}`; break;
    case 'monthly': when = `On the ${ordinal(s.monthDay || 1)} of every month at ${t}`; break;
    default: when = '';
  }
  const dayRoll = shifts[0]?.start || '07:00';
  const covers = ({
    shift: 'The shift that just ended',
    hours: `The ${s.frequency === 'hours' ? s.everyHours : s.periodHours} hours before each email`,
    day: `The previous production day (${dayRoll} → ${dayRoll})`,
    today: 'Today so far',
    week: 'The last 7 production days',
    month_to_date: 'This month so far',
    month: 'The previous month',
  } as const)[coveredPeriod(s)];
  return { when, covers };
}

// ── mail settings ────────────────────────────────────────────────────────────
/** The server's mail settings (config/env), or null when mail is not set up. */
export function mailSettings(): (SmtpConfig & { from: string }) | null {
  const m = env.smtp;
  if (!m.host || !m.from) return null;
  return { host: m.host, port: m.port, secure: m.secure, user: m.user || undefined, pass: m.pass || undefined, rejectUnauthorized: m.rejectUnauthorized, from: m.from };
}

/** What the admin may see about the mail settings — never the password. */
export function mailStatus(): { configured: boolean; host: string; port: number; secure: boolean; user: string; from: string; tlsVerify: boolean; readOnly: boolean } {
  const m = env.smtp;
  return { configured: !!mailSettings(), host: m.host, port: m.port, secure: m.secure, user: m.user, from: m.from, tlsVerify: m.rejectUnauthorized, readOnly: env.readOnly };
}

// ── the email ────────────────────────────────────────────────────────────────
const esc = (s: unknown): string => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
const int = (n: number | null | undefined): string => (n == null ? '—' : Math.round(n).toLocaleString('en-IN'));
const pct = (p: number | null | undefined): string => (p == null || !Number.isFinite(p) ? '—' : `${Math.round(p * 100)}%`);
const dur = (ms: number): string => { const t = Math.max(0, Math.round(ms / MIN)); const h = Math.floor(t / 60); return h ? `${h}h ${t % 60}m` : `${t % 60}m`; };

type EmailSchedule = ScheduleShape & Pick<IReportSchedule, 'name' | 'subject' | 'message' | 'includeSummary'>;

/** Subject with its tokens filled: {window} {scope} {name} {date}. */
export function subjectFor(s: Pick<IReportSchedule, 'name' | 'subject'>, win: ReportWindow, scope: string, at = Date.now()): string {
  const scoped = scope && scope !== 'All machines' ? ` — ${scope}` : '';
  const tpl = s.subject?.trim() || `EKC SmartFactory — {window}${scoped}`;
  return tpl
    .replace(/\{window\}/gi, win.label)
    .replace(/\{scope\}/gi, scope || 'All machines')
    .replace(/\{name\}/gi, s.name)
    .replace(/\{date\}/gi, dayText(at))
    .slice(0, 200);
}

export function composeEmail(s: EmailSchedule, win: ReportWindow, digest: WorkbookDigest, opts: { file: string; attached: boolean; tooBig: boolean; sentAt: number; shifts: ShiftDef[] }): { subject: string; text: string; html: string } {
  const subject = subjectFor(s, win, digest.scope, opts.sentAt);
  const { when } = describeSchedule(s, opts.shifts);
  const tgt = digest.target != null ? `target ${int(digest.target)} · ${pct(digest.achievement)} achieved` : 'no dia assigned — no target';
  const downtime = digest.idleMs + digest.stoppedMs;
  const fileLine = opts.attached
    ? `The full review workbook is attached: ${opts.file}.`
    : opts.tooBig
      ? `The workbook (${opts.file}) is too large to attach — download it from Reports in EKC SmartFactory.`
      : 'Open Reports in EKC SmartFactory for the full workbook.';
  const sentLine = `Sent automatically by EKC SmartFactory on ${dayText(opts.sentAt)} at ${clock(opts.sentAt)} (plant time) · “${s.name}” · ${when}.`;

  // Plain text first: what a phone's preview and a text-only client show.
  const lines: string[] = [win.label, digest.scope, ''];
  if (s.message?.trim()) lines.push(s.message.trim(), '');
  if (s.includeSummary) {
    lines.push(
      `Pieces made: ${int(digest.production)} (${tgt})`,
      `Availability: ${pct(digest.availability)} · runtime ${dur(digest.runningMs)} · idle ${dur(digest.idleMs)} · stopped ${dur(digest.stoppedMs)} · downtime ${dur(downtime)}`,
      ...(digest.offlineMs >= MIN ? [`Signal lost: ${dur(digest.offlineMs)} (no data from the machine — not downtime)`] : []),
      `Machines: ${digest.machines} (${digest.reporting} sent data) · downtime events: ${digest.downtimeEvents}${digest.openNow ? ` (${digest.openNow} still open)` : ''}`,
      '',
      ...digest.sections.map((x) => `${x.name}: ${x.production == null ? 'no counter' : `${int(x.production)} pcs`}${x.target != null ? ` / ${int(x.target)} (${pct(x.achievement)})` : ''} · availability ${pct(x.availability)} · downtime ${x.downtimeHours} h`),
      '',
    );
  }
  lines.push(fileLine, '', sentLine);

  const th = 'padding:7px 8px;border-bottom:1px solid #e2e8f0;font-weight:600;color:#475569;font-size:12px';
  const td = 'padding:7px 8px;border-bottom:1px solid #f1f5f9;font-size:13px';
  // Two by two, not four across: it fits a phone, and a plain table is the
  // one layout every mail client (Outlook included) draws the same.
  const stat = (label: string, value: string, sub: string): string =>
    `<td style="padding:10px 12px;border:1px solid #e2e8f0;vertical-align:top;width:50%">`
    + `<div style="font-size:11px;color:#64748b;text-transform:uppercase;letter-spacing:.04em">${esc(label)}</div>`
    + `<div style="font-size:22px;font-weight:700;color:#0f172a;margin-top:2px">${esc(value)}</div>`
    + `<div style="font-size:11px;color:#64748b;margin-top:2px">${esc(sub)}</div></td>`;
  const summary = !s.includeSummary ? '' : [
    '<table role="presentation" cellpadding="0" cellspacing="0" style="border-collapse:collapse;width:100%;margin:16px 0">',
    '<tr>',
    stat('Pieces made', int(digest.production), tgt),
    stat('Availability', pct(digest.availability), `runtime ${dur(digest.runningMs)}`),
    '</tr><tr>',
    stat('Downtime', dur(downtime), `idle ${dur(digest.idleMs)} · stopped ${dur(digest.stoppedMs)}`),
    stat('Machines', String(digest.machines), `${digest.reporting} sent data${digest.offlineMs >= MIN ? ` · signal lost ${dur(digest.offlineMs)}` : ''}`),
    '</tr></table>',
    digest.sections.length ? [
      '<table cellpadding="0" cellspacing="0" style="border-collapse:collapse;width:100%">',
      // Five columns, so a phone shows them all; machine counts are in the workbook.
      `<tr style="background:#f8fafc"><th align="left" style="${th}">Section</th><th align="right" style="${th}">Pieces</th><th align="right" style="${th}">Target</th><th align="right" style="${th}">Availability</th><th align="right" style="${th}">Downtime</th></tr>`,
      ...digest.sections.map((x) => `<tr><td style="${td}">${esc(x.name)}</td>`
        + `<td align="right" style="${td};font-weight:600">${x.production == null ? '<span style="color:#94a3b8">no counter</span>' : int(x.production)}</td>`
        + `<td align="right" style="${td};white-space:nowrap">${x.target == null ? '—' : `${int(x.target)} · ${pct(x.achievement)}`}</td>`
        + `<td align="right" style="${td}">${pct(x.availability)}</td><td align="right" style="${td};white-space:nowrap">${x.downtimeHours} h</td></tr>`),
      '</table>',
    ].join('') : '',
  ].join('');
  const html = [
    '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head><body style="margin:0;padding:0;background:#ffffff">',
    '<div style="font-family:Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#0f172a;max-width:720px;margin:0 auto;padding:16px">',
    '<div style="border-left:4px solid #0d9488;padding:2px 0 2px 12px">',
    `<div style="font-size:11px;color:#64748b;text-transform:uppercase;letter-spacing:.06em">EKC SmartFactory · ${esc(s.name)}</div>`,
    `<div style="font-size:19px;font-weight:600;margin-top:2px">${esc(win.label)}</div>`,
    `<div style="font-size:13px;color:#64748b;margin-top:2px">${esc(digest.scope)}</div>`,
    '</div>',
    s.message?.trim() ? `<p style="font-size:14px;line-height:1.5;margin:16px 0 0;white-space:pre-wrap">${esc(s.message.trim())}</p>` : '',
    summary,
    `<p style="font-size:13px;margin:16px 0 0">${esc(fileLine)}</p>`,
    `<p style="font-size:11px;color:#94a3b8;margin:20px 0 0;border-top:1px solid #f1f5f9;padding-top:10px">${esc(sentLine)}</p>`,
    '</div></body></html>',
  ].join('');
  return { subject, text: lines.join('\n'), html };
}

// ── one send ─────────────────────────────────────────────────────────────────
export interface DeliverOutcome { status: RunStatus; detail: string; retryable: boolean; accepted: number }
type Deliverable = EmailSchedule & Pick<IReportSchedule, 'to' | 'cc' | 'machines' | 'attachWorkbook' | 'skipIfIdle'> & { _id?: unknown };

/** Build the report for the period a run due at `due` covers, mail it, log it. */
export async function deliver(s: Deliverable, due: number, trigger: RunTrigger, by: Who, shiftsIn?: ShiftDef[]): Promise<DeliverOutcome> {
  const started = Date.now();
  const shifts = shiftsIn ?? await loadShifts();
  const win = windowFor(s, due, shifts);
  const finish = async (status: RunStatus, detail: string, retryable = false, extra: Record<string, unknown> = {}): Promise<DeliverOutcome> => {
    // A log row must never be the reason a send is reported as failed.
    await ReportMailRun.create({
      scheduleId: s._id ?? null, name: s.name, trigger, due: new Date(due), at: new Date(), status, detail,
      to: s.to, cc: s.cc, window: win, durationMs: Date.now() - started, by, ...extra,
    }).catch((e) => console.error('[report-mail] could not log the run:', errMessage(e)));
    console.log(`[report-mail] "${s.name}" (${trigger}) ${status}: ${detail}`);
    return { status, detail, retryable, accepted: Array.isArray(extra.accepted) ? extra.accepted.length : 0 };
  };

  const cfg = mailSettings();
  if (!cfg) return finish('failed', 'Mail is not set up on the server yet (SMTP_HOST and SMTP_FROM in the server settings).');
  if (+win.to - +win.from < MIN || +win.from >= Date.now()) return finish('skipped', `Nothing to report yet — ${win.label} has not begun.`);

  let built: Awaited<ReturnType<typeof buildWorkbook>>;
  try {
    built = await buildWorkbook({
      from: win.from, to: win.to, machines: s.machines, label: win.label,
      generatedBy: trigger === 'schedule' ? `Scheduled email — ${s.name}` : `${by.name || 'Sent by hand'} — ${s.name}`,
    });
  } catch (e) {
    return finish('failed', `The report could not be built: ${errMessage(e)}`, true);
  }
  if (s.skipIfIdle && built.digest.production === 0 && built.digest.runningMs === 0) {
    return finish('skipped', 'Nothing was made and no machine ran in this period — no email, as set.');
  }
  const attached = s.attachWorkbook && built.book.length <= MAX_ATTACH_BYTES;
  const mail = composeEmail(s, win, built.digest, { file: built.file, attached, tooBig: s.attachWorkbook && !attached, sentAt: Date.now(), shifts });
  try {
    const res = await sendMail(cfg, {
      from: cfg.from, to: s.to, cc: s.cc, subject: mail.subject, text: mail.text, html: mail.html,
      attachments: attached ? [{ filename: built.file, contentType: XLSX_TYPE, content: built.book }] : [],
    });
    const refused = res.rejected.length ? ` — refused: ${res.rejected.map((r) => r.address).join(', ')}` : '';
    return finish('sent', `Sent to ${res.accepted.length} ${res.accepted.length === 1 ? 'person' : 'people'}${refused}`, false,
      { accepted: res.accepted, rejected: res.rejected, file: attached ? built.file : '', bytes: attached ? built.book.length : 0 });
  } catch (e) {
    const me = e instanceof MailError ? e : new MailError(errMessage(e), 'EUNKNOWN');
    return finish('failed', me.message, RETRYABLE.has(me.code), { file: built.file });
  }
}

/** A short email that proves the settings work, to one address. */
export async function sendTestEmail(to: string, by: Who): Promise<DeliverOutcome> {
  const started = Date.now();
  const log = async (status: RunStatus, detail: string, accepted: string[] = []): Promise<DeliverOutcome> => {
    await ReportMailRun.create({
      scheduleId: null, name: 'Test email', trigger: 'test', due: new Date(started), at: new Date(), status, detail,
      to: [to], cc: [], accepted, window: null, durationMs: Date.now() - started, by,
    }).catch(() => {});
    return { status, detail, retryable: false, accepted: accepted.length };
  };
  const cfg = mailSettings();
  if (!cfg) return log('failed', 'Mail is not set up on the server yet (SMTP_HOST and SMTP_FROM in the server settings).');
  const when = `${dayText(started)} at ${clock(started)} (plant time)`;
  try {
    const res = await sendMail(cfg, {
      from: cfg.from, to: [to],
      subject: 'EKC SmartFactory — test email',
      text: `This is a test from EKC SmartFactory, sent ${when} by ${by.name || 'an administrator'}.\n\nIf you can read it, scheduled report emails will reach this address.\n\nMail server: ${cfg.host}:${cfg.port}`,
      html: '<div style="font-family:Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#0f172a;max-width:560px;padding:20px">'
        + '<div style="border-left:4px solid #0d9488;padding-left:12px;font-size:18px;font-weight:600">EKC SmartFactory — test email</div>'
        + `<p style="font-size:14px;line-height:1.5">Sent ${esc(when)} by ${esc(by.name || 'an administrator')}.</p>`
        + '<p style="font-size:14px;line-height:1.5">If you can read this, scheduled report emails will reach this address.</p>'
        + `<p style="font-size:11px;color:#94a3b8">Mail server: ${esc(cfg.host)}:${cfg.port}</p></div>`,
    });
    return log('sent', `Test email accepted for ${to}`, res.accepted);
  } catch (e) {
    return log('failed', e instanceof MailError ? e.message : errMessage(e));
  }
}

// ── the ticker ───────────────────────────────────────────────────────────────
type Claimed = IReportSchedule & { _id: unknown };

async function runOne(s: Claimed, now: Date): Promise<void> {
  const shifts = await loadShifts();
  const nowMs = now.getTime();
  // A retry keeps its period. A fresh run takes the LATEST due moment that has
  // passed: a server that was off through several sends one email, not a burst.
  let due = s.due ? +s.due : +(s.nextRunAt as Date);
  let missed = 0;
  if (!s.due) {
    for (let n = nextRunAfter(s, due, shifts); n !== null && n <= nowMs && missed < 10_000; n = nextRunAfter(s, due, shifts)) { due = n; missed += 1; }
  }
  const out = await deliver(s, due, 'schedule', { name: 'schedule' }, shifts);
  const attempt = s.due ? s.attempt || 0 : 0;
  const note = missed ? ` (${missed} earlier send${missed === 1 ? ' was' : 's were'} missed while the server was off — sent once, for the latest)` : '';
  const lastRun = { at: new Date(), status: out.status, detail: out.detail + note, recipients: out.accepted || s.to.length + s.cc.length };
  // Only while our claim still stands: an edit in between has rescheduled it.
  const mine = { _id: s._id, claimedAt: s.claimedAt };
  if (out.status === 'failed' && out.retryable && attempt < RETRY_MIN.length) {
    const retryAt = nowMs + RETRY_MIN[attempt] * MIN;
    await ReportSchedule.updateOne(mine, { $set: {
      due: new Date(due), attempt: attempt + 1, nextRunAt: new Date(retryAt), claimedAt: null,
      lastRun: { ...lastRun, detail: `${lastRun.detail} — trying again at ${clock(retryAt)}` },
    } });
    return;
  }
  const next = nextRunAfter(s, Math.max(due, nowMs), shifts);
  await ReportSchedule.updateOne(mine, { $set: { due: null, attempt: 0, nextRunAt: next ? new Date(next) : null, claimedAt: null, lastRun } });
}

async function runDue(nowIn?: Date): Promise<number> {
  let n = 0;
  for (let guard = 0; guard < 25; guard += 1) {
    const now = nowIn ?? new Date();
    const s = await ReportSchedule.findOneAndUpdate(
      {
        enabled: true, nextRunAt: { $ne: null, $lte: now },
        $or: [{ claimedAt: null }, { claimedAt: { $lt: new Date(now.getTime() - STALE_CLAIM_MS) } }],
      },
      { $set: { claimedAt: now } },
      { sort: { nextRunAt: 1 }, new: true },
    ).lean();
    if (!s) break;
    n += 1;
    try {
      await runOne(s as unknown as Claimed, now);
    } catch (e) {
      // Left claimed on purpose: the stale-claim window retries it on a later
      // tick instead of in a hot loop.
      console.error(`[report-mail] "${s.name}" run failed, will retry:`, errMessage(e));
    }
  }
  return n;
}

let inFlight: Promise<number> | null = null;
/** Send every due schedule, oldest first. One run at a time; callers join it. */
export function runDueReportMails(now?: Date): Promise<number> {
  if (env.readOnly) return Promise.resolve(0);
  if (!inFlight) inFlight = runDue(now).finally(() => { inFlight = null; });
  return inFlight;
}

/** Enabled schedules without a next send (made before a shift change, or by
 *  an older build) get one. */
export async function reconcileNextRuns(now = Date.now()): Promise<number> {
  const open = await ReportSchedule.find({ enabled: true, nextRunAt: null }).lean();
  if (!open.length) return 0;
  const shifts = await loadShifts();
  for (const s of open) {
    const next = nextRunAfter(s, now, shifts);
    await ReportSchedule.updateOne({ _id: s._id, nextRunAt: null }, { $set: { nextRunAt: next ? new Date(next) : null } });
  }
  return open.length;
}

let timer: NodeJS.Timeout | null = null;
let kickoff: NodeJS.Timeout | null = null;

export function startReportMailer(): void {
  if (env.readOnly) {
    console.log('[report-mail] review copy (READ_ONLY) — scheduled emails go out from the plant server only');
    return;
  }
  const tick = (): void => { runDueReportMails().catch((e) => console.error('[report-mail] tick failed:', errMessage(e))); };
  reconcileNextRuns().catch((e) => console.error('[report-mail] could not reconcile schedules:', errMessage(e)));
  // A breath after start-up, so a restart does not open with a heavy workbook.
  kickoff = setTimeout(tick, 20_000);
  timer = setInterval(tick, TICK_MS);
  const m = mailSettings();
  console.log(m ? `[report-mail] sending through ${m.host}:${m.port} as ${m.from}` : '[report-mail] mail is not set up (SMTP_HOST) — schedules wait until it is');
}

export function stopReportMailer(): void {
  if (timer) clearInterval(timer);
  if (kickoff) clearTimeout(kickoff);
  timer = null; kickoff = null;
}
