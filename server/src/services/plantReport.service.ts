// server/src/services/plantReport.service.ts
// The plant's own review grid, computed: for every machine and every
// PRODUCTION DAY of a window (the day starts with the first shift — 07:00 on
// the plant clock — not at midnight), the pieces made in each shift, the
// day's total, the target the assigned dia set for each shift, the downtime
// split by the operator's reason, and the dia that was running. This is what
// the plant's "PDWIP" and "PRODUCTION ANALYSIS" sheets hold, from the same
// engines every screen reads: confirmed counter steps (counters.service, net
// of classified-away pieces), the target rows (targets.service), the span log.
//
// Buckets are computed in Node from the plant-clock offset the caller passes
// (IST = +330), never from the server's zone: the factory box and a review
// copy elsewhere must file 14:58 into Shift A of the same day.
import { DowntimeEvent } from '../models/DowntimeEvent.js';
import { MachineAssignment } from '../models/MachineAssignment.js';
import { productionEventsBy } from './counters.service.js';
import { computeTargets, type TargetRow } from './targets.service.js';
import { clipSpans, type Span } from './activity.service.js';

export interface ShiftDef { name: string; start: string; end: string }
export interface MachineDay {
  code: string;
  day: string;                                    // YYYY-MM-DD of the production day (plant clock)
  pieces: Record<string, number>;                 // per shift name
  total: number;
  target: Record<string, number>;                 // per shift — 0 where no dia was assigned
  targetTotal: number;
  downtimeMs: { idle: number; stopped: number; offline: number };
  downtimeByReason: Record<string, number>;       // ms, '' = no reason given (idle + stopped only)
  reasonsText: string;                            // the distinct reasons, joined — the plant's REASONS column
  dia: { name: string; dims: string; stage: string; cycleSec: number } | null;   // the assignment covering most of the day
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
const MIN_MS = 60_000;
const toMin = (hhmm: string): number => {
  const [h, m] = String(hhmm || '').split(':').map(Number);
  return (Number.isFinite(h) ? h : 0) * 60 + (Number.isFinite(m) ? m : 0);
};
const pad = (n: number): string => String(n).padStart(2, '0');

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
    // Jump ahead while the bucket stays the same (binary-ish: try +1h, then +1m).
    for (const step of [6 * 3600_000, 3600_000, 15 * MIN_MS, MIN_MS]) {
      while (end + step <= e && bucketOf(end + step - 1, tzMin, shifts).shift === b.shift && bucketOf(end + step - 1, tzMin, shifts).day === b.day) end += step;
    }
    end = Math.min(end, e);
    if (bucketOf(end - 1, tzMin, shifts).day !== b.day || bucketOf(end - 1, tzMin, shifts).shift !== b.shift) end = Math.min(nextMinute, e);
    out.push({ day: b.day, shift: b.shift, ms: end - cur });
    cur = end;
  }
  return out;
}

export async function computePlantReport(
  machines: string[], from: Date, to: Date, tzMin: number, shifts: ShiftDef[],
): Promise<PlantReport> {
  const fromMs = from.getTime(); const toMs = to.getTime();
  const days = daysOf(fromMs, toMs, tzMin, shifts);
  const byKey = new Map<string, MachineDay>();
  const blank = (code: string, day: string): MachineDay => ({
    code, day, pieces: {}, total: 0, target: {}, targetTotal: 0,
    downtimeMs: { idle: 0, stopped: 0, offline: 0 }, downtimeByReason: {}, reasonsText: '', dia: null,
  });
  const get = (code: string, day: string): MachineDay => {
    const k = `${code.toUpperCase()}|${day}`;
    let r = byKey.get(k);
    if (!r) { r = blank(code, day); byKey.set(k, r); }
    return r;
  };
  for (const m of machines) for (const d of days) get(m, d);

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

  // Targets — the hourly target rows, filed into shifts. Only where a dia was
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
  }

  // Downtime — spans clipped to the window, split at day/shift edges, filed
  // under the operator's reason. Offline is kept apart: it is darkness, not
  // a reason anyone gave.
  const spans = await DowntimeEvent.find({
    machineId: { $in: machines }, startedAt: { $lte: to },
    $or: [{ endedAt: null }, { endedAt: { $gte: from } }],
  }).select({ machineId: 1, type: 1, startedAt: 1, endedAt: 1, reason: 1 }).maxTimeMS(30_000).lean();
  const byMachine = new Map<string, (Span & { reason: string })[]>();
  for (const sp of spans) {
    const s = Math.max(new Date(sp.startedAt).getTime(), fromMs);
    const e = Math.min(sp.endedAt ? new Date(sp.endedAt).getTime() : toMs, toMs);
    if (e <= s) continue;
    const arr = byMachine.get(sp.machineId) || [];
    arr.push({ type: sp.type as Span['type'], s, e, reason: (sp.reason || '').trim() });
    byMachine.set(sp.machineId, arr);
  }
  const reasonSets = new Map<string, Set<string>>();
  for (const [ref, list] of byMachine) {
    // clipSpans drops overlaps but loses the reason; re-attach by start time.
    const clipped = clipSpans(list);
    const reasonAt = new Map(list.map((x) => [`${x.s}`, x.reason]));
    for (const sp of clipped) {
      const reason = reasonAt.get(`${sp.s}`) ?? list.find((x) => x.s <= sp.s && x.e >= sp.e)?.reason ?? '';
      for (const piece of splitByBucket(sp.s, sp.e, tzMin, shifts)) {
        const r = get(ref, piece.day);
        r.downtimeMs[sp.type] += piece.ms;
        if (sp.type !== 'offline') {
          r.downtimeByReason[reason] = (r.downtimeByReason[reason] || 0) + piece.ms;
          if (reason) {
            const k = `${ref.toUpperCase()}|${piece.day}`;
            if (!reasonSets.has(k)) reasonSets.set(k, new Set());
            reasonSets.get(k)!.add(reason);
          }
        }
      }
    }
  }
  for (const [k, set] of reasonSets) { const r = byKey.get(k); if (r) r.reasonsText = [...set].join(', '); }

  // The dia on the machine each day — the assignment covering most of that day.
  const asgs = await MachineAssignment.find({
    machineRef: { $in: machines }, effectiveFrom: { $lte: to },
    $or: [{ effectiveTo: null }, { effectiveTo: { $gte: from } }],
  }).select({ machineRef: 1, effectiveFrom: 1, effectiveTo: 1, snapshot: 1 }).lean();
  const dayStartMin = shifts.length ? toMin(shifts[0].start) : 0;
  const dayWindow = (day: string): [number, number] => {
    const base = Date.UTC(Number(day.slice(0, 4)), Number(day.slice(5, 7)) - 1, Number(day.slice(8, 10)));
    const s = base + dayStartMin * MIN_MS - tzMin * MIN_MS;
    return [s, s + DAY_MS];
  };
  for (const m of machines) {
    const mine = asgs.filter((a) => a.machineRef.toUpperCase() === m.toUpperCase());
    if (!mine.length) continue;
    for (const d of days) {
      const [ds, de] = dayWindow(d);
      let best: { ms: number; a: typeof mine[number] } | null = null;
      for (const a of mine) {
        const s = Math.max(new Date(a.effectiveFrom).getTime(), ds);
        const e = Math.min(a.effectiveTo ? new Date(a.effectiveTo).getTime() : de, de);
        if (e > s && (!best || e - s > best.ms)) best = { ms: e - s, a };
      }
      if (best) {
        const sn = best.a.snapshot;
        get(m, d).dia = { name: sn.diaName, dims: sn.dims || '', stage: sn.stageName, cycleSec: sn.processingSec };
      }
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
  console.log('plantReport: all checks passed');
}
