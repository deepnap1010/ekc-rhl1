// server/src/controllers/export.controller.ts
// GET /reports/export?from&to&machineId&tz&label — the whole review as ONE
// workbook: what the fleet made, how every machine spent the window, where
// the downtime went and why, every counter advance and every downtime span,
// targets against dias, and reliability — for the same selection the Reports
// page shows. Every figure comes from the engines the screens read
// (computeActivity, computeTargets, the span log, the event log), so a number
// in the file is a number someone can point to on the screen.
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
import { getProdClassConfig } from '../utils/prodclass.js';
import { shiftNameAt } from '../utils/downtimeAsk.js';
import { loadShifts } from './config.controller.js';
import { buildXlsx, type Cell, type Fmt, type Scalar, type Sheet } from '../utils/xlsx.js';

type ScopedUser = { isSuperAdmin?: boolean; assignedMachines?: string[]; name?: string };

const MAX_ROWS = 20_000;          // per detail sheet — Excel copes, the browser download stays sane
const NETWORK_LOST_MS = 10 * 60_000;
const DAY_MS = 86_400_000;

// A machine's FAMILY — the code with its trailing number stripped, aliases
// folded, run-together words split ("CUTTINGMACHINE" → "Cutting Machine").
// The client's lib/machineOrder rule, kept in step by hand so the workbook's
// families are the Dashboard's groups.
const FAMILY_ALIASES: Record<string, string> = { INTERNALSHOTBLASTING: 'ISB', SHOTBLASTING: 'ISB', SPINNING: 'SPG' };
const FAMILY_LABELS: Record<string, string> = { ISB: 'Internal Shot Blasting' };
const WORDS = [
  'INTERNAL', 'QUENCHING', 'BLASTING', 'HYDRAULIC', 'ASSEMBLY', 'GRINDING', 'EXTERNAL',
  'CUTTING', 'MILLING', 'WELDING', 'FURNACE', 'MACHINE', 'BOTTOM', 'PRESS', 'LATHE',
  'DRILL', 'MOULD', 'PUMP', 'SHOT', 'SAW', 'TOP', 'CNC', 'SPG',
];
const titleCase = (w: string): string => (w.length <= 3 ? w : w[0] + w.slice(1).toLowerCase());
const familyOf = (code: string): string => {
  const raw = code.toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/\d+$/, '') || 'OTHER';
  const stem = FAMILY_ALIASES[raw] ?? raw;
  if (FAMILY_LABELS[stem]) return FAMILY_LABELS[stem];
  const words: string[] = [];
  let rest = stem;
  while (rest) {
    const hit = WORDS.find((w) => rest.startsWith(w));
    if (!hit) { words.push(rest); break; }
    words.push(hit); rest = rest.slice(hit.length);
  }
  return words.map(titleCase).join(' ');
};

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

export const exportWorkbook = asyncHandler(async (req, res) => {
  const user = req.user as ScopedUser | undefined;
  const rq = req.query as Record<string, string | undefined>;
  const from = parseD(rq.from);
  const toRaw = parseD(rq.to) || new Date();
  if (!from || from >= toRaw) return fail(res, 400, 'from (and optionally to) must be valid dates, from before to');
  const to = new Date(Math.min(toRaw.getTime(), Date.now()));
  if (to.getTime() - from.getTime() > 400 * DAY_MS) return fail(res, 400, 'The export covers at most 400 days at a time');
  const tzMin = Math.max(-840, Math.min(840, Math.round(Number(rq.tz) || 330)));
  const windowLabel = String(rq.label || '').slice(0, 80) || `${stamp(from, tzMin)} → ${stamp(to, tzMin)}`;

  // Scope: the user's machines, narrowed to one if asked.
  const scope = machineScope(user);
  const one = rq.machineId && rq.machineId !== 'all' ? rq.machineId.trim() : '';
  if (one && scope && !scope.some((s) => s.toUpperCase() === one.toUpperCase())) return fail(res, 403, 'You are not assigned to this machine');
  const only = one ? [one] : null;

  const act = await computeActivity(scope, from, to, only);
  const rows = act.rows;
  const codes = rows.map((r) => r.code);
  const ids = [...new Set(codes.flatMap(refCandidates))];
  const windowMs = act.windowMs;
  const fromMs = from.getTime(); const toMs = act.to.getTime();

  const [labels, docs, current, spans, prodEvents, prodCfg, shifts, targets] = await Promise.all([
    MachineLabel.find({}).select({ machineRef: 1, displayName: 1 }).lean(),
    Machine.find(codes.length ? { $or: [{ code: { $in: ids } }, { machineId: { $in: ids } }] } : { _id: null })
      .select({ code: 1, machineId: 1, type: 1, status: 1, lastReadingAt: 1, lastSeenAt: 1 }).lean(),
    MachineAssignment.find({ effectiveTo: null, machineRef: { $in: ids } }).select({ machineRef: 1, snapshot: 1 }).lean(),
    DowntimeEvent.find({ machineId: { $in: ids }, startedAt: { $lte: act.to }, $or: [{ endedAt: null }, { endedAt: { $gte: from } }] })
      .sort({ startedAt: 1 }).limit(MAX_ROWS).lean(),
    MachineEvent.find({ kind: 'production', machineId: { $in: ids }, startedAt: { $gte: from, $lte: act.to } })
      .sort({ startedAt: 1 }).limit(MAX_ROWS).lean(),
    getProdClassConfig(),
    loadShifts(),
    // Targets exist per assignment; the engine caps a run at 92 days.
    to.getTime() - from.getTime() <= 92 * DAY_MS ? computeTargets(from, act.to, only ?? scope, 'assignment') : Promise.resolve(null),
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

  // ── per-machine rollups from the span and target logs ─────────────────────
  const eventsBy = new Map<string, number>();
  for (const s of spans) eventsBy.set(s.machineId.toUpperCase(), (eventsBy.get(s.machineId.toUpperCase()) || 0) + 1);
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
  const production = sum((r) => r.production ?? 0);
  const counters = rows.filter((r) => r.production != null).length;
  const availability = pct(runningMs, windowMs * rows.length);
  const openNow = spans.filter((s) => !s.endedAt).length;
  const noReasonMs = spans.filter((s) => !s.reason && s.type !== 'offline').reduce((n, s) => n + clipMs(s.startedAt, s.endedAt, fromMs, toMs), 0);
  const reasonedMs = spans.filter((s) => s.type !== 'offline').reduce((n, s) => n + clipMs(s.startedAt, s.endedAt, fromMs, toMs), 0);
  const tgtAll = [...tgtByMachine.values()].reduce((a, s) => ({ target: a.target + s.target, actual: a.actual + s.actual }), { target: 0, actual: 0 });

  const kv = (k: string, v: Scalar, fmt?: Fmt): Record<string, Cell> => ({ k, v: fmt ? { v, fmt } : v });

  const summary: Sheet = { name: 'Summary', blocks: [
    { title: 'EKC SmartFactory — Machine Review', note: 'Every figure in this workbook is the one the Dashboard and Reports screens show for the same selection.',
      columns: [{ header: 'Report', key: 'k', width: 34 }, { header: '', key: 'v', width: 28 }],
      rows: [
        kv('Scope', one ? `${nameOf(one)} (${one})` : 'All machines'),
        kv('Window', windowLabel),
        kv('From', from, 'datetime'), kv('To', act.to, 'datetime'),
        kv('Generated', new Date(), 'datetime'), kv('Generated by', user?.name || ''),
        kv('Plant clock (UTC offset, minutes)', tzMin, 'int'),
      ] },
    { title: 'Fleet totals', columns: [{ header: 'Metric', key: 'k', width: 34 }, { header: 'Value', key: 'v', width: 28 }],
      rows: [
        kv('Machines in scope', rows.length, 'int'), kv('Machines that sent data', rows.filter((r) => r.live).length, 'int'),
        kv('Production (pieces)', production, 'int'), kv('Counters reporting', counters, 'int'),
        kv('Availability (runtime ÷ window)', availability, 'pct'),
        kv('Runtime', runningMs, 'dur'), kv('Idle', idleMs, 'dur'), kv('Stopped', stoppedMs, 'dur'), kv('Downtime (idle + stopped)', idleMs + stoppedMs, 'dur'),
        kv('Signal lost (no data — not downtime)', offlineMs, 'dur'),
        kv('Downtime events in window', spans.length, 'int'), kv('Downtime open now', openNow, 'int'),
        kv('Downtime without a reason', pct(noReasonMs, reasonedMs), 'pct'),
        ...(targets ? [kv('Target (pieces, where a dia was assigned)', Math.round(tgtAll.target), 'int'), kv('Achievement vs target', pct(tgtAll.actual, tgtAll.target), 'pct')]
          : [kv('Targets', 'not computed — window longer than 92 days')]),
      ] },
    { title: 'By machine family', columns: [
        { header: 'Family', key: 'family', width: 24 }, { header: 'Machines', key: 'machines', fmt: 'int' }, { header: 'Production', key: 'production', fmt: 'int' },
        { header: 'Runtime', key: 'runningMs', fmt: 'dur' }, { header: 'Idle', key: 'idleMs', fmt: 'dur' }, { header: 'Stopped', key: 'stoppedMs', fmt: 'dur' },
        { header: 'Signal lost', key: 'offlineMs', fmt: 'dur' }, { header: 'Availability', key: 'availability', fmt: 'pct' },
      ],
      rows: [...rows.reduce((m, r) => {
        const f = familyOf(r.code);
        const g = m.get(f) || { family: f, machines: 0, production: 0, runningMs: 0, idleMs: 0, stoppedMs: 0, offlineMs: 0 };
        g.machines += 1; g.production += r.production ?? 0; g.runningMs += r.runningMs; g.idleMs += r.idleMs; g.stoppedMs += r.stoppedMs; g.offlineMs += r.offlineMs;
        return m.set(f, g);
      }, new Map<string, { family: string; machines: number; production: number; runningMs: number; idleMs: number; stoppedMs: number; offlineMs: number }>()).values()]
        .sort((a, b) => b.production - a.production)
        .map((g) => ({ ...g, availability: pct(g.runningMs, windowMs * g.machines) })) },
  ] };

  const machines: Sheet = { name: 'Machines', blocks: [{ columns: [
    { header: 'Machine', key: 'name', width: 18 }, { header: 'Code', key: 'code', width: 22 }, { header: 'Family', key: 'family', width: 20 }, { header: 'Type', key: 'type', width: 14 },
    { header: 'Status now', key: 'now', width: 12 }, { header: 'State in window', key: 'state', width: 14 }, { header: 'Sent data', key: 'live', width: 10 }, { header: 'Readings', key: 'readings', fmt: 'int' },
    { header: 'First seen', key: 'firstSeen', fmt: 'datetime', width: 18 }, { header: 'Last seen', key: 'lastSeen', fmt: 'datetime', width: 18 },
    { header: 'Production', key: 'production', fmt: 'int' }, { header: 'Counter', key: 'counter', width: 20 },
    { header: 'Runtime', key: 'runningMs', fmt: 'dur' }, { header: 'Idle', key: 'idleMs', fmt: 'dur' }, { header: 'Stopped', key: 'stoppedMs', fmt: 'dur' }, { header: 'Signal lost', key: 'offlineMs', fmt: 'dur' },
    { header: 'Availability', key: 'availability', fmt: 'pct' }, { header: 'Downtime events', key: 'events', fmt: 'int' }, { header: 'MTBF', key: 'mtbf', fmt: 'dur' }, { header: 'MTTR', key: 'mttr', fmt: 'dur' },
    { header: 'Current dia', key: 'dia', width: 18 }, { header: 'Stage', key: 'stage', width: 14 }, { header: 'Cycle (s)', key: 'cycle', fmt: 'int' },
    { header: 'Target', key: 'target', fmt: 'int' }, { header: 'Achievement', key: 'achievement', fmt: 'pct' },
  ], rows: [...rows].sort((a, b) => a.code.localeCompare(b.code)).map((r) => {
    const ev = eventsBy.get(r.code.toUpperCase()) || 0;
    const dia = diaOf.get(r.code.toUpperCase());
    const tg = tgtByMachine.get(r.code.toUpperCase());
    return {
      name: nameOf(r.code), code: r.code, family: familyOf(r.code), type: r.type || '', now: statusNow(r.code), state: r.status === 'offline' ? 'signal lost' : r.status,
      live: r.live, readings: r.readings, firstSeen: r.firstSeen ? new Date(r.firstSeen) : null, lastSeen: r.lastSeen ? new Date(r.lastSeen) : null,
      production: r.production, counter: r.productionFrom ? `from ${nameOf(r.productionFrom)}` : (r.productionKey || ''),
      runningMs: r.runningMs, idleMs: r.idleMs, stoppedMs: r.stoppedMs, offlineMs: r.offlineMs, availability: pct(r.runningMs, windowMs),
      events: ev, mtbf: ev ? r.runningMs / ev : null, mttr: ev ? downOf(r) / ev : null,
      dia: dia?.diaName || '', stage: dia?.stageName || '', cycle: dia?.processingSec ?? null,
      target: tg ? Math.round(tg.target) : null, achievement: tg ? pct(tg.actual, tg.target) : null,
    };
  }) }] };

  const targetSheet: Sheet = { name: 'Targets', blocks: [{
    note: targets ? 'One row per machine and dia that was assigned inside the window. Target = assigned time (minus planned breaks) ÷ cycle time; the adjusted target also excludes measured downtime.' : 'Not computed — the window is longer than 92 days.',
    columns: [
      { header: 'Machine', key: 'name', width: 18 }, { header: 'Dia', key: 'dia', width: 18 }, { header: 'Dims', key: 'dims', width: 16 }, { header: 'Stage', key: 'stage', width: 14 },
      { header: 'Cycle (s)', key: 'cycle', fmt: 'int' }, { header: 'Assigned time', key: 'assigned', fmt: 'dur' }, { header: 'Breaks', key: 'breaks', fmt: 'dur' }, { header: 'Downtime', key: 'down', fmt: 'dur' },
      { header: 'Target', key: 'target', fmt: 'int' }, { header: 'Target excl. downtime', key: 'targetAdj', fmt: 'int' }, { header: 'Actual', key: 'actual', fmt: 'int' }, { header: 'Achievement', key: 'achievement', fmt: 'pct' },
      { header: 'Operators', key: 'operators', width: 24 },
    ],
    rows: [...tgtByMachineDia.values()].sort((a, b) => a.machineRef.localeCompare(b.machineRef) || a.dia.localeCompare(b.dia)).map((t) => ({
      name: nameOf(t.machineRef), dia: t.dia, dims: t.dims, stage: t.stage, cycle: t.processingSec,
      assigned: t.assignedSec * 1000, breaks: t.breakSec * 1000, down: t.downtimeSec * 1000,
      target: Math.round(t.target), targetAdj: Math.round(t.targetAdj), actual: t.actual, achievement: pct(t.actual, t.target), operators: [...t.operators].join(', '),
    })),
  }] };

  const downtimeSheet: Sheet = { name: 'Downtime events', blocks: [{
    note: spans.length >= MAX_ROWS ? `The first ${MAX_ROWS} spans of the window — narrow the window for the rest.` : undefined,
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

  // Reasons: totals, by type and by shift — from the same spans, clipped to the window.
  const shiftNames = [...shifts.map((s) => s.name), 'Off-shift'];
  type ReasonAgg = { reason: string; events: number; ms: number; idle: number; stopped: number; offline: number; byShift: Record<string, number> };
  const byReason = new Map<string, ReasonAgg>();
  for (const s of spans) {
    const key = s.reason || '';
    const a = byReason.get(key) || { reason: key, events: 0, ms: 0, idle: 0, stopped: 0, offline: 0, byShift: {} };
    const ms = clipMs(s.startedAt, s.endedAt, fromMs, toMs);
    a.events += 1; a.ms += ms; a[s.type] += ms;
    const sh = shiftNameAt(shifts, minuteOfDay(new Date(s.startedAt), tzMin));
    a.byShift[sh] = (a.byShift[sh] || 0) + ms;
    byReason.set(key, a);
  }
  const reasonTotal = [...byReason.values()].reduce((n, a) => n + a.ms, 0);
  const reasonSheet: Sheet = { name: 'Downtime by reason', blocks: [{
    note: 'Time is clipped to the window; a span is filed under the shift it started in. Signal lost is shown for completeness and is not downtime.',
    columns: [
      { header: 'Reason', key: 'reason', width: 28 }, { header: 'Events', key: 'events', fmt: 'int' }, { header: 'Downtime', key: 'ms', fmt: 'dur' }, { header: 'Share', key: 'share', fmt: 'pct' },
      { header: 'Idle', key: 'idle', fmt: 'dur' }, { header: 'Stopped', key: 'stopped', fmt: 'dur' }, { header: 'Signal lost', key: 'offline', fmt: 'dur' },
      ...shiftNames.map((n) => ({ header: n, key: `shift:${n}`, fmt: 'dur' as const })),
    ],
    rows: [...byReason.values()].sort((a, b) => b.ms - a.ms).map((a) => ({
      reason: a.reason || 'No reason given', events: a.events, ms: a.ms, share: pct(a.ms, reasonTotal), idle: a.idle, stopped: a.stopped, offline: a.offline,
      ...Object.fromEntries(shiftNames.map((n) => [`shift:${n}`, a.byShift[n] || 0])),
    })),
  }] };

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

  const reliabilitySheet: Sheet = { name: 'Reliability', blocks: [{
    note: 'Availability = runtime ÷ window. MTBF = runtime ÷ downtime events; MTTR = downtime ÷ events. Events are the recorded idle/stopped/signal-lost spans overlapping the window.',
    columns: [
      { header: 'Machine', key: 'name', width: 18 }, { header: 'Availability', key: 'availability', fmt: 'pct' }, { header: 'Runtime', key: 'runningMs', fmt: 'dur' },
      { header: 'Downtime', key: 'downMs', fmt: 'dur' }, { header: 'Signal lost', key: 'offlineMs', fmt: 'dur' }, { header: 'Events', key: 'events', fmt: 'int' }, { header: 'MTBF', key: 'mtbf', fmt: 'dur' }, { header: 'MTTR', key: 'mttr', fmt: 'dur' },
    ],
    rows: [...rows].filter((r) => r.readings > 0 || downOf(r) + r.offlineMs > 0).sort((a, b) => downOf(b) - downOf(a)).map((r) => {
      const ev = eventsBy.get(r.code.toUpperCase()) || 0;
      return { name: nameOf(r.code), availability: pct(r.runningMs, windowMs), runningMs: r.runningMs, downMs: downOf(r), offlineMs: r.offlineMs, events: ev, mtbf: ev ? r.runningMs / ev : null, mttr: ev ? downOf(r) / ev : null };
    }),
  }] };

  const book = buildXlsx([summary, machines, targetSheet, downtimeSheet, reasonSheet, prodSheet, reliabilitySheet], tzMin);
  const file = `EKC_SmartFactory_${one ? one.replace(/[^A-Za-z0-9]+/g, '_') + '_' : ''}${stamp(from, tzMin).slice(0, 10)}_to_${stamp(act.to, tzMin).slice(0, 10)}.xlsx`;
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${file}"`);
  res.setHeader('Cache-Control', 'no-store');
  return res.send(book);
});
