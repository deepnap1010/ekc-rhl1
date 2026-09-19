// server/src/controllers/export.controller.ts
// GET /reports/export?from&to&machineId&label — the plant's review workbook,
// in the plant's own layout. Their "29.08.2026.xlsx" is a month-at-a-glance
// PRODUCTION ANALYSIS (one row per machine section, one column per day of
// the month, TOTAL / required / achieved, a per-shift block, a TOTAL row)
// plus a daily PDWIP page (per machine: size running, norms per shift,
// SHIFT-I/II/III pieces, total, monthly cumulative, norms-vs-actual %, idle
// hours by reason, total delay hours, reasons, today's status, then the
// month's cumulative statistics per section with the working-days divisor).
// Every one of those figures is in this app's telemetry — pieces per shift,
// the assigned dia's cycle time as the norm, downtime with the operator's
// reason — so the workbook reproduces that book for the selected window and
// machine scope, in the plant's conventions: d-mmm day headers, yellow
// figures, green averages, the light-red idle band, live TOTAL / AVG /
// ACHIEVE formulas (with their values cached for readers that do not
// recalculate), landscape with the header repeated on every printed page.
// What their book holds beyond machine data — WIP stock, dispatch, batches,
// painting and HST counts — is named on the cover and left out, never
// zero-filled.
//
// One engine feeds every piece figure in the file: computePlantReport
// (confirmed counter steps net of classified-away pieces, filed by
// production day and shift on the PLANT clock, downtime clipped to when the
// machine was heard). The activity engine supplies runtime/idle/stopped
// time on the analyst sheets; the sheets say which is which.
import { Machine } from '../models/Machine.js';
import { MachineLabel } from '../models/MachineLabel.js';
import { MachineAssignment } from '../models/MachineAssignment.js';
import { DowntimeEvent } from '../models/DowntimeEvent.js';
import { MachineEvent } from '../models/MachineEvent.js';
import { fail, asyncHandler } from '../utils/http.js';
import { machineScope } from '../utils/scope.js';
import { refCandidates } from '../utils/machineRef.js';
import { normalizeStatus } from '../utils/status.js';
import { computeActivity, type ActivityRow } from '../services/activity.service.js';
import { computeTargets } from '../services/targets.service.js';
import { computePlantReport, shiftCoverageMin, shiftLengthSec, dayStartMs, type MachineDay } from '../services/plantReport.service.js';
import { getProdClassConfig } from '../utils/prodclass.js';
import { shiftNameAt, getDowntimeAskConfig } from '../utils/downtimeAsk.js';
import { loadShifts } from './config.controller.js';
import { buildXlsx, dateCell, firstDataRow, type Block, type Cell, type Column, type Fmt, type Row, type Scalar, type Sheet } from '../utils/xlsx.js';

type ScopedUser = { isSuperAdmin?: boolean; assignedMachines?: string[]; name?: string };

const MAX_ROWS = 20_000;          // per detail LISTING sheet — aggregates never read a capped list
const MAX_MATRIX_DAYS = 62;       // a day-per-column grid past two months is unreadable; the detail sheets still cover it
const NETWORK_LOST_MS = 10 * 60_000;
const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
// The plant clock is a property of the plant, not of whoever downloads the
// file: every production day, shift and date in the workbook is on IST,
// exactly as the target engine (targets.service) already assumes. A reviewer
// on a laptop set to UTC must get the same sheet the plant gets.
const PLANT_TZ_MIN = 330;

// ── machine families, in the plant's process order and vocabulary ───────────
// A machine's FAMILY is the code with its trailing number stripped, aliases
// folded, run-together words split — the client's lib/machineOrder rule,
// kept in step by hand so the workbook's sections are the Dashboard's groups.
const FAMILY_ALIASES: Record<string, string> = { INTERNALSHOTBLASTING: 'ISB', SHOTBLASTING: 'ISB', SPINNING: 'SPG', CNCLATHE: 'CNC' };
// The plant's own section names, in the order cylinders travel.
const SECTIONS: { stem: string; title: string }[] = [
  { stem: 'CUTTINGMACHINE', title: 'PIPE CUTTING (P/C)' },
  { stem: 'SPG', title: 'SPINNING (SPG)' },
  { stem: 'BOTTOMMILLING', title: 'BOTTOM MILLING' },
  { stem: 'QUENCHINGFURNACE', title: 'HEAT TREATMENT (HQT)' },
  { stem: 'ISB', title: 'INTERNAL SHOT BLASTING (ISB)' },
  { stem: 'CNC', title: 'CNC MACHINING' },
];
const WORDS = ['INTERNAL', 'QUENCHING', 'BLASTING', 'HYDRAULIC', 'ASSEMBLY', 'GRINDING', 'EXTERNAL', 'CUTTING', 'MILLING', 'WELDING', 'FURNACE', 'MACHINE', 'BOTTOM', 'PRESS', 'LATHE', 'DRILL', 'MOULD', 'PUMP', 'SHOT', 'SAW', 'TOP', 'CNC', 'SPG'];
const titleCase = (w: string): string => (w.length <= 3 ? w : w[0] + w.slice(1).toLowerCase());
const stemOf = (code: string): string => {
  const raw = code.toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/\d+$/, '') || 'OTHER';
  return FAMILY_ALIASES[raw] ?? raw;
};
const familyOf = (code: string): string => {
  const stem = stemOf(code);
  const hit = SECTIONS.find((s) => s.stem === stem);
  if (hit) return hit.title;
  const words: string[] = [];
  let rest = stem;
  while (rest) {
    const w = WORDS.find((x) => rest.startsWith(x));
    if (!w) { words.push(rest); break; }
    words.push(w); rest = rest.slice(w.length);
  }
  return words.map(titleCase).join(' ');
};
const sectionRank = (code: string): number => {
  const i = SECTIONS.findIndex((s) => s.stem === stemOf(code));
  return i < 0 ? SECTIONS.length : i;
};
const numTail = (code: string): number => Number((code.match(/(\d+)\s*$/) || [])[1] || 0);
const flowCompare = (a: string, b: string): number =>
  sectionRank(a) - sectionRank(b) || stemOf(a).localeCompare(stemOf(b)) || numTail(a) - numTail(b) || a.localeCompare(b);

const parseD = (v?: string): Date | null => {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
};
const pct = (num: number, den: number): number | null => (den > 0 ? num / den : null);
const clipMs = (s: Date, e: Date | null, from: number, to: number): number =>
  Math.max(0, Math.min(e ? e.getTime() : Date.now(), to) - Math.max(s.getTime(), from));
const minuteOfDay = (d: Date, tzMin: number): number => Math.floor((((d.getTime() + tzMin * 60_000) % DAY_MS) + DAY_MS) % DAY_MS / 60_000);
const stamp = (d: Date, tzMin: number): string => new Date(d.getTime() + tzMin * 60_000).toISOString().slice(0, 16).replace('T', ' ');
const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
const monthOf = (d: string): string => `${MONTHS[Number(d.slice(5, 7)) - 1]} ${d.slice(0, 4)}`;
/** "AUG 2026", or "28 AUG – 2 SEP 2026" when the window straddles months. */
const monthLabel = (days: string[]): string => {
  if (!days.length) return '';
  const a = days[0], b = days[days.length - 1];
  if (a.slice(0, 7) === b.slice(0, 7)) return monthOf(a);
  return `${Number(a.slice(8, 10))} ${monthOf(a)} – ${Number(b.slice(8, 10))} ${monthOf(b)}`;
};
const dayLabel = (d: string): string => `${Number(d.slice(8, 10))}-${MONTHS[Number(d.slice(5, 7)) - 1]}-${d.slice(0, 4)}`;
const dayCell = (day: string): Cell => dateCell(Number(day.slice(0, 4)), Number(day.slice(5, 7)), Number(day.slice(8, 10)), PLANT_TZ_MIN);
const dayKey = (day: string): string => `d${day.replace(/-/g, '')}`;
const hoursOf = (ms: number): number => Math.round((ms / HOUR_MS) * 100) / 100;
const ROMAN = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII'];
/** SHIFT-I / SHIFT-II / SHIFT-III — the plant's headers; an off-shift bucket keeps its name. */
const shiftHeader = (name: string, i: number): string => (name === 'Off-shift' ? 'OFF-SHIFT' : `SHIFT-${ROMAN[i] ?? i + 1}`);
/** A formula with the number it evaluates to, for readers that do not recalculate. */
const fv = (f: string, v: Scalar): Cell => ({ f, v });
const round2 = (n: number): number => Math.round(n * 100) / 100;

const NOT_INCLUDED = 'Not in this workbook (no machine behind them): WIP stock by size and stage, marketing plan and dispatch, raw-material pipe stock, batch status and approvals, non-moving cylinders, and piece counts for HQT, HST, ESB, marking, stamping and painting. The furnace reports temperature only.';

export const exportWorkbook = asyncHandler(async (req, res) => {
  const user = req.user as ScopedUser | undefined;
  const rq = req.query as Record<string, string | undefined>;
  const from = parseD(rq.from);
  const toRaw = parseD(rq.to) || new Date();
  if (!from || from >= toRaw) return fail(res, 400, 'from (and optionally to) must be valid dates, from before to');
  const to = new Date(Math.min(toRaw.getTime(), Date.now()));
  if (to.getTime() - from.getTime() > 400 * DAY_MS) return fail(res, 400, 'The export covers at most 400 days at a time');
  const tzMin = PLANT_TZ_MIN;
  const windowLabel = String(rq.label || '').slice(0, 80) || `${stamp(from, tzMin)} → ${stamp(to, tzMin)}`;

  // Scope: the user's machines, narrowed to one if asked.
  const scope = machineScope(user);
  const one = rq.machineId && rq.machineId !== 'all' ? rq.machineId.trim() : '';
  if (one && scope && !scope.some((s) => s.toUpperCase() === one.toUpperCase())) return fail(res, 403, 'You are not assigned to this machine');
  const only = one ? [one] : null;

  const act = await computeActivity(scope, from, to, only);
  const rows = [...act.rows].sort((a, b) => flowCompare(a.code, b.code));
  const codes = rows.map((r) => r.code);
  const ids = [...new Set(codes.flatMap(refCandidates))];
  const windowMs = act.windowMs;
  const fromMs = from.getTime(); const toMs = act.to.getTime();

  const shifts = await loadShifts();
  const spanFilter = { machineId: { $in: ids }, startedAt: { $lte: act.to }, $or: [{ endedAt: null }, { endedAt: { $gte: from } }] };
  const [labels, docs, current, spansAll, spans, prodEvents, prodCfg, targets, plant, askCfg] = await Promise.all([
    MachineLabel.find({}).select({ machineRef: 1, displayName: 1 }).lean(),
    Machine.find(codes.length ? { $or: [{ code: { $in: ids } }, { machineId: { $in: ids } }] } : { _id: null })
      .select({ code: 1, machineId: 1, type: 1, status: 1, lastReadingAt: 1, lastSeenAt: 1 }).lean(),
    MachineAssignment.find({ effectiveTo: null, machineRef: { $in: ids } }).select({ machineRef: 1, snapshot: 1 }).lean(),
    // Every span, for the aggregates (counts, open now, MTBF/MTTR) …
    DowntimeEvent.find(spanFilter).select({ machineId: 1, type: 1, startedAt: 1, endedAt: 1, reason: 1 }).maxTimeMS(30_000).lean(),
    // … and the capped listing the 'Downtime events' sheet prints.
    DowntimeEvent.find(spanFilter).sort({ startedAt: 1 }).limit(MAX_ROWS).lean(),
    MachineEvent.find({ kind: 'production', machineId: { $in: ids }, startedAt: { $gte: from, $lte: act.to } })
      .sort({ startedAt: 1 }).limit(MAX_ROWS).lean(),
    getProdClassConfig(),
    // Targets exist per assignment; the engine caps a run at 92 days.
    to.getTime() - from.getTime() <= 92 * DAY_MS ? computeTargets(from, act.to, only ?? scope, 'assignment') : Promise.resolve(null),
    computePlantReport(codes, from, act.to, tzMin, shifts),
    getDowntimeAskConfig(),
  ]);

  const nameOf = (() => {
    const m = new Map(labels.map((l) => [l.machineRef.toUpperCase(), l.displayName]));
    return (code: string): string => m.get(code.toUpperCase()) || code;
  })();
  const docOf = new Map(docs.flatMap((d) => [d.code, d.machineId].filter(Boolean).map((k) => [String(k).toUpperCase(), d] as const)));
  const diaOf = new Map(current.map((a) => [a.machineRef.toUpperCase(), a.snapshot]));
  const classOf = new Map(prodCfg.options.map((o) => [o.value, o]));
  const statusNow = (code: string): string => {
    const d = docOf.get(code.toUpperCase());
    const seen = d?.lastReadingAt || d?.lastSeenAt;
    if (!seen || Date.now() - new Date(seen).getTime() > NETWORK_LOST_MS) return 'Signal lost';
    return normalizeStatus(d?.status) || '—';
  };
  const downOf = (r: ActivityRow): number => r.idleMs + r.stoppedMs;
  const counted = new Map(rows.map((r) => [r.code.toUpperCase(), r.production != null]));   // has a piece counter at all
  const md = (code: string, day: string): MachineDay | undefined => plant.byMachineDay.get(`${code.toUpperCase()}|${day}`);
  const touched = plant.days;
  // A window that begins after a production day started (a custom range
  // typed at 00:00) opens on a partial day; it is still a column, but it is
  // not the month's first day and must not decide the title.
  const lead = touched.length > 1 && dayStartMs(touched[0], tzMin, shifts) < fromMs ? 1 : 0;
  const fullDays = touched.slice(lead);
  // The plant's month sheet shows every day of the month, the ones still to
  // come left blank — so a report pulled on the 19th reads like theirs. A
  // window inside one calendar month gets the whole month's columns; a
  // window that straddles months gets exactly the days it touches.
  const days = (() => {
    if (!fullDays.length || fullDays[0].slice(0, 7) !== fullDays[fullDays.length - 1].slice(0, 7)) return touched;
    const [y, m] = [Number(fullDays[0].slice(0, 4)), Number(fullDays[0].slice(5, 7))];
    const n = new Date(Date.UTC(y, m, 0)).getUTCDate();
    const month = Array.from({ length: n }, (_, i) => `${y}-${String(m).padStart(2, '0')}-${String(i + 1).padStart(2, '0')}`);
    return lead ? [touched[0], ...month] : month;
  })();
  const inWindow = new Set(touched);
  const shiftNames = shifts.map((s) => s.name);
  // Shifts that do not tile the clock leave an off-shift bucket; pieces made
  // there must still appear, or the day page and the month page disagree.
  const shiftCols = shiftCoverageMin(shifts) < 1440 ? [...shiftNames, 'Off-shift'] : shiftNames;
  const nShifts = Math.max(1, shiftNames.length);
  const period = monthLabel(fullDays);
  const scopeText = one ? `${nameOf(one)} (${one})` : 'All machines';
  // Working days — the plant's divisor for "average per day": production days
  // in the window on which the scope made anything at all.
  const workingDays = touched.filter((d) => rows.some((r) => (md(r.code, d)?.total || 0) > 0)).length;
  const avgDivisor = Math.max(1, workingDays);
  // The report day — the page the plant prints: the last COMPLETE production
  // day of the window (a day still running is not a day's figures yet), or
  // the only day when the window is a single day or shift.
  const dayEnd = (d: string): number => dayStartMs(d, tzMin, shifts) + DAY_MS;
  const reportDay = touched.length > 1 && dayEnd(touched[touched.length - 1]) > toMs ? touched[touched.length - 2] : touched[touched.length - 1];
  // Month-to-date from the 1st, even when the window starts later — the
  // plant's "Monthly cum." is always from the 1st. One extra pass over the
  // days before the window, bounded by a month; a window that itself begins
  // mid-day gets that morning from here too.
  const monthStartDay = reportDay ? `${reportDay.slice(0, 7)}-01` : '';
  const monthStart = monthStartDay ? new Date(dayStartMs(monthStartDay, tzMin, shifts)) : from;
  const prior = monthStartDay && monthStart < from ? await computePlantReport(codes, monthStart, from, tzMin, shifts) : null;
  const priorTotal = (code: string, uptoDay: string): number =>
    (prior?.rows || []).filter((r) => r.code.toUpperCase() === code.toUpperCase() && r.day <= uptoDay).reduce((n, r) => n + r.total, 0);
  const sameMonth = (d: string): boolean => !!reportDay && d.slice(0, 7) === reportDay.slice(0, 7);
  const monthDays = touched.filter((d) => sameMonth(d) && d <= (reportDay || ''));
  const machineTotal = (code: string, dayList: string[]): number => dayList.reduce((n, d) => n + (md(code, d)?.total || 0), 0);
  const machineAssigned = (code: string, dayList: string[]): { pieces: number; target: number } =>
    dayList.reduce((a, d) => { const x = md(code, d); return { pieces: a.pieces + (x?.assignedTotal || 0), target: a.target + (x?.targetTotal || 0) }; }, { pieces: 0, target: 0 });
  const delayHoursOf = (code: string, dayList: string[]): number => dayList.reduce((n, d) => { const x = md(code, d); return n + (x ? x.downtimeMs.idle + x.downtimeMs.stopped : 0); }, 0) / HOUR_MS;
  const norm = (x: MachineDay | undefined): number | null => (x?.dia?.cycleSec ? Math.round(Math.max(...shifts.map(shiftLengthSec)) / x.dia.cycleSec) : null);

  // ── per-machine rollups from the span and target logs ─────────────────────
  const eventsBy = new Map<string, number>();
  for (const s of spansAll) eventsBy.set(s.machineId.toUpperCase(), (eventsBy.get(s.machineId.toUpperCase()) || 0) + 1);
  type TargetSum = { target: number; targetAdj: number; actual: number; assignedSec: number; downtimeSec: number; breakSec: number; operators: Set<string> };
  const tgtByMachine = new Map<string, TargetSum>();
  const tgtByMachineDia = new Map<string, TargetSum & { machineRef: string; dia: string; dims: string; stage: string; processingSec: number }>();
  for (const t of targets?.rows || []) {
    const add = (s: TargetSum): void => {
      s.target += t.target; s.targetAdj += t.targetAdj; s.actual += t.actual;
      s.assignedSec += t.assignedSec; s.downtimeSec += t.downtimeSec; s.breakSec += t.breakSec;
      if (t.operator) s.operators.add(t.operator);
    };
    const k = t.machineRef.toUpperCase();
    if (!tgtByMachine.has(k)) tgtByMachine.set(k, { target: 0, targetAdj: 0, actual: 0, assignedSec: 0, downtimeSec: 0, breakSec: 0, operators: new Set() });
    add(tgtByMachine.get(k)!);
    const kd = `${k}|${t.dia}|${t.stage}`;
    if (!tgtByMachineDia.has(kd)) tgtByMachineDia.set(kd, { machineRef: t.machineRef, dia: t.dia, dims: t.dims, stage: t.stage, processingSec: t.processingSec, target: 0, targetAdj: 0, actual: 0, assignedSec: 0, downtimeSec: 0, breakSec: 0, operators: new Set() });
    add(tgtByMachineDia.get(kd)!);
  }

  // ── fleet totals ─────────────────────────────────────────────────────────
  const sum = (f: (r: ActivityRow) => number): number => rows.reduce((n, r) => n + f(r), 0);
  const runningMs = sum((r) => r.runningMs), idleMs = sum((r) => r.idleMs), stoppedMs = sum((r) => r.stoppedMs), offlineMs = sum((r) => r.offlineMs);
  const production = rows.reduce((n, r) => n + machineTotal(r.code, touched), 0);
  const counters = rows.filter((r) => r.production != null).length;
  const availability = pct(runningMs, windowMs * rows.length);
  const openNow = spansAll.filter((s) => !s.endedAt).length;
  const noReasonMs = plant.rows.reduce((n, r) => n + (r.downtimeByReason[''] || 0), 0);
  const reasonedMs = plant.rows.reduce((n, r) => n + r.downtimeMs.idle + r.downtimeMs.stopped, 0);
  const tgtAll = [...tgtByMachine.values()].reduce((a, s) => ({ target: a.target + s.target, actual: a.actual + s.actual }), { target: 0, actual: 0 });
  const kv = (k: string, v: Cell, fmt?: Fmt): Row => ({ k, v: fmt ? { v: v as Scalar, fmt } : v });
  const sections = [...new Map(rows.map((r) => [familyOf(r.code), sectionRank(r.code)])).entries()].sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0])).map((x) => x[0]);
  const membersOf = (sec: string): ActivityRow[] => rows.filter((r) => familyOf(r.code) === sec);
  const sectionCounts = (sec: string): boolean => membersOf(sec).some((r) => counted.get(r.code.toUpperCase()));

  // ═══ 1 · Summary (cover) ═════════════════════════════════════════════════
  const sectionRows: Row[] = sections.map((sec) => {
    const m = membersOf(sec);
    const has = sectionCounts(sec);
    const prod = has ? m.reduce((n, r) => n + machineTotal(r.code, touched), 0) : null;
    const asg = m.reduce((a, r) => { const x = machineAssigned(r.code, touched); return { pieces: a.pieces + x.pieces, target: a.target + x.target }; }, { pieces: 0, target: 0 });
    const g = { family: sec, machines: m.length, production: prod, target: has ? Math.round(asg.target) : null,
      runningMs: m.reduce((n, r) => n + r.runningMs, 0), idleMs: m.reduce((n, r) => n + r.idleMs, 0), stoppedMs: m.reduce((n, r) => n + r.stoppedMs, 0), offlineMs: m.reduce((n, r) => n + r.offlineMs, 0),
      delay: round2(m.reduce((n, r) => n + delayHoursOf(r.code, touched), 0)) };
    return { ...g, assigned: has ? asg.pieces : null, achieve: has ? pct(asg.pieces, asg.target) : null,
      avgDay: has ? fv(`{col:production}{row}/${avgDivisor}`, (prod || 0) / avgDivisor) : null, avgShift: has ? fv(`{col:avgDay}{row}/${nShifts}`, (prod || 0) / avgDivisor / nShifts) : null,
      availability: pct(g.runningMs, windowMs * g.machines) } as Row;
  });
  const summary: Sheet = { name: 'Summary', blocks: [
    { title: `EKC SmartFactory — PRODUCTION REVIEW ${period}`, note: 'Pieces are confirmed counter steps (net of dry cycles, samples and other classified-away pieces), filed by production day and shift on the plant clock — the day runs from the first shift\'s start (07:00) to the next; Shift C belongs to the day it started. Targets exist only where a dia was assigned. A single-day Dashboard figure can differ from a month sheet by one counter bin at 07:00.',
      columns: [{ header: 'Report', key: 'k', width: 40 }, { header: '', key: 'v', width: 36 }],
      rows: [
        kv('Scope', scopeText),
        kv('Window', windowLabel),
        kv('From', from, 'datetime'), kv('To', act.to, 'datetime'),
        kv('Production days in window', touched.length, 'int'),
        kv('Report day (the PDWIP page)', reportDay ? dayCell(reportDay) : ''),
        kv('Working days (days with output — the AVG divisor)', workingDays, 'int'),
        kv('Shifts', shifts.map((s) => `${s.name} ${s.start}–${s.end}`).join(' · ')),
        kv('Generated', new Date(), 'datetime'), kv('Generated by', user?.name || ''),
        kv('Plant clock', `IST (UTC+${Math.floor(tzMin / 60)}:${String(tzMin % 60).padStart(2, '0')})`),
      ] },
    { title: 'FLEET TOTALS', columns: [{ header: 'Metric', key: 'k', width: 40 }, { header: 'Value', key: 'v', width: 36 }],
      rows: [
        kv('Machines in scope', rows.length, 'int'), kv('Machines that sent data', rows.filter((r) => r.live).length, 'int'),
        kv('Production (pieces)', production, 'int'), kv('Counters reporting', counters, 'int'),
        ...(targets ? [kv('Target (pieces, where a dia was assigned)', Math.round(tgtAll.target), 'int'), kv('Pieces made inside assigned hours', tgtAll.actual, 'int'), kv('Achievement vs target', pct(tgtAll.actual, tgtAll.target), 'pct0')]
          : [kv('Targets', 'not computed — window longer than 92 days')]),
        kv('Availability (runtime ÷ window)', availability, 'pct0'),
        kv('Runtime', runningMs, 'dur'), kv('Idle', idleMs, 'dur'), kv('Stopped', stoppedMs, 'dur'), kv('Downtime (idle + stopped)', idleMs + stoppedMs, 'dur'),
        kv('Signal lost (no data — not downtime)', offlineMs, 'dur'),
        kv('Downtime events in window', spansAll.length, 'int'), kv('Downtime open now', openNow, 'int'),
        kv(`Downtime with no reason recorded (includes spans under the ${askCfg.askAfterMin}-min ask threshold)`, pct(noReasonMs, reasonedMs), 'pct0'),
      ] },
    { title: 'BY SECTION', note: `PRODUCTION and TARGET from the plant grid; ACHIEVE % = pieces made inside assigned hours ÷ target; AVG / DAY = production ÷ ${workingDays} working day${workingDays === 1 ? '' : 's'}; DELAY HRS. from the downtime log (idle + stopped, while the machine was heard); runtime and availability from the activity engine.`,
      columns: [
        { header: 'SECTION', key: 'family', width: 30 }, { header: 'MACHINES', key: 'machines', fmt: 'int' }, { header: 'PRODUCTION', key: 'production', fmt: 'int', style: 'input' },
        { header: 'TARGET', key: 'target', fmt: 'int' }, { header: 'PCS IN ASSIGNED HRS', key: 'assigned', fmt: 'int' }, { header: 'ACHIEVE %', key: 'achieve', fmt: 'pct0' },
        { header: 'AVG / DAY', key: 'avgDay', fmt: 'dec1', style: 'avg' }, { header: 'AVG / SHIFT', key: 'avgShift', fmt: 'dec1', style: 'avg' },
        { header: 'RUNTIME', key: 'runningMs', fmt: 'dur' }, { header: 'IDLE', key: 'idleMs', fmt: 'dur' }, { header: 'STOPPED', key: 'stoppedMs', fmt: 'dur' },
        { header: 'DELAY HRS.', key: 'delay', fmt: 'dec1', style: 'delay' }, { header: 'SIGNAL LOST', key: 'offlineMs', fmt: 'dur' }, { header: 'AVAILABILITY', key: 'availability', fmt: 'pct0' },
      ],
      rows: [
        ...sectionRows,
        { __style: 'grand', family: 'TOTAL', machines: fv('SUM({col:machines}{first}:{col:machines}{last})', rows.length), production: fv('SUM({col:production}{first}:{col:production}{last})', production),
          target: fv('SUM({col:target}{first}:{col:target}{last})', Math.round(tgtAll.target)), assigned: fv('SUM({col:assigned}{first}:{col:assigned}{last})', tgtAll.actual), achieve: pct(tgtAll.actual, tgtAll.target),
          avgDay: fv(`{col:production}{row}/${avgDivisor}`, production / avgDivisor), avgShift: fv(`{col:avgDay}{row}/${nShifts}`, production / avgDivisor / nShifts),
          runningMs: fv('SUM({col:runningMs}{first}:{col:runningMs}{last})', runningMs), idleMs: fv('SUM({col:idleMs}{first}:{col:idleMs}{last})', idleMs), stoppedMs: fv('SUM({col:stoppedMs}{first}:{col:stoppedMs}{last})', stoppedMs),
          delay: fv('SUM({col:delay}{first}:{col:delay}{last})', round2((idleMs + stoppedMs) / HOUR_MS)), offlineMs: fv('SUM({col:offlineMs}{first}:{col:offlineMs}{last})', offlineMs), availability },
      ] },
    { title: 'NOT IN THIS WORKBOOK', note: NOT_INCLUDED, columns: [], rows: [] },
  ] };

  // ═══ 2 · PRODUCTION ANALYSIS — the month matrix, the plant's front sheet ═══
  // Rows: machines in process order, a subtotal per section, a grand TOTAL.
  // Columns: one per production day (d-mmm), TOTAL, required production
  // (from the assigned dias) with the pieces made inside those hours and the
  // achieve %, then the plant's per-shift block — real shift counts, not
  // day÷3 — and the averages over the visible working-days divisor.
  const matrixOk = days.length <= MAX_MATRIX_DAYS;
  const dayCols: Column[] = days.map((d) => ({ header: dayCell(d), key: dayKey(d), fmt: 'int', style: 'input', width: 7 }));
  const firstDay = dayKey(days[0] || ''), lastDay = dayKey(days[days.length - 1] || '');
  // A day outside the window, or one the machine was never heard on, is blank — not 0.
  const dayVal = (x: MachineDay | undefined, d: string, v: number): number | null => (inWindow.has(d) && (x?.readings || 0) > 0 ? v : null);
  const matrixBlockHead = {
    title: `PRODUCTION ANALYSIS - MONTH ${period}`,
    note: `Pieces per production day (${shifts[0]?.start || '07:00'} → ${shifts[0]?.start || '07:00'} next day, plant clock) · ${scopeText} · yellow = counted pieces, white = formulas · ACHIEVE % = pieces made inside assigned hours ÷ required · working days: ${workingDays} (the AVG divisor) · blank = outside the window, or no signal from the machine that day`,
    bands: [{ label: 'M/C SECTION', span: 1 }, { label: 'DAILY PRODUCTION (pieces)', span: Math.max(1, days.length) }, { label: 'MONTH', span: 5 }, { label: 'PER SHIFT', span: shiftCols.length }, { label: 'AVERAGE', span: 2 }],
  };
  const matrixCols: Column[] = [
    { header: 'M/C SECTION', key: 'name', width: 26 },
    ...dayCols,
    { header: 'TOTAL', key: 'total', fmt: 'int', style: 'bold', width: 9 },
    { header: 'REQ. PRODUCTION AS ON TODAY', key: 'target', fmt: 'int', width: 12 },
    { header: 'PCS IN ASSIGNED HRS', key: 'assigned', fmt: 'int', width: 10 },
    { header: 'ACHIEVE %', key: 'achieve', fmt: 'pct0', width: 9 },
    { header: 'DAYS WITH OUTPUT', key: 'wd', fmt: 'int', width: 8 },
    ...shiftCols.map((s, si) => ({ header: `${shiftHeader(s, si)} TOTAL`, key: `sh${si}`, fmt: 'int' as Fmt, width: 9 })),
    { header: `AVG / DAY (÷ ${workingDays})`, key: 'avgDay', fmt: 'dec1', style: 'avg', width: 9 },
    { header: 'AVG / SHIFT', key: 'avgShift', fmt: 'dec1', style: 'avg', width: 10 },
  ];
  const matrixRows: Row[] = [];
  const rowOf = (i: number): number => firstDataRow(matrixBlockHead) + i;   // sheet row of matrixRows[i]
  const sectionTotalRows: number[] = [];
  const sumFormula = (col: string, rowsList: number[]): string => rowsList.length ? `SUM(${rowsList.map((r) => `{col:${col}}${r}`).join(',')})` : '0';
  const rangeFormula = (col: string, a: number, b: number): string => `SUM({col:${col}}${a}:{col:${col}}${b})`;
  type Sums = { total: number; target: number; assigned: number; wd: number; sh: number[]; byDay: Record<string, number> };
  const perRow = (s: Sums): Row => ({
    total: fv(`SUM({col:${firstDay}}{row}:{col:${lastDay}}{row})`, s.total),
    achieve: fv('IF({col:target}{row}>0,{col:assigned}{row}/{col:target}{row},"")', s.target > 0 ? s.assigned / s.target : ''),
    wd: fv(`COUNTIF({col:${firstDay}}{row}:{col:${lastDay}}{row},">0")`, s.wd),
    avgDay: fv(`{col:total}{row}/${avgDivisor}`, s.total / avgDivisor),
    avgShift: fv(`{col:avgDay}{row}/${nShifts}`, s.total / avgDivisor / nShifts),
  });
  const zero = (): Sums => ({ total: 0, target: 0, assigned: 0, wd: 0, sh: new Array<number>(shiftCols.length).fill(0), byDay: Object.fromEntries(days.map((d) => [d, 0])) });
  const addTo = (a: Sums, b: Sums): void => { a.total += b.total; a.target += b.target; a.assigned += b.assigned; a.wd += b.wd; b.sh.forEach((v, i) => { a.sh[i] += v; }); for (const d of days) a.byDay[d] += b.byDay[d]; };
  const grandS = zero();
  let i = 0;
  for (const sec of sections) {
    const members = membersOf(sec).filter((r) => counted.get(r.code.toUpperCase()));   // a machine without a counter has no row here
    if (!members.length) continue;
    const start = rowOf(i);
    const secS = zero();
    for (const r of members) {
      const s = zero();
      const row: Row = { name: nameOf(r.code) };
      for (const d of days) {
        const x = md(r.code, d);
        const v = dayVal(x, d, x?.total || 0);
        row[dayKey(d)] = v; s.byDay[d] = v || 0; s.total += v || 0; if ((v || 0) > 0) s.wd += 1;
        s.target += x?.targetTotal || 0; s.assigned += x?.assignedTotal || 0;
        shiftCols.forEach((sh, si) => { s.sh[si] += x?.pieces[sh] || 0; });
      }
      Object.assign(row, perRow(s));
      row.target = Math.round(s.target) || null; row.assigned = s.target > 0 ? s.assigned : null;
      shiftCols.forEach((_, si) => { row[`sh${si}`] = s.sh[si]; });
      matrixRows.push(row); i += 1; addTo(secS, s);
    }
    const end = rowOf(i - 1);
    const sub: Row = { __style: 'total', name: `${sec} — TOTAL`, ...perRow(secS) };
    for (const d of days) sub[dayKey(d)] = inWindow.has(d) ? fv(rangeFormula(dayKey(d), start, end), secS.byDay[d]) : null;
    sub.total = fv(rangeFormula('total', start, end), secS.total);
    sub.target = fv(rangeFormula('target', start, end), Math.round(secS.target));
    sub.assigned = fv(rangeFormula('assigned', start, end), secS.assigned);
    shiftCols.forEach((_, si) => { sub[`sh${si}`] = fv(rangeFormula(`sh${si}`, start, end), secS.sh[si]); });
    sectionTotalRows.push(rowOf(i));
    matrixRows.push(sub); i += 1; addTo(grandS, secS);
  }
  const grand: Row = { __style: 'grand', name: 'TOTAL', ...perRow(grandS) };
  for (const d of days) grand[dayKey(d)] = inWindow.has(d) ? fv(sumFormula(dayKey(d), sectionTotalRows), grandS.byDay[d]) : null;
  grand.total = fv(sumFormula('total', sectionTotalRows), grandS.total);
  grand.target = fv(sumFormula('target', sectionTotalRows), Math.round(grandS.target));
  grand.assigned = fv(sumFormula('assigned', sectionTotalRows), grandS.assigned);
  shiftCols.forEach((_, si) => { grand[`sh${si}`] = fv(sumFormula(`sh${si}`, sectionTotalRows), grandS.sh[si]); });
  matrixRows.push(grand);
  const tooWide: Block = { title: `PRODUCTION ANALYSIS - MONTH ${period}`, note: `The day-by-day grid is built for windows of up to ${MAX_MATRIX_DAYS} production days; this window has ${days.length}. Select one month for the matrix — the detail sheets still cover the whole window.`, columns: [], rows: [] };
  const analysis: Sheet = { name: 'PRODUCTION ANALYSIS', landscape: true, blocks: [matrixOk ? { ...matrixBlockHead, columns: matrixCols, rows: matrixRows, freezeCols: 1, autoFilter: false } : tooWide] };

  // ═══ 3 · PER SHIFT — the same matrix, one row per machine per shift ═══════
  const shiftRows: Row[] = [];
  const shiftSums = new Map<string, Sums>(shiftCols.map((s) => [s, zero()]));
  for (const r of rows) {
    if (!counted.get(r.code.toUpperCase())) continue;
    for (const sh of shiftCols) {
      const s = zero();
      const row: Row = { name: nameOf(r.code), shift: sh };
      for (const d of days) {
        const x = md(r.code, d);
        const v = dayVal(x, d, x?.pieces[sh] || 0);
        row[dayKey(d)] = v; s.byDay[d] = v || 0; s.total += v || 0;
        s.target += x?.target[sh] || 0; s.assigned += x?.assignedPieces[sh] || 0;
      }
      row.total = fv(`SUM({col:${firstDay}}{row}:{col:${lastDay}}{row})`, s.total);
      row.target = Math.round(s.target) || null; row.assigned = s.target > 0 ? s.assigned : null;
      row.achieve = fv('IF({col:target}{row}>0,{col:assigned}{row}/{col:target}{row},"")', s.target > 0 ? s.assigned / s.target : '');
      row.avg = fv(`{col:total}{row}/${avgDivisor}`, s.total / avgDivisor);
      shiftRows.push(row); addTo(shiftSums.get(sh)!, s);
    }
  }
  // Fleet totals per shift — a SUMIF over the shift column, so the rows above stay the source.
  shiftCols.forEach((sh, si) => {
    const s = shiftSums.get(sh)!;
    const row: Row = { __style: 'grand', name: `ALL MACHINES — ${shiftHeader(sh, si)}`, shift: sh };
    const sumif = (col: string, v: Scalar): Cell => fv(`SUMIF({col:shift}{first}:{col:shift}{last},"${sh.replace(/"/g, '""')}",{col:${col}}{first}:{col:${col}}{last})`, v);
    for (const d of days) row[dayKey(d)] = inWindow.has(d) ? sumif(dayKey(d), s.byDay[d]) : null;
    row.total = sumif('total', s.total); row.target = sumif('target', Math.round(s.target)); row.assigned = sumif('assigned', s.assigned);
    row.achieve = fv('IF({col:target}{row}>0,{col:assigned}{row}/{col:target}{row},"")', s.target > 0 ? s.assigned / s.target : '');
    row.avg = fv(`{col:total}{row}/${avgDivisor}`, s.total / avgDivisor);
    shiftRows.push(row);
  });
  const perShift: Sheet = { name: 'PER SHIFT', landscape: true, blocks: [matrixOk ? {
    title: `PER SHIFT PRODUCTION ANALYSIS — ${period}`, note: `Pieces per shift per production day · ${scopeText} · ${shifts.map((s, si) => `${shiftHeader(s.name, si)} = ${s.name} ${s.start}–${s.end}`).join(', ')} (the night shift is booked on the day it started) · AVG / DAY = TOTAL ÷ ${workingDays} working day${workingDays === 1 ? '' : 's'}`,
    bands: [{ label: 'M/C SECTION', span: 2 }, { label: 'DAILY PRODUCTION (pieces)', span: Math.max(1, days.length) }, { label: 'MONTH', span: 5 }],
    columns: [{ header: 'M/C SECTION', key: 'name', width: 26 }, { header: 'SHIFT', key: 'shift', width: 9 }, ...dayCols,
      { header: 'TOTAL', key: 'total', fmt: 'int', style: 'bold', width: 9 }, { header: 'TARGET', key: 'target', fmt: 'int', width: 9 }, { header: 'PCS IN ASSIGNED HRS', key: 'assigned', fmt: 'int', width: 10 }, { header: 'ACHIEVE %', key: 'achieve', fmt: 'pct0', width: 9 }, { header: `AVG / DAY (÷ ${workingDays})`, key: 'avg', fmt: 'dec1', style: 'avg', width: 9 }],
    rows: shiftRows, freezeCols: 2, autoFilter: false,
  } : { ...tooWide, title: `PER SHIFT PRODUCTION ANALYSIS — ${period}` }] };

  // ═══ 4 · PDWIP — the plant's daily page for the report day ══════════════
  // Idle-hour columns are the plant's fixed categories — the admin's reason
  // list, in the admin's order, every column present even when empty, exactly
  // as the plant's sheet keeps its ten — then "Other (typed)" for what an
  // operator wrote in their own words, then "No reason recorded".
  const adminReasons = askCfg.reasons.map((r) => r.label);
  const OTHER = 'Other (typed)', NONE = 'No reason recorded';
  const reasonCols = [...adminReasons, OTHER, NONE];
  const reasonKey = (i: number): string => `r${i}`;
  const reasonIndex = (k: string): number => {
    if (!k) return reasonCols.length - 1;
    const i = adminReasons.findIndex((r) => r.toLowerCase() === k.toLowerCase());
    return i >= 0 ? i : reasonCols.length - 2;
  };
  const reasonMsOf = (x: MachineDay | undefined): number[] => {
    const out = new Array<number>(reasonCols.length).fill(0);
    for (const [k, ms] of Object.entries(x?.downtimeByReason || {})) out[reasonIndex(k)] += ms;
    return out;
  };
  const reasonColumns: Column[] = reasonCols.map((k, ri) => ({ header: k, key: reasonKey(ri), fmt: 'dec1' as Fmt, style: 'delay' as const, width: 10 }));
  const delayFormula = `SUM({col:${reasonKey(0)}}{row}:{col:${reasonKey(reasonCols.length - 1)}}{row})`;
  /** One PDWIP row for a machine on a day — shared by the report page and the daily log. */
  const pdwipRow = (r: ActivityRow, d: string, cum: number | null, withStatus: boolean): Row => {
    const x = md(r.code, d);
    const has = !!counted.get(r.code.toUpperCase()) && (x?.readings || 0) > 0;
    const hrs = reasonMsOf(x).map(hoursOf);
    const row: Row = {
      name: nameOf(r.code), section: familyOf(r.code),
      size: x?.diaNames.length ? x.diaNames.join(' , ') : '',
      cycle: x?.dia?.cycleSec ?? null,
      norms: has ? norm(x) : null,
      total: has ? fv(`SUM({col:s0}{row}:{col:s${shiftCols.length - 1}}{row})`, x?.total || 0) : null,
      cum: has ? cum : null,
      shiftsN: x ? (shiftNames.filter((s) => (x.target[s] || 0) > 0).length || shiftNames.filter((s) => (x.pieces[s] || 0) > 0).length) || null : null,
      target: x && x.targetTotal > 0 ? Math.round(x.targetTotal) : null,
      assigned: x && x.targetTotal > 0 ? x.assignedTotal : null,
      pctNorm: has && x && x.targetTotal > 0 ? fv('IF({col:target}{row}>0,{col:assigned}{row}/{col:target}{row},"")', x.assignedTotal / x.targetTotal) : null,
      delay: fv(delayFormula, round2(hrs.reduce((n, v) => n + v, 0))),
      offH: hoursOf(x?.downtimeMs.offline || 0),
      reasons: x?.reasonsText || '', status: withStatus ? statusNow(r.code) : '',
    };
    shiftCols.forEach((s, si) => { row[`s${si}`] = has ? (x?.pieces[s] || 0) : null; });
    hrs.forEach((h, ri) => { row[reasonKey(ri)] = h; });
    return row;
  };
  const pdwipColumns: Column[] = [
    { header: 'M/C SECTION', key: 'name', width: 22 }, { header: 'SIZE (dia)', key: 'size', width: 24 },
    { header: 'CYCLE (s)', key: 'cycle', fmt: 'int', width: 8 }, { header: 'NORMS / SHIFT', key: 'norms', fmt: 'int', width: 9 },
    ...shiftCols.map((s, si) => ({ header: shiftHeader(s, si), key: `s${si}`, fmt: 'int' as Fmt, width: 9 })),
    { header: 'TOTAL', key: 'total', fmt: 'int', style: 'bold', width: 9 }, { header: 'MONTHLY CUM.', key: 'cum', fmt: 'int', width: 10 }, { header: 'SHIFTS', key: 'shiftsN', fmt: 'int', width: 7 },
    { header: 'DAY NORM', key: 'target', fmt: 'int', width: 9 }, { header: 'PCS IN ASSIGNED HRS', key: 'assigned', fmt: 'int', width: 10 }, { header: 'NORMS vs ACTUAL (%)', key: 'pctNorm', fmt: 'pct0', width: 10 },
    ...reasonColumns,
    { header: 'TOTAL DELAY HRS.', key: 'delay', fmt: 'dec1', style: 'delay', width: 10 }, { header: 'SIGNAL LOST HRS.', key: 'offH', fmt: 'dec1', width: 10 },
    { header: 'REASONS', key: 'reasons', width: 40 }, { header: "TODAY'S STATUS", key: 'status', width: 12 },
  ];
  const pdwipBands = (lead: number): Block['bands'] => [
    { label: '', span: lead }, { label: 'SIZE', span: 1 }, { label: 'NORMS', span: 2 }, { label: 'PRODUCTION (pieces)', span: shiftCols.length + 3 }, { label: 'NORMS vs ACTUAL', span: 3 },
    { label: 'IDLE HRS. BY REASON', span: reasonCols.length, style: 'delay' }, { label: 'DELAY', span: 2 }, { label: '', span: 2 },
  ];
  const cumTo = (code: string, day: string): number => priorTotal(code, day) + touched.filter((d) => sameMonth(d) && d <= day).reduce((n, d) => n + (md(code, d)?.total || 0), 0);
  const reportRows: Row[] = reportDay ? rows.map((r) => pdwipRow(r, reportDay, cumTo(r.code, reportDay), true)) : [];
  const sumCols = [...shiftCols.map((_, si) => `s${si}`), 'total', 'cum', 'target', 'assigned', ...reasonCols.map((_, ri) => reasonKey(ri)), 'delay', 'offH'];
  const num = (c: Cell): number => (typeof c === 'number' ? c : c && typeof c === 'object' && !(c instanceof Date) && typeof c.v === 'number' ? c.v : 0);
  const totalRow = (label: string, of: Row[]): Row => {
    const t: Row = { __style: 'grand', name: label };
    for (const c of sumCols) t[c] = fv(`SUM({col:${c}}{first}:{col:${c}}{last})`, round2(of.reduce((n, r) => n + num(r[c]), 0)));
    const tg = num(t.target), asg = num(t.assigned);
    t.pctNorm = fv('IF({col:target}{row}>0,{col:assigned}{row}/{col:target}{row},"")', tg > 0 ? asg / tg : '');
    return t;
  };
  // The month's cumulative statistics per section — the plant's rows 87–102,
  // one divisor for every row (their $B$88).
  const monthWorkingDays = new Set([...(prior?.rows || []).filter((x) => x.total > 0).map((x) => x.day), ...monthDays.filter((d) => rows.some((r) => (md(r.code, d)?.total || 0) > 0))]).size;
  const mwd = Math.max(1, monthWorkingDays);
  const sectionStats: Row[] = sections.map((sec) => {
    const m = membersOf(sec);
    const has = sectionCounts(sec);
    const daily = m.reduce((n, r) => n + (md(r.code, reportDay || '')?.total || 0), 0);
    const cum = m.reduce((n, r) => n + cumTo(r.code, reportDay || ''), 0);
    const wd = new Set([...(prior?.rows || []).filter((x) => m.some((r) => r.code.toUpperCase() === x.code.toUpperCase()) && x.total > 0).map((x) => x.day), ...monthDays.filter((d) => m.some((r) => (md(r.code, d)?.total || 0) > 0))]).size;
    return { section: sec, machines: m.length, daily: has ? daily : 'no piece counter', cum: has ? cum : null, wd: has ? wd : null, avg: has ? fv(`{col:cum}{row}/${mwd}`, cum / mwd) : null,
      delayDay: round2(m.reduce((n, r) => n + delayHoursOf(r.code, reportDay ? [reportDay] : []), 0)), delayMonth: round2(m.reduce((n, r) => n + delayHoursOf(r.code, monthDays), 0)) };
  });
  const statTotal = (c: string): number => sectionStats.reduce((n, r) => n + num(r[c]), 0);
  const report: Sheet = { name: 'PDWIP', landscape: true, blocks: reportDay ? [
    { title: `PRODUCTION REPORT — DATE ${dayLabel(reportDay)}`,
      note: `The production day ${dayLabel(reportDay)} (${shifts[0]?.start || '07:00'} → ${shifts[0]?.start || '07:00'} next day) · ${scopeText}. NORMS/SHIFT = pieces a full shift makes at the assigned dia's cycle time; DAY NORM = the day's target for the hours a dia was assigned (planned breaks excluded) and NORMS vs ACTUAL compares the pieces made in those hours with it; blank = no dia assigned or no signal. Idle hours are the recorded idle/stopped spans while the machine was heard, filed under the operator's reason ("${NONE}" includes spans shorter than the ${askCfg.askAfterMin}-minute ask threshold); signal lost is kept apart. MONTHLY CUM. runs from the 1st of the month.`,
      bands: pdwipBands(1), columns: pdwipColumns, rows: [...reportRows, totalRow('TOTAL', reportRows)], freezeCols: 1 },
    { title: `CURRENT MONTH'S CUMULATIVE STATISTICS — ${monthOf(reportDay)} to ${dayLabel(reportDay)}`,
      note: `AVG / DAY = TOTAL CUM. ÷ ${monthWorkingDays} working day${monthWorkingDays === 1 ? '' : 's'} (days this month with any output); WORKING DAYS per section is information only.`,
      columns: [
        { header: 'SECTION', key: 'section', width: 30 }, { header: 'MACHINES', key: 'machines', fmt: 'int' }, { header: 'DAILY PRD', key: 'daily', fmt: 'int', style: 'input' }, { header: 'TOTAL CUM.', key: 'cum', fmt: 'int' },
        { header: 'WORKING DAYS', key: 'wd', fmt: 'int' }, { header: `AVG / DAY (÷ ${monthWorkingDays})`, key: 'avg', fmt: 'dec1', style: 'avg' }, { header: 'DAILY DELAY HRS.', key: 'delayDay', fmt: 'dec1', style: 'delay' }, { header: 'MONTH DELAY HRS.', key: 'delayMonth', fmt: 'dec1', style: 'delay' },
      ],
      rows: [...sectionStats, { __style: 'grand', section: 'TOTAL', machines: fv('SUM({col:machines}{first}:{col:machines}{last})', rows.length), daily: fv('SUM({col:daily}{first}:{col:daily}{last})', statTotal('daily')), cum: fv('SUM({col:cum}{first}:{col:cum}{last})', statTotal('cum')), wd: monthWorkingDays, avg: fv(`{col:cum}{row}/${mwd}`, statTotal('cum') / mwd), delayDay: fv('SUM({col:delayDay}{first}:{col:delayDay}{last})', round2(statTotal('delayDay'))), delayMonth: fv('SUM({col:delayMonth}{first}:{col:delayMonth}{last})', round2(statTotal('delayMonth'))) }] },
    { title: 'WORKING DAYS', columns: [{ header: '', key: 'k', width: 40 }, { header: '', key: 'v', fmt: 'int', width: 12 }],
      rows: [{ k: 'Working days so far this month (days with output)', v: monthWorkingDays }, { k: 'Report day', v: dayCell(reportDay) }] },
  ] : [{ title: 'PDWIP', note: 'No production day inside the selected window.', columns: [], rows: [] }] };

  // ═══ 5 · DAILY LOG — the PDWIP row for every machine on every day ════════
  const dailyRows: Row[] = [];
  for (const r of rows) {
    let cum = 0; let month = '';
    for (const d of touched) {
      if (d.slice(0, 7) !== month) { month = d.slice(0, 7); cum = d === touched[0] ? priorTotal(r.code, d) : 0; }   // the plant's cumulative restarts each month
      cum += md(r.code, d)?.total || 0;
      dailyRows.push({ day: dayCell(d), ...pdwipRow(r, d, cum, d === touched[touched.length - 1]) });
    }
  }
  const daily: Sheet = { name: 'DAILY LOG', landscape: true, blocks: [{
    title: `PRODUCTION REPORT — ${period} — every day`, note: `One row per machine per production day (the PDWIP page for each day of the window; same columns and rules). ${scopeText}`,
    bands: pdwipBands(3),
    columns: [{ header: 'DATE', key: 'day', fmt: 'date', width: 8 }, pdwipColumns[0], { header: 'SECTION', key: 'section', width: 24 }, ...pdwipColumns.slice(1)],
    rows: dailyRows, freezeCols: 2,
  }] };

  // ═══ 6 · Machines ═══════════════════════════════════════════════════════
  const machines: Sheet = { name: 'Machines', blocks: [{
    note: 'Production and target from the plant grid (the same figures as PRODUCTION ANALYSIS); runtime, idle, stopped and signal lost from the activity engine; downtime events from the span log.',
    columns: [
    { header: 'Machine', key: 'name', width: 18 }, { header: 'Code', key: 'code', width: 22 }, { header: 'Section', key: 'family', width: 26 }, { header: 'Type', key: 'type', width: 14 },
    { header: 'Status now', key: 'now', width: 12 }, { header: 'State in window', key: 'state', width: 14 }, { header: 'Sent data', key: 'live', width: 10 }, { header: 'Readings', key: 'readings', fmt: 'int' },
    { header: 'First seen', key: 'firstSeen', fmt: 'datetime', width: 18 }, { header: 'Last seen', key: 'lastSeen', fmt: 'datetime', width: 18 },
    { header: 'Production', key: 'production', fmt: 'int' }, { header: 'Counter', key: 'counter', width: 20 },
    { header: 'Runtime', key: 'runningMs', fmt: 'dur' }, { header: 'Idle', key: 'idleMs', fmt: 'dur' }, { header: 'Stopped', key: 'stoppedMs', fmt: 'dur' }, { header: 'Signal lost', key: 'offlineMs', fmt: 'dur' },
    { header: 'Availability', key: 'availability', fmt: 'pct0' }, { header: 'Downtime events', key: 'events', fmt: 'int' }, { header: 'MTBF', key: 'mtbf', fmt: 'dur' }, { header: 'MTTR', key: 'mttr', fmt: 'dur' },
    { header: 'Current dia', key: 'dia', width: 18 }, { header: 'Stage', key: 'stage', width: 14 }, { header: 'Cycle (s)', key: 'cycle', fmt: 'int' },
    { header: 'Target', key: 'target', fmt: 'int' }, { header: 'Pcs in assigned hrs', key: 'assigned', fmt: 'int' }, { header: 'Achievement', key: 'achievement', fmt: 'pct0' },
  ], rows: rows.map((r) => {
    const ev = eventsBy.get(r.code.toUpperCase()) || 0;
    const dia = diaOf.get(r.code.toUpperCase());
    const has = !!counted.get(r.code.toUpperCase());
    const asg = machineAssigned(r.code, touched);
    return {
      name: nameOf(r.code), code: r.code, family: familyOf(r.code), type: r.type || '', now: statusNow(r.code), state: r.status === 'offline' ? 'signal lost' : r.status,
      live: r.live, readings: r.readings, firstSeen: r.firstSeen ? new Date(r.firstSeen) : null, lastSeen: r.lastSeen ? new Date(r.lastSeen) : null,
      production: has ? machineTotal(r.code, touched) : null, counter: r.productionFrom ? `from ${nameOf(r.productionFrom)}` : (r.productionKey || ''),
      runningMs: r.runningMs, idleMs: r.idleMs, stoppedMs: r.stoppedMs, offlineMs: r.offlineMs, availability: pct(r.runningMs, windowMs),
      events: ev, mtbf: ev ? r.runningMs / ev : null, mttr: ev ? downOf(r) / ev : null,
      dia: dia?.diaName || '', stage: dia?.stageName || '', cycle: dia?.processingSec ?? null,
      target: has && asg.target > 0 ? Math.round(asg.target) : null, assigned: has && asg.target > 0 ? asg.pieces : null, achievement: has ? pct(asg.pieces, asg.target) : null,
    };
  }) }] };

  // ═══ 7 · BY DIA (size) — the plant's "TOTAL QTY PRD": pieces per size per stage ═══
  const stageOrder = ['Cutting', 'SPG', 'Bottom Milling', 'Furnace', 'ISB', 'Internal Shot Blasting', 'CNC Lathe'];
  const stagesSeen = [...new Set([...tgtByMachineDia.values()].map((t) => t.stage))].sort((a, b) => {
    const ia = stageOrder.findIndex((s) => s.toLowerCase() === a.toLowerCase()), ib = stageOrder.findIndex((s) => s.toLowerCase() === b.toLowerCase());
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.localeCompare(b);
  });
  const stageKey = (i: number): string => `st${i}`;
  const byDia = new Map<string, { dia: string; dims: string; actual: number[]; target: number[]; machines: Set<string> }>();
  for (const t of tgtByMachineDia.values()) {
    const g = byDia.get(t.dia) || { dia: t.dia, dims: t.dims, actual: new Array<number>(stagesSeen.length).fill(0), target: new Array<number>(stagesSeen.length).fill(0), machines: new Set<string>() };
    const si = stagesSeen.indexOf(t.stage);
    g.actual[si] += t.actual; g.target[si] += t.target; g.machines.add(nameOf(t.machineRef));
    byDia.set(t.dia, g);
  }
  const diaTotals = stagesSeen.map((_, i) => [...byDia.values()].reduce((n, g) => n + g.actual[i], 0));
  const diaTargets = stagesSeen.map((_, i) => [...byDia.values()].reduce((n, g) => n + g.target[i], 0));
  const diaSheet: Sheet = { name: 'BY DIA (size)', blocks: [{
    title: `PRODUCTION BY DIA / SIZE — ${period}`,
    note: targets ? 'Pieces per size at each stage with a machine behind it, for hours a dia was assigned. TARGET = assigned time ÷ cycle time. These are pieces made, not stock: WIP between stages needs opening balances and scrap this system does not hold. Stages without telemetry (HQT, HST, marking, painting, dispatch) are not shown.' : 'Not computed — the window is longer than 92 days.',
    bands: [{ label: 'SIZE', span: 2 }, { label: 'PIECES MADE', span: Math.max(1, stagesSeen.length) }, { label: 'TARGET', span: Math.max(1, stagesSeen.length) }, { label: '', span: 1 }],
    columns: [
      { header: 'DIA', key: 'dia', width: 20 }, { header: 'DIMS', key: 'dims', width: 16 },
      ...stagesSeen.map((s, i) => ({ header: s.toUpperCase(), key: stageKey(i), fmt: 'int' as Fmt, style: 'input' as const, width: 12 })),
      ...stagesSeen.map((s, i) => ({ header: `${s.toUpperCase()} TGT`, key: `t${stageKey(i)}`, fmt: 'int' as Fmt, width: 12 })),
      { header: 'MACHINES', key: 'machines', width: 30 },
    ],
    rows: [
      ...[...byDia.values()].sort((a, b) => b.actual.reduce((n, v) => n + v, 0) - a.actual.reduce((n, v) => n + v, 0) || a.dia.localeCompare(b.dia)).map((g) => ({
        dia: g.dia, dims: g.dims, machines: [...g.machines].sort().join(', '),
        ...Object.fromEntries(stagesSeen.map((_, i) => [stageKey(i), g.actual[i]])),
        ...Object.fromEntries(stagesSeen.map((_, i) => [`t${stageKey(i)}`, Math.round(g.target[i])])),
      })),
      ...(byDia.size ? [{ __style: 'grand' as const, dia: 'TOTAL', ...Object.fromEntries(stagesSeen.flatMap((_, i) => [[stageKey(i), fv(`SUM({col:${stageKey(i)}}{first}:{col:${stageKey(i)}}{last})`, diaTotals[i])], [`t${stageKey(i)}`, fv(`SUM({col:t${stageKey(i)}}{first}:{col:t${stageKey(i)}}{last})`, Math.round(diaTargets[i]))]])) }] : []),
    ],
  }] };

  // ═══ 8 · Targets ════════════════════════════════════════════════════════
  const targetSheet: Sheet = { name: 'Targets', blocks: [{
    note: targets ? 'One row per machine and dia that was assigned inside the window. Target = assigned time (minus planned breaks) ÷ cycle time; the adjusted target also excludes measured downtime. Actual = pieces made inside the assigned hours.' : 'Not computed — the window is longer than 92 days.',
    columns: [
      { header: 'Machine', key: 'name', width: 18 }, { header: 'Dia', key: 'dia', width: 18 }, { header: 'Dims', key: 'dims', width: 16 }, { header: 'Stage', key: 'stage', width: 14 },
      { header: 'Cycle (s)', key: 'cycle', fmt: 'int' }, { header: 'Assigned time', key: 'assigned', fmt: 'dur' }, { header: 'Breaks', key: 'breaks', fmt: 'dur' }, { header: 'Downtime', key: 'down', fmt: 'dur' },
      { header: 'Target', key: 'target', fmt: 'int' }, { header: 'Target excl. downtime', key: 'targetAdj', fmt: 'int' }, { header: 'Actual', key: 'actual', fmt: 'int' }, { header: 'Achievement', key: 'achievement', fmt: 'pct0' },
      { header: 'Operators', key: 'operators', width: 24 },
    ],
    rows: [...tgtByMachineDia.values()].sort((a, b) => flowCompare(a.machineRef, b.machineRef) || a.dia.localeCompare(b.dia)).map((t) => ({
      name: nameOf(t.machineRef), dia: t.dia, dims: t.dims, stage: t.stage, cycle: t.processingSec,
      assigned: t.assignedSec * 1000, breaks: t.breakSec * 1000, down: t.downtimeSec * 1000,
      target: Math.round(t.target), targetAdj: Math.round(t.targetAdj), actual: t.actual, achievement: pct(t.actual, t.target), operators: [...t.operators].join(', '),
    })),
  }] };

  // ═══ 9 · Downtime by reason — the PDWIP idle band summed for the window ═══
  // Same source as the PDWIP columns (clipped to presence, split at every
  // shift edge), grouped the same way, so this sheet's rows are those
  // columns added up — plus the per-type and per-shift split.
  const shiftKeys = shiftCols;   // the off-shift bucket exists only when the shifts leave a gap
  type ReasonAgg = { key: string; events: number; ms: number; idle: number; stopped: number; byShift: Record<string, number> };
  const byReason = new Map<number, ReasonAgg>();
  for (const x of plant.rows) {
    for (const [k, ms] of Object.entries(x.downtimeByReason)) {
      const i = reasonIndex(k);
      const a = byReason.get(i) || { key: reasonCols[i], events: 0, ms: 0, idle: 0, stopped: 0, byShift: {} };
      a.ms += ms; a.events += x.reasonEvents[k] || 0;
      a.idle += x.reasonType[k]?.idle || 0; a.stopped += x.reasonType[k]?.stopped || 0;
      for (const [sh, v] of Object.entries(x.reasonShift[k] || {})) a.byShift[sh] = (a.byShift[sh] || 0) + v;
      byReason.set(i, a);
    }
  }
  const reasonTotal = [...byReason.values()].reduce((n, a) => n + a.ms, 0);
  const reasonRows = [...byReason.entries()].sort((a, b) => a[0] - b[0]).map(([, a]) => a);
  const reasonSheet: Sheet = { name: 'Downtime by reason', blocks: [{
    title: `DOWNTIME BY REASON — ${period}`,
    note: `Idle and stopped hours while the machine was heard, clipped to the window and split at every shift edge, filed under the operator's reason — the PDWIP idle band summed for the window. "${NONE}" includes spans shorter than the ${askCfg.askAfterMin}-minute ask threshold. Signal lost is not downtime and is not here.`,
    columns: [
      { header: 'REASON', key: 'reason', width: 28 }, { header: 'EVENTS', key: 'events', fmt: 'int' }, { header: 'HOURS', key: 'hrs', fmt: 'dec1', style: 'delay' }, { header: 'SHARE', key: 'share', fmt: 'pct0' },
      { header: 'IDLE HRS.', key: 'idle', fmt: 'dec1' }, { header: 'STOPPED HRS.', key: 'stopped', fmt: 'dec1' },
      ...shiftKeys.map((n, i) => ({ header: `${shiftHeader(n, i)} HRS.`, key: `shift:${n}`, fmt: 'dec1' as Fmt })),
    ],
    rows: [
      ...reasonRows.map((a) => ({
        reason: a.key, events: a.events, hrs: hoursOf(a.ms), share: pct(a.ms, reasonTotal), idle: hoursOf(a.idle), stopped: hoursOf(a.stopped),
        ...Object.fromEntries(shiftKeys.map((n) => [`shift:${n}`, hoursOf(a.byShift[n] || 0)])),
      })),
      ...(reasonRows.length ? [{ __style: 'grand' as const, reason: 'TOTAL', events: fv('SUM({col:events}{first}:{col:events}{last})', reasonRows.reduce((n, a) => n + a.events, 0)), hrs: fv('SUM({col:hrs}{first}:{col:hrs}{last})', hoursOf(reasonTotal)), share: reasonTotal ? 1 : null,
        idle: fv('SUM({col:idle}{first}:{col:idle}{last})', hoursOf(reasonRows.reduce((n, a) => n + a.idle, 0))), stopped: fv('SUM({col:stopped}{first}:{col:stopped}{last})', hoursOf(reasonRows.reduce((n, a) => n + a.stopped, 0))),
        ...Object.fromEntries(shiftKeys.map((n) => [`shift:${n}`, fv(`SUM({col:shift:${n}}{first}:{col:shift:${n}}{last})`, hoursOf(reasonRows.reduce((s, a) => s + (a.byShift[n] || 0), 0)))])) }] : []),
    ],
  }] };

  // ═══ 10 · Downtime events ═══════════════════════════════════════════════
  const downtimeSheet: Sheet = { name: 'Downtime events', blocks: [{
    note: `The span log as recorded (not clipped to the machine's presence — the review sheets are)${spans.length >= MAX_ROWS ? `; the first ${MAX_ROWS} spans of the window — narrow the window for the rest` : ''}.`,
    columns: [
      { header: 'Machine', key: 'name', width: 18 }, { header: 'Type', key: 'type', width: 10 }, { header: 'Started', key: 'startedAt', fmt: 'datetime', width: 18 }, { header: 'Ended', key: 'endedAt', fmt: 'datetime', width: 18 },
      { header: 'Duration', key: 'duration', fmt: 'dur' }, { header: 'In window', key: 'inWindow', fmt: 'dur' }, { header: 'Shift', key: 'shift', width: 10 },
      { header: 'Reason', key: 'reason', width: 26 }, { header: 'Given by', key: 'reportedBy', width: 16 }, { header: 'How', key: 'source', width: 10 }, { header: 'Reason at', key: 'reasonAt', fmt: 'datetime', width: 18 },
      { header: 'Acknowledged', key: 'ack', width: 12 }, { header: 'By', key: 'ackBy', width: 16 }, { header: 'At', key: 'ackAt', fmt: 'datetime', width: 18 },
    ],
    rows: spans.map((s) => ({
      name: nameOf(s.machineId), type: s.type === 'offline' ? 'signal lost' : s.type, startedAt: s.startedAt, endedAt: s.endedAt,
      duration: (s.endedAt ? new Date(s.endedAt).getTime() : Date.now()) - new Date(s.startedAt).getTime(), inWindow: clipMs(s.startedAt, s.endedAt, fromMs, toMs),
      shift: shiftNameAt(shifts, minuteOfDay(new Date(s.startedAt), tzMin)),
      reason: s.reason || '', reportedBy: s.reportedBy || '', source: s.reasonSource === 'popup' ? 'popup' : s.reasonSource === 'edit' ? 'entered' : '', reasonAt: s.reasonAt,
      ack: !!s.acknowledged, ackBy: s.acknowledgedBy || '', ackAt: s.acknowledgedAt,
    })),
  }] };

  // ═══ 11 · Production events ═════════════════════════════════════════════
  const prodSheet: Sheet = { name: 'Production events', blocks: [{
    note: `Every counter advance in the window${prodEvents.length >= MAX_ROWS ? ` (first ${MAX_ROWS} — narrow the window for the rest)` : ''}. "Counts" = the classification is production; pieces that do not count are already excluded from every production figure.`,
    columns: [
      { header: 'Machine', key: 'name', width: 18 }, { header: 'Time', key: 'startedAt', fmt: 'datetime', width: 18 }, { header: 'Counter', key: 'paramKey', width: 18 },
      { header: 'Before', key: 'prev', fmt: 'int' }, { header: 'After', key: 'next', fmt: 'int' }, { header: 'Pieces', key: 'delta', fmt: 'int' },
      { header: 'Classification', key: 'cls', width: 16 }, { header: 'Counts', key: 'counts', width: 8 }, { header: 'Answered by', key: 'by', width: 16 }, { header: 'How', key: 'source', width: 10 },
      { header: 'Operator', key: 'operator', width: 16 }, { header: 'Edit reason', key: 'editReason', width: 24 }, { header: 'Note', key: 'note', width: 18 },
    ],
    rows: prodEvents.map((e) => {
      const meta = (e.meta || {}) as { reset?: boolean; implausible?: boolean };
      const opt = e.classification ? classOf.get(e.classification) : undefined;
      return {
        name: nameOf(e.machineId), startedAt: e.startedAt, paramKey: e.paramKey || '', prev: e.prevValue, next: e.newValue, delta: meta.reset ? null : e.delta,
        cls: meta.reset ? 'Counter reset' : (opt?.label || e.classification || ''), counts: meta.reset ? null : (opt ? opt.counts : null),
        by: e.classSource === 'operator' || e.classSource === 'edit' ? (e.classifiedBy?.name || '') : '',
        source: e.classSource === 'operator' ? 'popup' : e.classSource === 'edit' ? 'corrected' : e.classSource === 'timeout' ? 'no answer' : e.classSource === 'default' ? 'default' : '',
        operator: e.operatorName || '', editReason: e.editReason || '', note: meta.implausible ? 'not credited (implausible jump)' : '',
      };
    }),
  }] };

  // ═══ 12 · Reliability ═══════════════════════════════════════════════════
  const reliabilitySheet: Sheet = { name: 'Reliability', blocks: [{
    note: 'Availability = runtime ÷ window. MTBF = runtime ÷ downtime events; MTTR = downtime ÷ events. Time from the activity engine; events are the recorded idle/stopped/signal-lost spans overlapping the window.',
    columns: [
      { header: 'Machine', key: 'name', width: 18 }, { header: 'Availability', key: 'availability', fmt: 'pct0' }, { header: 'Runtime', key: 'runningMs', fmt: 'dur' },
      { header: 'Downtime', key: 'downMs', fmt: 'dur' }, { header: 'Signal lost', key: 'offlineMs', fmt: 'dur' }, { header: 'Events', key: 'events', fmt: 'int' }, { header: 'MTBF', key: 'mtbf', fmt: 'dur' }, { header: 'MTTR', key: 'mttr', fmt: 'dur' },
    ],
    rows: [...rows].filter((r) => r.readings > 0 || downOf(r) + r.offlineMs > 0).sort((a, b) => downOf(b) - downOf(a)).map((r) => {
      const ev = eventsBy.get(r.code.toUpperCase()) || 0;
      return { name: nameOf(r.code), availability: pct(r.runningMs, windowMs), runningMs: r.runningMs, downMs: downOf(r), offlineMs: r.offlineMs, events: ev, mtbf: ev ? r.runningMs / ev : null, mttr: ev ? downOf(r) / ev : null };
    }),
  }] };

  const book = buildXlsx([summary, analysis, perShift, report, daily, machines, diaSheet, targetSheet, reasonSheet, downtimeSheet, prodSheet, reliabilitySheet], tzMin);
  const file = `EKC_SmartFactory_${one ? one.replace(/[^A-Za-z0-9]+/g, '_') + '_' : ''}${stamp(from, tzMin).slice(0, 10)}_to_${stamp(act.to, tzMin).slice(0, 10)}.xlsx`;
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${file}"`);
  res.setHeader('Cache-Control', 'no-store');
  return res.send(book);
});
