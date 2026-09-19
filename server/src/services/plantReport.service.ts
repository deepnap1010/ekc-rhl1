// server/src/services/plantReport.service.ts
// The plant's own review grid, computed: for every machine and every
// PRODUCTION DAY of a window (the day starts with the first shift — 07:00 on
// the plant clock — not at midnight), the pieces made in each shift, the
// day's total, the target the assigned dia set for each shift and the pieces
// made inside those assigned hours, the downtime split by the operator's
// reason, and the dia that was running. This is what the plant's "PDWIP" and
// "PRODUCTION ANALYSIS" sheets hold, from the same engines every screen
// reads: confirmed counter steps (counters.service, net of classified-away
// pieces), the target rows (targets.service), the span log.
//
// Downtime is only ever booked for time the machine was HEARD. The span log
// can hold a span that outlived its machine (a collector that died with the
// status frozen), and it holds nothing at all for hours the sweep was not
// running; both would put invented hours under a reason column. So spans are
// clipped to the machine's presence — first reading to last reading plus the
// 10-minute silence rule every pill applies — and whatever lies outside is
// signal lost, never idle or stopped. A day the machine was never heard has
// no pieces (blank, not 0) and its dark hours are signal lost.
//
// Buckets are computed in Node from the plant-clock offset the caller
// passes (IST = +330), never from the server's zone or a browser's: the
// factory box and a review copy elsewhere must file 14:58 into Shift A of
// the same day.
import { DowntimeEvent } from '../models/DowntimeEvent.js';
import { MachineAssignment } from '../models/MachineAssignment.js';
import { Telemetry } from '../models/Telemetry.js';
import { refCandidates } from '../utils/machineRef.js';
import { productionEventsBy } from './counters.service.js';
import { computeTargets, type TargetRow } from './targets.service.js';
import type { Span } from './activity.service.js';

export interface ShiftDef { name: string; start: string; end: string }
export interface MachineDay {
  code: string;
  day: string;                                    // YYYY-MM-DD of the production day (plant clock)
  readings: number;                               // telemetry rows heard on this day — 0 = the machine was dark all day
  pieces: Record<string, number>;                 // per shift name
  total: number;
  target: Record<string, number>;                 // per shift — 0 where no dia was assigned
  targetTotal: number;
  assignedPieces: Record<string, number>;         // pieces made INSIDE assigned hours, per shift — the achievement numerator
  assignedTotal: number;
  downtimeMs: { idle: number; stopped: number; offline: number };
  downtimeByReason: Record<string, number>;       // ms, '' = no reason given (idle + stopped only)
  reasonType: Record<string, { idle: number; stopped: number }>;   // the same ms, split by span type
  reasonShift: Record<string, Record<string, number>>;   // ms per reason per shift
  reasonEvents: Record<string, number>;           // spans per reason that STARTED on this day
  reasonsText: string;                            // the distinct reasons, joined — the plant's REASONS column
  dia: { name: string; dims: string; stage: string; cycleSec: number } | null;   // the assignment covering most of the day
  diaNames: string[];                             // every dia assigned on the day, most time first
}
export interface PlantReport {
  from: Date; to: Date;
  days: string[];                                 // every production day touched by the window, ascending
  shifts: ShiftDef[];
  machines: string[];                             // codes, as given
  rows: MachineDay[];                             // one per machine per day, machines × days
  byMachineDay: Map<string, MachineDay>;          // `${CODE}|${day}`
}

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const MIN_MS = 60_000;
const NETWORK_LOST_MS = 10 * MIN_MS;   // the same silence rule the pills and the sweep apply
const toMin = (hhmm: string): number => {
  const [h, m] = String(hhmm || '').split(':').map(Number);
  return (Number.isFinite(h) ? h : 0) * 60 + (Number.isFinite(m) ? m : 0);
};
const pad = (n: number): string => String(n).padStart(2, '0');

/** Minutes of the day the configured shifts cover. Under 1440 means some
 *  minutes are off-shift, and a report must show that bucket too. */
export const shiftCoverageMin = (shifts: ShiftDef[]): number =>
  Math.min(1440, shifts.reduce((n, s) => { const a = toMin(s.start), b = toMin(s.end); return n + (((b - a) % 1440) + 1440) % 1440 || 1440; }, 0));
/** Length of a shift in seconds (an overnight shift wraps). */
export const shiftLengthSec = (s: ShiftDef): number => ((((toMin(s.end) - toMin(s.start)) % 1440) + 1440) % 1440 || 1440) * 60;

/** The production day and shift an instant belongs to. The day rolls at the
 *  first shift's start; an overnight shift (23:00–07:00) belongs to the day it
 *  STARTED in, which is how the plant books it. */
export function bucketOf(t: number, tzMin: number, shifts: ShiftDef[]): { day: string; shift: string } {
  const local = t + tzMin * MIN_MS;
  const midnight = Math.floor(local / DAY_MS) * DAY_MS;
  const minute = Math.floor((local - midnight) / MIN_MS);
  const dayStartMin = shifts.length ? toMin(shifts[0].start) : 0;
  let shift = 'Off-shift';
  let dayAnchor = midnight;
  for (const s of shifts) {
    const a = toMin(s.start), b = toMin(s.end);
    if (a < b ? minute >= a && minute < b : minute >= a || minute < b) {
      shift = s.name;
      // Past midnight inside a wrapping shift → the shift started yesterday.
      if (a >= b && minute < b) dayAnchor = midnight - DAY_MS;
      break;
    }
  }
  if (shift === 'Off-shift' && minute < dayStartMin) dayAnchor = midnight - DAY_MS;
  const d = new Date(dayAnchor);
  return { day: `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`, shift };
}

/** The instant a production day starts (plant clock). */
export function dayStartMs(day: string, tzMin: number, shifts: ShiftDef[]): number {
  const base = Date.UTC(Number(day.slice(0, 4)), Number(day.slice(5, 7)) - 1, Number(day.slice(8, 10)));
  return base + (shifts.length ? toMin(shifts[0].start) : 0) * MIN_MS - tzMin * MIN_MS;
}

/** Every production day a window touches, ascending. */
export function daysOf(from: number, to: number, tzMin: number, shifts: ShiftDef[]): string[] {
  const out: string[] = [];
  const first = bucketOf(from, tzMin, shifts).day;
  const last = bucketOf(Math.max(from, to - 1), tzMin, shifts).day;
  let cur = Date.UTC(Number(first.slice(0, 4)), Number(first.slice(5, 7)) - 1, Number(first.slice(8, 10)));
  const end = Date.UTC(Number(last.slice(0, 4)), Number(last.slice(5, 7)) - 1, Number(last.slice(8, 10)));
  for (; cur <= end; cur += DAY_MS) {
    const d = new Date(cur);
    out.push(`${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`);
  }
  return out;
}

/** Cut [s, e) into pieces that each sit inside one (day, shift) bucket. */
export function splitByBucket(s: number, e: number, tzMin: number, shifts: ShiftDef[]): { day: string; shift: string; ms: number }[] {
  const out: { day: string; shift: string; ms: number }[] = [];
  let cur = s;
  let guard = 0;
  while (cur < e && guard++ < 10_000) {
    const b = bucketOf(cur, tzMin, shifts);
    // Step to the next minute boundary whose bucket differs — boundaries are
    // whole minutes (HH:MM shifts), so walking minute edges is exact.
    const nextMinute = Math.floor(cur / MIN_MS) * MIN_MS + MIN_MS;
    let end = nextMinute;
    for (const step of [6 * HOUR_MS, HOUR_MS, 15 * MIN_MS, MIN_MS]) {
      while (end + step <= e && bucketOf(end + step - 1, tzMin, shifts).shift === b.shift && bucketOf(end + step - 1, tzMin, shifts).day === b.day) end += step;
    }
    end = Math.min(end, e);
    if (bucketOf(end - 1, tzMin, shifts).day !== b.day || bucketOf(end - 1, tzMin, shifts).shift !== b.shift) end = Math.min(nextMinute, e);
    out.push({ day: b.day, shift: b.shift, ms: end - cur });
    cur = end;
  }
  return out;
}

type RSpan = Span & { reason: string };
/** Overlapping spans (two sweep instances once wrote them) trimmed so no
 *  minute is booked twice — each span KEEPS its own reason. */
export function clipWithReason(spans: RSpan[]): RSpan[] {
  const out: RSpan[] = [];
  let cursor = Number.NEGATIVE_INFINITY;
  for (const sp of [...spans].sort((a, b) => a.s - b.s || a.e - b.e)) {
    if (sp.e <= sp.s) continue;
    const s = Math.max(sp.s, cursor);
    if (sp.e <= s) continue;
    out.push({ ...sp, s });
    cursor = sp.e;
  }
  return out;
}

/** [s, e) cut into the part inside [es, ee) and the parts outside it. */
export function splitByEnvelope(s: number, e: number, es: number, ee: number): { inside: [number, number][]; outside: [number, number][] } {
  const inside: [number, number][] = []; const outside: [number, number][] = [];
  const is = Math.max(s, es), ie = Math.min(e, ee);
  if (ie > is) inside.push([is, ie]);
  if (s < Math.min(e, es)) outside.push([s, Math.min(e, es)]);
  if (Math.max(s, ee) < e) outside.push([Math.max(s, ee), e]);
  return { inside, outside };
}

export async function computePlantReport(
  machines: string[], from: Date, to: Date, tzMin: number, shifts: ShiftDef[],
): Promise<PlantReport> {
  const fromMs = from.getTime(); const toMs = to.getTime();
  const days = daysOf(fromMs, toMs, tzMin, shifts);
  const byKey = new Map<string, MachineDay>();
  const blank = (code: string, day: string): MachineDay => ({
    code, day, readings: 0, pieces: {}, total: 0, target: {}, targetTotal: 0, assignedPieces: {}, assignedTotal: 0,
    downtimeMs: { idle: 0, stopped: 0, offline: 0 }, downtimeByReason: {}, reasonType: {}, reasonShift: {}, reasonEvents: {}, reasonsText: '', dia: null, diaNames: [],
  });
  const get = (code: string, day: string): MachineDay => {
    const k = `${code.toUpperCase()}|${day}`;
    let r = byKey.get(k);
    if (!r) { r = blank(code, day); byKey.set(k, r); }
    return r;
  };
  for (const m of machines) for (const d of days) get(m, d);
  const codeOf = new Map<string, string>();   // any spelling → the code as given
  for (const m of machines) for (const c of refCandidates(m)) codeOf.set(c.toUpperCase(), m);
  const ids = [...new Set(machines.flatMap(refCandidates))];

  // Presence — readings per machine per hour, from which come the per-day
  // reading counts and each machine's envelope [first reading, last + 10 min].
  const heard = await Telemetry.aggregate([
    { $match: { machineId: { $in: ids }, timestamp: { $gte: from, $lte: to } } },
    { $group: { _id: { m: '$machineId', h: { $dateTrunc: { date: '$timestamp', unit: 'hour' } } }, n: { $sum: 1 }, first: { $min: '$timestamp' }, last: { $max: '$timestamp' } } },
  ]).option({ maxTimeMS: 30_000 }).exec() as { _id: { m: string; h: Date }; n: number; first: Date; last: Date }[];
  const envelope = new Map<string, { s: number; e: number }>();
  for (const h of heard) {
    const code = codeOf.get(String(h._id.m).toUpperCase());
    if (!code) continue;
    const first = new Date(h.first).getTime(), last = new Date(h.last).getTime();
    // An hour bucket's readings are filed by the hour's own start on the plant clock.
    const b = bucketOf(Math.max(new Date(h._id.h).getTime(), fromMs), tzMin, shifts);
    get(code, b.day).readings += h.n;
    const env = envelope.get(code.toUpperCase()) || { s: first, e: last };
    env.s = Math.min(env.s, first); env.e = Math.max(env.e, last);
    envelope.set(code.toUpperCase(), env);
  }
  for (const env of envelope.values()) env.e = Math.min(toMs, env.e + NETWORK_LOST_MS);

  // Pieces — confirmed steps, net of classified-away pieces, filed by the
  // reading that carried the step.
  const events = await productionEventsBy(machines, from, to);
  for (const [ref, evs] of events) {
    for (const ev of evs) {
      if (ev.t < fromMs || ev.t > toMs) continue;
      const b = bucketOf(ev.t, tzMin, shifts);
      const r = get(ref, b.day);
      r.pieces[b.shift] = (r.pieces[b.shift] || 0) + ev.made;
      r.total += ev.made;
    }
  }

  // Targets — the hourly target rows, filed into shifts, with the pieces
  // made inside those assigned hours beside them. Only where a dia was
  // assigned; a machine without one has no target, not a zero target.
  let targetRows: TargetRow[] = [];
  if (toMs - fromMs <= 92 * DAY_MS) {
    try { targetRows = (await computeTargets(from, to, machines, 'assignment')).rows; } catch { /* targets are optional here */ }
  }
  for (const t of targetRows) {
    const at = new Date(t.bucket).getTime();
    const b = bucketOf(at + MIN_MS, tzMin, shifts);   // an hour bucket sits inside one shift; nudge past the edge
    const r = get(t.machineRef, b.day);
    r.target[b.shift] = (r.target[b.shift] || 0) + t.target;
    r.targetTotal += t.target;
    r.assignedPieces[b.shift] = (r.assignedPieces[b.shift] || 0) + t.actual;
    r.assignedTotal += t.actual;
  }

  // Downtime — spans clipped to the window and to the machine's presence,
  // split at day/shift edges, filed under the operator's reason. Time the
  // machine was not heard is signal lost, whatever the span said.
  const spans = await DowntimeEvent.find({
    machineId: { $in: ids }, startedAt: { $lte: to },
    $or: [{ endedAt: null }, { endedAt: { $gte: from } }],
  }).select({ machineId: 1, type: 1, startedAt: 1, endedAt: 1, reason: 1 }).maxTimeMS(30_000).lean();
  const byMachine = new Map<string, RSpan[]>();
  for (const sp of spans) {
    const code = codeOf.get(String(sp.machineId).toUpperCase());
    if (!code) continue;
    const s = Math.max(new Date(sp.startedAt).getTime(), fromMs);
    const e = Math.min(sp.endedAt ? new Date(sp.endedAt).getTime() : toMs, toMs);
    if (e <= s) continue;
    const arr = byMachine.get(code) || [];
    arr.push({ type: sp.type as Span['type'], s, e, reason: (sp.reason || '').trim() });
    byMachine.set(code, arr);
  }
  const bookOffline = (code: string, s: number, e: number): void => {
    for (const piece of splitByBucket(s, e, tzMin, shifts)) get(code, piece.day).downtimeMs.offline += piece.ms;
  };
  const reasonSets = new Map<string, Set<string>>();
  for (const code of machines) {
    const env = envelope.get(code.toUpperCase());
    const list = byMachine.get(code) || [];
    if (!env) {
      // Never heard in the window: nothing to say about idle or stopped; a
      // span that claims otherwise is a collector that died talking.
      if (list.length) bookOffline(code, fromMs, toMs);
      continue;
    }
    // The dark remainder before the first and after the last reading.
    if (env.s > fromMs) bookOffline(code, fromMs, env.s);
    if (env.e < toMs) bookOffline(code, env.e, toMs);
    for (const sp of clipWithReason(list)) {
      const { inside, outside } = splitByEnvelope(sp.s, sp.e, env.s, env.e);
      for (const [s, e] of outside) if (sp.type !== 'offline') bookOffline(code, s, e);   // the envelope already booked offline spans' dark time
      let firstPiece = true;
      for (const [s, e] of inside) {
        for (const piece of splitByBucket(s, e, tzMin, shifts)) {
          const r = get(code, piece.day);
          r.downtimeMs[sp.type] += piece.ms;
          if (sp.type === 'offline') continue;
          r.downtimeByReason[sp.reason] = (r.downtimeByReason[sp.reason] || 0) + piece.ms;
          const rt = r.reasonType[sp.reason] || (r.reasonType[sp.reason] = { idle: 0, stopped: 0 });
          rt[sp.type] += piece.ms;
          const rs = r.reasonShift[sp.reason] || (r.reasonShift[sp.reason] = {});
          rs[piece.shift] = (rs[piece.shift] || 0) + piece.ms;
          if (firstPiece) { r.reasonEvents[sp.reason] = (r.reasonEvents[sp.reason] || 0) + 1; firstPiece = false; }
          if (sp.reason) {
            const k = `${code.toUpperCase()}|${piece.day}`;
            if (!reasonSets.has(k)) reasonSets.set(k, new Set());
            reasonSets.get(k)!.add(sp.reason);
          }
        }
      }
    }
  }
  for (const [k, set] of reasonSets) { const r = byKey.get(k); if (r) r.reasonsText = [...set].join(', '); }

  // The dia on the machine each day — every assignment that touched the day,
  // the one covering most of it first.
  const asgs = await MachineAssignment.find({
    machineRef: { $in: ids }, effectiveFrom: { $lte: to },
    $or: [{ effectiveTo: null }, { effectiveTo: { $gte: from } }],
  }).select({ machineRef: 1, effectiveFrom: 1, effectiveTo: 1, snapshot: 1 }).lean();
  for (const m of machines) {
    const mine = asgs.filter((a) => codeOf.get(a.machineRef.toUpperCase()) === m);
    if (!mine.length) continue;
    for (const d of days) {
      const ds = dayStartMs(d, tzMin, shifts), de = ds + DAY_MS;
      const cover = mine.map((a) => {
        const s = Math.max(new Date(a.effectiveFrom).getTime(), ds, fromMs);
        const e = Math.min(a.effectiveTo ? new Date(a.effectiveTo).getTime() : de, de, toMs);
        return { ms: e - s, a };
      }).filter((x) => x.ms > 0).sort((a, b) => b.ms - a.ms);
      if (!cover.length) continue;
      const r = get(m, d);
      const sn = cover[0].a.snapshot;
      r.dia = { name: sn.diaName, dims: sn.dims || '', stage: sn.stageName, cycleSec: sn.processingSec };
      r.diaNames = [...new Set(cover.map((x) => x.a.snapshot.diaName))];
    }
  }

  const rows = [...byKey.values()].sort((a, b) => a.code.localeCompare(b.code) || a.day.localeCompare(b.day));
  return { from, to, days, shifts, machines, rows, byMachineDay: byKey };
}

// ── Self-check ────────────────────────────────────────────────────────────────
if (process.argv[1]?.includes('plantReport.service')) {
  const eq = (a: unknown, b: unknown, m: string): void => {
    if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`);
  };
  const IST = 330;
  const S = [{ name: 'Shift A', start: '07:00', end: '15:00' }, { name: 'Shift B', start: '15:00', end: '23:00' }, { name: 'Shift C', start: '23:00', end: '07:00' }];
  const at = (iso: string): number => Date.parse(iso);   // UTC instants
  eq(bucketOf(at('2026-09-18T04:30:00Z'), IST, S), { day: '2026-09-18', shift: 'Shift A' }, '10:00 IST is Shift A of the 18th');
  eq(bucketOf(at('2026-09-18T09:30:00Z'), IST, S), { day: '2026-09-18', shift: 'Shift B' }, '15:00 IST is Shift B');
  eq(bucketOf(at('2026-09-18T17:30:00Z'), IST, S), { day: '2026-09-18', shift: 'Shift C' }, '23:00 IST is Shift C of the 18th');
  eq(bucketOf(at('2026-09-18T20:30:00Z'), IST, S), { day: '2026-09-18', shift: 'Shift C' }, '02:00 IST on the 19th is still the 18th\'s Shift C');
  eq(bucketOf(at('2026-09-19T01:29:00Z'), IST, S), { day: '2026-09-18', shift: 'Shift C' }, '06:59 IST is the 18th');
  eq(bucketOf(at('2026-09-19T01:30:00Z'), IST, S), { day: '2026-09-19', shift: 'Shift A' }, '07:00 IST opens the 19th');
  eq(bucketOf(at('2026-09-18T04:30:00Z'), IST, [S[0]]), { day: '2026-09-18', shift: 'Shift A' }, 'one shift only: inside');
  eq(bucketOf(at('2026-09-18T12:30:00Z'), IST, [S[0]]), { day: '2026-09-18', shift: 'Off-shift' }, 'one shift only: 18:00 is off-shift, same day');
  eq(bucketOf(at('2026-09-19T00:30:00Z'), IST, [S[0]]), { day: '2026-09-18', shift: 'Off-shift' }, '06:00 before the day starts belongs to yesterday');
  eq(dayStartMs('2026-09-19', IST, S), at('2026-09-19T01:30:00Z'), 'the 19th starts at 07:00 IST');
  eq(shiftCoverageMin(S), 1440, 'three 8h shifts cover the day');
  eq(shiftCoverageMin([S[0]]), 480, 'one shift covers 8h');
  eq(shiftLengthSec(S[2]), 8 * 3600, 'the overnight shift is 8h');
  eq(daysOf(at('2026-09-01T01:30:00Z'), at('2026-09-04T01:30:00Z'), IST, S), ['2026-09-01', '2026-09-02', '2026-09-03'], 'three production days, the end edge excluded');
  eq(daysOf(at('2026-09-01T01:30:00Z'), at('2026-09-01T02:30:00Z'), IST, S), ['2026-09-01'], 'one hour = one day');
  // A span from 14:00 to 16:00 IST splits 1h A + 1h B.
  eq(splitByBucket(at('2026-09-18T08:30:00Z'), at('2026-09-18T10:30:00Z'), IST, S), [{ day: '2026-09-18', shift: 'Shift A', ms: 3600_000 }, { day: '2026-09-18', shift: 'Shift B', ms: 3600_000 }], 'a span across a handover splits');
  // 06:00 → 08:00 IST crosses the DAY edge: 1h yesterday's C, 1h today's A.
  eq(splitByBucket(at('2026-09-19T00:30:00Z'), at('2026-09-19T02:30:00Z'), IST, S), [{ day: '2026-09-18', shift: 'Shift C', ms: 3600_000 }, { day: '2026-09-19', shift: 'Shift A', ms: 3600_000 }], 'a span across 07:00 splits across days');
  const long = splitByBucket(at('2026-09-18T01:30:00Z'), at('2026-09-20T01:30:00Z'), IST, S);
  eq(long.length, 6, '48h = 6 shift pieces');
  eq(long.reduce((n, p) => n + p.ms, 0), 2 * DAY_MS, 'nothing lost across 48h');
  eq(splitByBucket(at('2026-09-18T04:30:00Z'), at('2026-09-18T04:30:30Z'), IST, S), [{ day: '2026-09-18', shift: 'Shift A', ms: 30_000 }], 'a 30s span is one piece');
  // Overlapping spans keep their own reason; the later one is trimmed.
  eq(clipWithReason([{ type: 'idle', s: 0, e: 100, reason: 'A' }, { type: 'stopped', s: 50, e: 150, reason: 'B' }, { type: 'idle', s: 120, e: 130, reason: 'C' }]),
    [{ type: 'idle', s: 0, e: 100, reason: 'A' }, { type: 'stopped', s: 100, e: 150, reason: 'B' }], 'clip keeps reasons, swallows the covered span');
  eq(splitByEnvelope(0, 100, 20, 80), { inside: [[20, 80]], outside: [[0, 20], [80, 100]] }, 'a span across both envelope edges');
  eq(splitByEnvelope(30, 40, 20, 80), { inside: [[30, 40]], outside: [] }, 'a span inside the envelope');
  eq(splitByEnvelope(0, 10, 20, 80), { inside: [], outside: [[0, 10]] }, 'a span before the envelope is all outside');
  console.log('plantReport: all checks passed');
}
