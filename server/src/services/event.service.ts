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
import { errMessage } from '../utils/http.js';
import { flattenData } from '../utils/flatten.js';
import { pickProductionKey } from '../utils/production.js';
import { refMatch } from '../utils/machineRef.js';
import { getProdClassConfig } from '../utils/prodclass.js';
import { PROD_STEP_PER_MIN } from './activity.service.js';

// In-memory last-known values per machine ref. lastState is re-seeded from open
// sessions on boot; lastCounter starts empty so the first sweep only records a
// baseline (a restart must not emit a giant false production delta).
const lastState = new Map<string, EventState>();
// `at` = reading time of the last sample holding that value, so a climb can
// be judged against the gap that produced it (same physics rule as stepEvents).
const lastCounter = new Map<string, { key: string; value: number; at: number }>();
let seeded = false;

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

/** Record the machine's production counter. Advance → one event with the delta
 *  (a 3-piece jump within one sweep is one "+3" event). Reset → meta.reset, no
 *  fabricated delta. Unchanged → nothing. */
export async function recordProduction(ref: string, params: Record<string, unknown> | undefined, now: Date, at?: Date | null): Promise<void> {
  try {
    if (!params || !Object.keys(params).length) return;
    const flat = flattenData(params);
    const key = pickProductionKey(flat);
    if (!key) return;
    const value = Number(flat[key]);
    if (!Number.isFinite(value)) return;

    // Stamped with the READING that carried the advance, not the sweep tick
    // up to 30s later: a piece made at 14:59:40 belongs to the shift that
    // made it, and the pieces subtracted from a window must be the pieces
    // counted in it. ±5 min tolerance — a collector clock a few seconds ahead
    // of the server is normal, and its telemetry bins already run on it.
    const stamp = at && Math.abs(now.getTime() - at.getTime()) < 5 * 60_000 ? at : now;
    const prev = lastCounter.get(ref);
    if (!prev || prev.key !== key) {                             // baseline (boot / counter renamed)
      lastCounter.set(ref, { key, value, at: stamp.getTime() });
      return;
    }
    if (value === prev.value) { prev.at = stamp.getTime(); return; }   // unchanged → no event

    if (value > prev.value) {
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
    } else {
      await MachineEvent.create({
        machineId: ref, kind: 'production', paramKey: key,
        prevValue: prev.value, newValue: value, delta: 0,
        startedAt: stamp, endedAt: stamp, durationMs: 0, meta: { reset: true },
      });
    }
    lastCounter.set(ref, { key, value, at: stamp.getTime() });
  } catch (err) {
    console.error('[events] production error:', errMessage(err));
  }
}
