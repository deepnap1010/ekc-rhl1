// server/src/services/event.service.ts
// Operational-event engine. Turns the machine-state timeline and production
// counters into persisted MachineEvent rows. Driven exclusively by the downtime
// sweep (one transition detector for downtime_reports AND machine_events, so
// History and Downtime always agree). Deduplication is inherent: an event is
// written only on an actual transition / counter advance — repeated identical
// sweeps write nothing.
//
// Forward-looking: on boot the current state/counter is taken as the baseline
// (no event), so restarts never fabricate transitions or production deltas.
import { MachineEvent, type EventState } from '../models/MachineEvent.js';
import { OperatorSession } from '../models/OperatorSession.js';
import { Telemetry } from '../models/Telemetry.js';
import { errMessage } from '../utils/http.js';
import { flattenData } from '../utils/flatten.js';
import { isNumericValue } from '../utils/normalize.js';
import { pickProductionKey } from '../utils/production.js';
import { refMatch, refCandidates } from '../utils/machineRef.js';
import { getProdClassConfig } from '../utils/prodclass.js';
import { PROD_STEP_PER_MIN } from './activity.service.js';
import { rememberCounterKey } from './counterKey.service.js';
import { derivedCounterFor, REFRACTORY_MS } from '../config/derivedCounters.js';
import { derivedEvents } from './derivedCounter.service.js';

// In-memory last-known values per machine ref. lastState is re-seeded from open
// sessions on boot; lastCounter starts empty so the first sweep only records a
// baseline (a restart must not emit a giant false production delta).
const lastState = new Map<string, EventState>();
// `at` = reading time of the last sample holding that value, so a climb can
// be judged against the gap that produced it (same physics rule as stepEvents).
const lastCounter = new Map<string, { key: string; value: number; at: number }>();
let seeded = false;

/** Forget every machine's last counter — what a restart does. For the
 *  self-check. */
export function forgetCounters(): void { lastCounter.clear(); }

/** Load open state sessions once so a restart continues sessions instead of duplicating them. */
export async function ensureEventSeed(): Promise<void> {
  if (seeded) return;
  seeded = true;
  try {
    const open = await MachineEvent.find({ kind: 'state', endedAt: null })
      .select({ machineId: 1, state: 1 }).lean();
    for (const s of open) if (s.state) lastState.set(s.machineId, s.state);
  } catch (err) {
    console.error('[events] seed error:', errMessage(err));
  }
}

/** Record a state observation. Writes only on transition: closes the open session
 *  (duration from timestamps) and opens the new one. */
export async function recordState(ref: string, state: EventState, now: Date): Promise<void> {
  try {
    if (lastState.get(ref) === state) return;                    // no transition → no event

    const open = await MachineEvent.findOne({ machineId: ref, kind: 'state', endedAt: null })
      .sort({ startedAt: -1 });
    if (open && open.state === state) {                          // seeded mid-flight; adopt it
      lastState.set(ref, state);
      return;
    }
    if (open) {
      open.endedAt = now;
      open.durationMs = now.getTime() - new Date(open.startedAt).getTime();
      await open.save();
    }
    await MachineEvent.create({
      machineId: ref, kind: 'state', state,
      prevState: lastState.get(ref) ?? open?.state ?? null,
      startedAt: now, endedAt: null, durationMs: 0,
    });
    lastState.set(ref, state);
  } catch (err) {
    console.error('[events] state error:', errMessage(err));
  }
}

// ── a counter that seems to go DOWN ──────────────────────────────────────────
// The snapshot is the reading that ARRIVED last, and on CUTTINGMACHINE07 that
// is often not the newest: its collector replays old readings stamped with the
// current time, between the live ones. On 15 Oct every production event it had
// read "668 → 3,393": the snapshot fell to an old 668 (taken for a reset), came
// back (+2,725 — no machine makes that in 30 s, so refused, never counted), and
// the real +1 was lost inside the flip, while its operator was asked about the
// fake jumps. The card and the History tab never saw any of it: they take each
// minute's highest counter.
//
// So a lower snapshot is never believed on its own word. The readings RECEIVED
// in the last two minutes are asked: while any of them still holds the counter
// where it stood, the low one was a replay — and if they hold it higher, that
// is the real advance, at the reading that first showed it. Only when every one
// of them is lower was the counter really reset, and it restarts from where
// they start, so a piece made while this waited is still a piece. A healthy
// machine's counter never goes down between pieces: for it none of this runs.
const RECENT_MS = 2 * 60_000;
// ±5 min — a collector clock a few seconds ahead of the server is normal, and
// its telemetry bins already run on it.
const CLOCK_SKEW_MS = 5 * 60_000;

type Point = { t: number; v: number };

/** The counter in the readings received over the RECENT_MS up to `now`, oldest
 *  first. Fails soft to [] — the snapshot's word, as before. */
async function recentReadings(ref: string, key: string, now: Date): Promise<Point[]> {
  try {
    const nowMs = now.getTime();
    // Bounded by timestamp too, so {machineId, timestamp} serves it; the skew
    // allowance keeps a collector whose clock runs a little behind.
    const rows = await Telemetry.find({
      machineId: { $in: refCandidates(ref) },
      timestamp: { $gte: new Date(nowMs - RECENT_MS - CLOCK_SKEW_MS) },
      receivedAt: { $gte: new Date(nowMs - RECENT_MS), $lte: now },
    }).select({ timestamp: 1, [`data.${key}`]: 1 }).limit(20_000).lean();
    const out: Point[] = [];
    for (const r of rows) {
      const v = flattenData((r as { data?: unknown }).data)[key];
      if (r.timestamp && isNumericValue(v)) out.push({ t: new Date(r.timestamp).getTime(), v: Number(v) });
    }
    return out.sort((a, b) => a.t - b.t);
  } catch (err) {
    console.error('[events] recent readings error:', errMessage(err));
    return [];
  }
}

/** The highest value, at the LAST reading that held it. */
function highest(pts: Point[]): Point | null {
  let top: Point | null = null;
  for (const p of pts) if (!top || p.v > top.v || (p.v === top.v && p.t > top.t)) top = p;
  return top;
}

/** A reading's own time, within the tolerance `stamp` trusts; else the sweep's. */
const near = (t: number, now: Date): Date => (Math.abs(now.getTime() - t) < CLOCK_SKEW_MS ? new Date(t) : now);

/** One production event: the counter from `prev` up to `value`, at `stamp`. */
async function writeAdvance(ref: string, key: string, prev: { value: number; at: number }, value: number, stamp: Date, now: Date): Promise<void> {
  // Born classified with the admin-configured default: the popup can only
  // ever REFINE the record, never gate it — if no operator answers, or no
  // popup is enabled at all, the event already has its honest answer.
  // Both lookups fail soft: classification must never be the reason a
  // production event goes unrecorded.
  const cfg = await getProdClassConfig();
  const op = await OperatorSession.findOne({
    machineRef: refMatch(ref), startedAt: { $lte: now },
    $or: [{ endedAt: null }, { endedAt: { $gte: now } }],
  }).sort({ startedAt: -1 }).select({ userName: 1 }).lean().catch(() => null);
  // The same physics rule stepEvents applies: a climb the reading gap
  // cannot hold (garbage sample, commissioning preload) is one the counts
  // never credited — recorded raw, but marked so no figure ever subtracts it.
  const gapMin = Math.max((stamp.getTime() - prev.at) / 60_000, 1);
  const implausible = value - prev.value > gapMin * PROD_STEP_PER_MIN;
  await MachineEvent.create({
    machineId: ref, kind: 'production', paramKey: key,
    prevValue: prev.value, newValue: value, delta: value - prev.value,
    startedAt: stamp, endedAt: stamp, durationMs: 0,
    classification: cfg.defaultValue, classSource: 'default',
    operatorName: op?.userName || null,
    ...(implausible ? { meta: { implausible: true } } : {}),
  });
}

/** Record the machine's production counter. Advance → one event with the delta
 *  (a 3-piece jump within one sweep is one "+3" event). Reset → meta.reset, no
 *  fabricated delta — once the last two minutes of readings agree (above).
 *  Unchanged → nothing. */
export async function recordProduction(ref: string, params: Record<string, unknown> | undefined, now: Date, at?: Date | null): Promise<void> {
  try {
    if (!params || !Object.keys(params).length) return;
    const flat = flattenData(params);
    const key = pickProductionKey(flat);
    if (!key) return;
    const value = Number(flat[key]);
    if (!Number.isFinite(value)) return;
    // This reading names the machine's counter: remember the name, so a later
    // reading without it (PLC off, a second agent) cannot make the machine
    // "unable to count" (counterKey.service). A no-op unless it is new.
    if (!key.includes('.')) void rememberCounterKey(ref, key);

    // Stamped with the READING that carried the advance, not the sweep tick
    // up to 30s later: a piece made at 14:59:40 belongs to the shift that
    // made it, and the pieces subtracted from a window must be the pieces
    // counted in it.
    const stamp = at && Math.abs(now.getTime() - at.getTime()) < CLOCK_SKEW_MS ? at : now;
    const prev = lastCounter.get(ref);
    if (!prev || prev.key !== key) {                             // baseline (boot / counter renamed)
      // From the highest of the last two minutes, not just the last reading to
      // arrive: a restart in the middle of a replay must not start
      // CUTTINGMACHINE07 from its old 668.
      const top = highest(await recentReadings(ref, key, now));
      lastCounter.set(ref, top && top.v > value ? { key, value: top.v, at: top.t } : { key, value, at: stamp.getTime() });
      return;
    }
    if (value === prev.value) { prev.at = stamp.getTime(); return; }   // unchanged → no event

    if (value > prev.value) {
      await writeAdvance(ref, key, prev, value, stamp, now);
      lastCounter.set(ref, { key, value, at: stamp.getTime() });
      return;
    }

    // Lower than it stood: a replayed reading, or a real reset (see above).
    const pts = await recentReadings(ref, key, now);
    const top = highest(pts);
    if (top && top.v >= prev.value) {
      if (top.v > prev.value) {
        // The real advance, behind a replayed reading: at the one that first showed it.
        const first = pts.find((p) => p.v > prev.value) as Point;
        await writeAdvance(ref, key, prev, top.v, near(first.t, now), now);
        lastCounter.set(ref, { key, value: top.v, at: top.t });
      } else {
        prev.at = Math.max(prev.at, top.t);
      }
      return;
    }
    // Every reading of the last two minutes is lower: the counter was reset.
    // A counter that really restarted only climbs from there, so it restarts
    // from the first of them and a piece made while this waited is still a
    // piece. Readings that bounce are no restart but leftovers — then the
    // highest of them is the floor, and nothing in them is taken for a piece.
    const clean = pts.every((p, i) => i === 0 || p.v >= pts[i - 1].v);
    const base = !pts.length ? value : clean ? pts[0].v : (top as Point).v;
    const resetAt = pts.length ? near(pts[0].t, now) : stamp;
    await MachineEvent.create({
      machineId: ref, kind: 'production', paramKey: key,
      prevValue: prev.value, newValue: base, delta: 0,
      startedAt: resetAt, endedAt: resetAt, durationMs: 0, meta: { reset: true },
    });
    const restart = { key, value: base, at: resetAt.getTime() };
    lastCounter.set(ref, restart);
    const after = clean ? pts.filter((p) => p.v > base) : [];
    const hi = highest(after);
    if (hi) {
      await writeAdvance(ref, key, restart, hi.v, near(after[0].t, now), now);
      lastCounter.set(ref, { key, value: hi.v, at: hi.t });
    }
  } catch (err) {
    console.error('[events] production error:', errMessage(err));
  }
}

// ── derived counters ─────────────────────────────────────────────────────────
// A machine with no counter register (config/derivedCounters) has no register
// for recordProduction to watch, so it never had a production event — and the
// operator's popup, the History log's "+1" rows and every classification hang
// off those events. BOTTOMMILLING03 had none, ever, while its card counted.
//
// This asks the SAME counter the card asks (services/derivedCounter) about the
// last few minutes, and writes an event for each piece that has none yet.
// Asking the counter again, rather than keeping a tally here, is what keeps
// the two in step: the piece the card counts is the piece the popup asks
// about, a re-cut it folds is one it folds, and a restart resumes exactly
// where the event log stops. A piece within the counter's own refractory of
// an event already on file IS that event — the same piece found again by a
// later sweep, or seen through the other signal a second or two apart.
const DERIVED_LOOKBACK_MS = 10 * 60_000;     // late readings, a sweep or two missed
const DERIVED_CATCHUP_MS = 2 * 3_600_000;    // after a (re)start: the popup's own window
// Per machine: pieces at or before this are never announced. A machine first
// swept with no production event ever starts at that sweep — switching this
// on must not hand the operator a popup for every piece already made today.
const derivedSince = new Map<string, number>();

/** Forget where each derived machine stands — what a restart does. For the
 *  self-check. */
export function forgetDerivedCursors(): void { derivedSince.clear(); }

export async function recordDerivedProduction(ref: string, params: Record<string, unknown> | undefined, now: Date): Promise<void> {
  try {
    const dc = derivedCounterFor(ref);
    if (!dc) return;
    // A register in the payload wins, as everywhere: recordProduction counts it.
    if (params && Object.keys(params).length && pickProductionKey(flattenData(params))) return;
    const nowMs = now.getTime();
    // $in of the exact spellings, never refMatch's regex: a case-insensitive
    // regex cannot use {machineId, startedAt}, and this runs every 30 s.
    const ids = refCandidates(ref);
    let since = derivedSince.get(ref);
    let lookback = DERIVED_LOOKBACK_MS;
    if (since === undefined) {
      since = (await MachineEvent.exists({ machineId: { $in: ids }, kind: 'production' })) ? 0 : nowMs;
      derivedSince.set(ref, since);
      lookback = DERIVED_CATCHUP_MS;
    }
    const from = Math.max(nowMs - lookback, since);
    if (from >= nowMs) return;
    const pieces = (await derivedEvents([ref], dc, new Date(from), now)).filter((p) => p.t > (since as number));
    if (!pieces.length) return;
    const have = (await MachineEvent.find({
      machineId: { $in: ids }, kind: 'production',
      startedAt: { $gte: new Date(from - REFRACTORY_MS), $lte: new Date(nowMs + REFRACTORY_MS) },
    }).select({ startedAt: 1 }).lean()).map((e) => +new Date(e.startedAt));
    const cfg = await getProdClassConfig();
    for (const p of pieces) {
      if (have.some((h) => Math.abs(h - p.t) < REFRACTORY_MS)) continue;
      const at = new Date(p.t);
      const op = await OperatorSession.findOne({
        machineRef: refMatch(ref), startedAt: { $lte: at },
        $or: [{ endedAt: null }, { endedAt: { $gte: at } }],
      }).sort({ startedAt: -1 }).select({ userName: 1 }).lean().catch(() => null);
      // No counter, so no prevValue/newValue: the event says only what the
      // counter says — one piece, from this signal (meta.derived).
      await MachineEvent.create({
        machineId: ref, kind: 'production', paramKey: dc.key,
        delta: p.made, startedAt: at, endedAt: at, durationMs: 0,
        classification: cfg.defaultValue, classSource: 'default',
        operatorName: op?.userName || null,
        meta: { derived: true },
      });
      have.push(p.t);
    }
  } catch (err) {
    console.error('[events] derived production error:', errMessage(err));
  }
}
