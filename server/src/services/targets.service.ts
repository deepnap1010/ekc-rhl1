// server/src/services/targets.service.ts
// Target-vs-actual over a window, one row per (hour × machine × assignment).
//
// Target  = assigned seconds ÷ the assignment's FROZEN processing seconds —
//           the same formula every card uses, so a report row and the card it
//           describes can never disagree.
// Actual  = confirmed counter steps (activity engine's stepEvents), attributed
//           to the hour the confirming sample landed in. A machine reassigned
//           at 10:30 gets two rows for that hour, and each row's pieces are the
//           ones counted while THAT assignment was live.
// Downtime is reported per row (overlap of the machine's clipped downtime
// spans) so the client can offer "subtract downtime from targets" as a VIEW —
// both numbers ship, nothing is decided for the reader.
//
// Hours and production days follow the plant's clock: hour buckets on IST hour
// boundaries (UTC buckets would put the plant's 10:00–11:00 into two rows),
// days rolling at 07:00 IST like everything else in this app.
import { Telemetry } from '../models/Telemetry.js';
import { MachineAssignment } from '../models/MachineAssignment.js';
import { DowntimeEvent } from '../models/DowntimeEvent.js';
import { AppConfig, type IBreak } from '../models/AppConfig.js';
import { OperatorSession } from '../models/OperatorSession.js';
import { flattenData } from '../utils/flatten.js';
import { pickProductionKey } from '../utils/production.js';
import { clipSpans, type Span } from './activity.service.js';
import { productionEventsBy } from './counters.service.js';

const IST_MS = 5.5 * 3_600_000;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
export const hourStart = (t: number): number => Math.floor((t + IST_MS) / HOUR) * HOUR - IST_MS;
export const dayStart = (t: number): number => Math.floor((t + IST_MS - 7 * HOUR) / DAY) * DAY + 7 * HOUR - IST_MS;

export interface TargetRow {
  bucket: string;        // ISO start of the hour (or production day)
  machineRef: string;
  dia: string;
  dims: string;
  stage: string;
  processingSec: number;
  assignedSec: number;
  downtimeSec: number;
  breakSec: number;      // planned daily breaks inside this row — excluded from BOTH targets
  actual: number;
  target: number;        // EXACT — (assignedSec − breakSec) ÷ processingSec; display rounds
  targetAdj: number;     // additionally excludes measured downtime outside breaks
  operator: string | null;   // who was on the machine (operator session), if recorded
}

/** Overlap of [s, e) with the plant's DAILY break windows (HH:MM, IST). A break
 *  whose end precedes its start wraps midnight. */
export function breakOverlapMs(s: number, e: number, breaks: Pick<IBreak, 'start' | 'end'>[]): number {
  if (!breaks.length || e <= s) return 0;
  const hm = (v: string): number => {
    const [h, m] = v.split(':').map(Number);
    return (h * 60 + (m || 0)) * 60_000;
  };
  let sum = 0;
  // Check each break on the interval's own IST day and its neighbours (wraps).
  const base0 = Math.floor((s + IST_MS) / DAY) * DAY - IST_MS;
  for (const base of [base0 - DAY, base0, base0 + DAY]) {
    for (const b of breaks) {
      const bs = base + hm(b.start);
      let be = base + hm(b.end);
      if (be <= bs) be += DAY;
      sum += Math.max(0, Math.min(be, e) - Math.max(bs, s));
    }
  }
  return sum;
}

export interface OpInterval { s: number; e: number; name: string }

/** Cut [s, e) at operator-session boundaries into labelled segments. Time
 *  nobody was signed on stays a segment with operator null. */
export function splitByOperator(s: number, e: number, ops: OpInterval[]): { s: number; e: number; operator: string | null }[] {
  const cuts = new Set<number>([s, e]);
  for (const o of ops) {
    if (o.s > s && o.s < e) cuts.add(o.s);
    if (o.e > s && o.e < e) cuts.add(o.e);
  }
  const pts = [...cuts].sort((a, b) => a - b);
  const out: { s: number; e: number; operator: string | null }[] = [];
  for (let i = 0; i < pts.length - 1; i += 1) {
    const mid = (pts[i] + pts[i + 1]) / 2;
    const op = ops.find((o) => mid >= o.s && mid < o.e);
    out.push({ s: pts[i], e: pts[i + 1], operator: op ? op.name : null });
  }
  return out;
}

interface AsgLike {
  machineRef: string;
  effectiveFrom: Date | string;
  effectiveTo: Date | string | null;
  snapshot: { diaName: string; dims: string; stageName: string; processingSec: number };
}

/** Pure row builder — everything time-based happens here, so the self-check
 *  can drive it with synthetic data. */
export function buildTargetRows(
  assignments: AsgLike[],
  eventsBy: Map<string, { t: number; made: number }[]>,   // sorted asc
  spansBy: Map<string, Span[]>,                           // clipped
  fromMs: number, toMs: number,
  breaks: Pick<IBreak, 'start' | 'end'>[] = [],
  opsBy: Map<string, OpInterval[]> = new Map(),
): TargetRow[] {
  const rows: TargetRow[] = [];
  for (const a of assignments) {
    const aStart = Math.max(new Date(a.effectiveFrom).getTime(), fromMs);
    const aEnd = Math.min(a.effectiveTo ? new Date(a.effectiveTo).getTime() : toMs, toMs);
    if (aEnd <= aStart || !a.snapshot?.processingSec) continue;
    const events = eventsBy.get(a.machineRef) || [];
    const spans = spansBy.get(a.machineRef) || [];
    const ops = opsBy.get(a.machineRef) || [];
    for (let h = hourStart(aStart); h < aEnd; h += HOUR) {
      const hs = Math.max(h, aStart), he = Math.min(h + HOUR, aEnd);
      if (he <= hs) continue;
      // A handover mid-hour splits the row exactly like a reassignment does —
      // each person answers for the pieces counted on their watch.
      for (const seg of splitByOperator(hs, he, ops)) {
        const { s, e, operator } = seg;
        const assignedSec = (e - s) / 1000;
        const breakSec = breakOverlapMs(s, e, breaks) / 1000;
        const actual = events.reduce((n, ev) => (ev.t >= s && ev.t < e ? n + ev.made : n), 0);
        // Downtime measured in this segment, and the part of it that fell inside
        // a planned break — that part must not be subtracted twice.
        let dtMs = 0, dtInBreakMs = 0;
        for (const sp of spans) {
          const os = Math.max(sp.s, s), oe = Math.min(sp.e, e);
          if (oe <= os) continue;
          dtMs += oe - os;
          dtInBreakMs += breakOverlapMs(os, oe, breaks);
        }
        const downtimeSec = dtMs / 1000;
        const netSec = Math.max(0, assignedSec - breakSec);
        rows.push({
          bucket: new Date(h).toISOString(),
          machineRef: a.machineRef,
          dia: a.snapshot.diaName, dims: a.snapshot.dims || '', stage: a.snapshot.stageName,
          processingSec: a.snapshot.processingSec,
          assignedSec, downtimeSec, breakSec, actual,
          target: netSec / a.snapshot.processingSec,
          targetAdj: Math.max(0, netSec - (dtMs - dtInBreakMs) / 1000) / a.snapshot.processingSec,
          operator,
        });
      }
    }
  }
  return rows;
}

/** Hour rows → production-day rows (07:00 IST roll), same shape. */
export function rollupToDays(rows: TargetRow[]): TargetRow[] {
  const by = new Map<string, TargetRow>();
  for (const r of rows) {
    const day = new Date(dayStart(new Date(r.bucket).getTime())).toISOString();
    const key = `${day}|${r.machineRef}|${r.dia}|${r.stage}|${r.processingSec}|${r.operator || ''}`;
    const acc = by.get(key);
    if (!acc) by.set(key, { ...r, bucket: day });
    else {
      acc.assignedSec += r.assignedSec;
      acc.downtimeSec += r.downtimeSec;
      acc.breakSec += r.breakSec;
      acc.actual += r.actual;
      acc.target += r.target;
      acc.targetAdj += r.targetAdj;
    }
  }
  return [...by.values()];
}

/** The DB-facing pass: assignments in window → per-machine step events +
 *  clipped downtime spans → rows. `refs` limits to given machines (scope /
 *  filter); null = every machine with an overlapping assignment. */
export async function computeTargets(
  fromD: Date, toD: Date, refs: string[] | null,
  basis: 'assignment' | 'window' = 'assignment',
): Promise<{ rows: TargetRow[]; machines: string[] }> {
  const asgQ: Record<string, unknown> = basis === 'window'
    // 'window' basis: the machine's CURRENT assignment held over the WHOLE
    // window — the live-surface question ("how did it perform against the rate
    // it is held to, across my filter"). 'assignment' basis stays the report's
    // historical truth: targets exist only where an assignment actually did.
    ? { effectiveTo: null }
    : {
      effectiveFrom: { $lte: toD },
      $or: [{ effectiveTo: null }, { effectiveTo: { $gte: fromD } }],
    };
  if (refs) asgQ.machineRef = { $in: refs };
  let assignments = await MachineAssignment.find(asgQ).lean();
  if (basis === 'window') {
    assignments = assignments.map((a) => ({ ...a, effectiveFrom: fromD, effectiveTo: null }));
  }
  const machines = [...new Set(assignments.map((a) => a.machineRef))];
  if (!machines.length) return { rows: [], machines: [] };

  // Confirmed counter steps per machine — the shared engine (counters.service),
  // which the dia trace uses too so the two can never disagree.
  const eventsBy = await productionEventsBy(machines, fromD, toD);

  // Clipped downtime spans per machine, window-clipped.
  const evts = await DowntimeEvent.find({
    machineId: { $in: machines },
    startedAt: { $lte: toD },
    $or: [{ endedAt: null }, { endedAt: { $gte: fromD } }],
  }).select({ machineId: 1, type: 1, startedAt: 1, endedAt: 1 }).maxTimeMS(20_000).lean();
  const rawSpans = new Map<string, Span[]>();
  for (const ev of evts) {
    const s = Math.max(new Date(ev.startedAt).getTime(), fromD.getTime());
    const e = Math.min(ev.endedAt ? new Date(ev.endedAt).getTime() : toD.getTime(), toD.getTime());
    if (e <= s) continue;
    const arr = rawSpans.get(ev.machineId) || [];
    arr.push({ type: ev.type as Span['type'], s, e });
    rawSpans.set(ev.machineId, arr);
  }
  const spansBy = new Map([...rawSpans].map(([ref, sp]) => [ref, clipSpans(sp)]));

  // Planned daily breaks (targets exclude them) and operator sessions (rows are
  // labelled — and split — by who was on the machine).
  const cfg = await AppConfig.findOne({ key: 'global' }).select({ breaks: 1 }).lean();
  const sessions = await OperatorSession.find({
    machineRef: { $in: machines },
    startedAt: { $lte: toD },
    $or: [{ endedAt: null }, { endedAt: { $gte: fromD } }],
  }).lean();
  const opsBy = new Map<string, OpInterval[]>();
  for (const ss of sessions) {
    const arr = opsBy.get(ss.machineRef) || [];
    arr.push({
      s: Math.max(new Date(ss.startedAt).getTime(), fromD.getTime()),
      e: Math.min(ss.endedAt ? new Date(ss.endedAt).getTime() : toD.getTime(), toD.getTime()),
      name: ss.userName,
    });
    opsBy.set(ss.machineRef, arr);
  }

  return {
    rows: buildTargetRows(assignments, eventsBy, spansBy, fromD.getTime(), toD.getTime(), cfg && cfg.breaks ? cfg.breaks : [], opsBy),
    machines,
  };
}

// ── Self-check ────────────────────────────────────────────────────────────────
if (process.argv[1]?.includes('targets.service')) {
  const eq = (a: unknown, b: unknown, m: string): void => {
    if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`);
  };
  const close = (a: number, b: number, m: string): void => {
    if (Math.abs(a - b) > 1e-9) throw new Error(`${m}: ${a} != ${b}`);
  };
  // 10:00 IST on a fixed day = 04:30 UTC.
  const H10 = Date.parse('2026-08-26T04:30:00Z');
  const snap = (sec: number) => ({ diaName: '40L', dims: '316 x 40', stageName: 'Cutting', processingSec: sec });
  // Reassigned mid-hour: 180s/unit until 10:30, then 300s/unit.
  const asgs: AsgLike[] = [
    { machineRef: 'M', effectiveFrom: new Date(H10 - 5 * HOUR), effectiveTo: new Date(H10 + HOUR / 2), snapshot: snap(180) },
    { machineRef: 'M', effectiveFrom: new Date(H10 + HOUR / 2), effectiveTo: null, snapshot: snap(300) },
  ];
  const events = new Map([['M', [
    { t: H10 + 10 * 60_000, made: 2 },   // counted under the first assignment
    { t: H10 + 40 * 60_000, made: 3 },   // counted under the second
  ]]]);
  const spans = new Map([['M', [{ type: 'idle' as const, s: H10 + 50 * 60_000, e: H10 + 55 * 60_000 }]]]);

  const rows = buildTargetRows(asgs, events, spans, H10, H10 + HOUR);
  eq(rows.length, 2, 'mid-hour reassignment → two rows for the hour');
  close(rows[0].target, 10, 'first half: 1800s / 180s = 10');
  eq(rows[0].actual, 2, 'first half gets ITS pieces');
  close(rows[1].target, 6, 'second half: 1800s / 300s = 6');
  eq(rows[1].actual, 3, 'second half gets ITS pieces');
  eq(rows[0].downtimeSec, 0, 'idle span is in the second half only');
  eq(rows[1].downtimeSec, 300, '5 min downtime lands on the second row');
  close(rows[1].targetAdj, 1500 / 300, 'adjusted target excludes the 5 down minutes');
  close(rows[0].targetAdj, rows[0].target, 'no downtime → adjusted equals plain');
  eq(rows[0].bucket === rows[1].bucket, true, 'both rows share the hour bucket');
  eq(new Date(rows[0].bucket).getTime(), H10, 'bucket sits on the IST hour boundary');

  // Days roll at 07:00 IST: 06:59 belongs to yesterday, 07:00 to today.
  const at0700 = Date.parse('2026-08-26T01:30:00Z');
  eq(dayStart(at0700), at0700, '07:00 IST starts its own day');
  eq(dayStart(at0700 - 1) < at0700, true, '06:59:59 IST belongs to the previous day');

  const days = rollupToDays(rows);
  eq(days.length, 2, 'day rollup keeps the two assignments separate');
  close(days[0].target + days[1].target, 16, 'day targets sum the hour targets');

  // Breaks: a 15-minute tea break inside the hour comes off BOTH targets.
  const bAsg: AsgLike[] = [{ machineRef: 'B', effectiveFrom: new Date(H10 - HOUR), effectiveTo: null, snapshot: snap(180) }];
  const withBreak = buildTargetRows(bAsg, new Map(), new Map(), H10, H10 + HOUR, [{ start: '10:15', end: '10:30' }]);
  eq(withBreak.length, 1, 'a break does not split the row');
  eq(withBreak[0].breakSec, 900, '15-minute break measured');
  close(withBreak[0].target, (3600 - 900) / 180, 'plain target excludes the break');
  close(withBreak[0].targetAdj, withBreak[0].target, 'no downtime: adjusted equals plain, break already out');

  // Downtime INSIDE a break is not subtracted twice.
  const dtInBreak = buildTargetRows(
    bAsg, new Map(),
    new Map([['B', [{ type: 'idle' as const, s: H10 + 15 * 60_000, e: H10 + 30 * 60_000 }]]]),
    H10, H10 + HOUR, [{ start: '10:15', end: '10:30' }],
  );
  close(dtInBreak[0].targetAdj, dtInBreak[0].target, 'idle during lunch does not shrink the target again');

  // Operator handover at 10:20 splits the hour; each side keeps its pieces.
  const opRows = buildTargetRows(
    [{ machineRef: 'M', effectiveFrom: new Date(H10 - HOUR), effectiveTo: null, snapshot: snap(180) }],
    events, new Map(), H10, H10 + HOUR, [],
    new Map([['M', [{ s: H10, e: H10 + 20 * 60_000, name: 'Ramesh' }]]]),
  );
  eq(opRows.length, 2, 'handover splits the hour');
  eq(opRows[0].operator, 'Ramesh', 'first segment carries the operator');
  eq(opRows[0].actual, 2, 'their pieces stay theirs');
  eq(opRows[1].operator, null, 'unattended time stays unlabelled');
  eq(opRows[1].actual, 3, 'later pieces fall in the open segment');

  // No assignment overlap → no rows, never a 0-target row.
  eq(buildTargetRows(asgs, events, spans, H10 - 10 * HOUR, H10 - 9 * HOUR).length, 0, 'outside every assignment → no rows');
  console.log('targets.service: all checks passed');
}
