// server/src/services/counterKey.service.ts
// WHICH telemetry key is a machine's production counter — asked of the readings
// themselves, and never of one reading alone. Every counting surface goes
// through here (counters.service for the targets board, the dia trace and the
// reports; activity.service for the cards; the machine page's bars and minute
// log), so they agree on whether a machine can count.
//
// A machine's NEWEST reading does not always carry its counter: a collector
// sends a shorter payload while its PLC is off, and two agents on one PC send
// two register lists turn about. SPG06 made 102 pieces in a shift whose last
// reading had no counter in it, and its card read "— of 129 · 0 pcs" above
// hourly bars that added up. So the name is looked for, in this order:
//   1. the newest reading;
//   2. the few readings before it (two agents turn about);
//   3. what the machine was last SEEN to call it (models/CounterKeyMemo —
//      written by the 30-second sweep, so a PLC that has been off for a day,
//      a weekend or a month is still known);
//   4. for a surface that asks about one window: that window's own last and
//      first reading (windowKeys) — the same two the card reads.
// A name that did not come from the newest reading is `recovered`: it says
// what the counter is called, and only a window's own readings can say the
// machine counted in it. With none of them carrying it, the machine still
// reads "cannot count" — never "made nothing".
import { Telemetry } from '../models/Telemetry.js';
import { Machine } from '../models/Machine.js';
import { CounterKeyMemo } from '../models/CounterKeyMemo.js';
import { flattenData } from '../utils/flatten.js';
import { pickProductionKey } from '../utils/production.js';
import { cached, invalidate } from '../utils/cache.js';
import { derivedCounterFor } from '../config/derivedCounters.js';

/** The counter key a payload names, if it is one the pipelines can read: a
 *  flat key ($getField). Dotted keys are raw PLC addresses, never counters. */
export function counterKeyIn(data: unknown): string | null {
  if (!data || typeof data !== 'object') return null;
  const k = pickProductionKey(flattenData(data as Record<string, unknown>));
  return k && !k.includes('.') ? k : null;
}

const RECENT = 8;
const HOUR_MS = 3_600_000;
const norm = (ref: string): string => ref.toUpperCase();

export interface CounterKey { ref: string; key: string; recovered: boolean }

// ── the memory ───────────────────────────────────────────────────────────────
// This process's copy of machine_counter_keys, loaded once. A failed load is
// forgotten so the next caller tries again.
const known = new Map<string, string>();
let loading: Promise<void> | null = null;
function load(): Promise<void> {
  if (!loading) {
    loading = CounterKeyMemo.find().lean()
      .then((rows) => { for (const r of rows) if (!known.has(r.machineRef)) known.set(r.machineRef, r.key); })
      .catch(() => { loading = null; });
  }
  return loading;
}

/** Remember what a machine's counter is called. Asked on every reading that
 *  names one; writes only when the name is new or has changed. `ifAbsent`
 *  keeps a name already known — for callers reading OLD data (a past window,
 *  the startup look-back), which must not overwrite what the machine calls it
 *  now. Never throws: a memory that cannot be written is tried again by the
 *  next reading. */
export async function rememberCounterKey(ref: string, key: string, ifAbsent = false): Promise<void> {
  const id = norm(ref);
  try {
    await load();
    const had = known.get(id);
    if (had === key || (ifAbsent && had)) return;
    known.set(id, key);
    invalidate(`counterkey:${ref}`);
    await CounterKeyMemo.updateOne({ machineRef: id }, { $set: { key, seenAt: new Date() } }, { upsert: true });
  } catch {
    known.delete(id);
  }
}

async function standingKey(ref: string): Promise<CounterKey | null> {
  const recent = await Telemetry.find({ machineId: ref }).sort({ timestamp: -1 }).limit(RECENT)
    .select({ data: 1 }).lean();
  // A derived-counter machine is looked up like any other: if its PLC has
  // started sending a register, that register is what we count — but only a
  // register in its payload NOW; an old or stray reading must not retire its rule.
  const newest = recent.length ? counterKeyIn(recent[0].data) : null;
  if (newest) {
    void rememberCounterKey(ref, newest);
    return { ref, key: newest, recovered: false };
  }
  if (derivedCounterFor(ref)) return null;
  for (const d of recent.slice(1)) {
    const k = counterKeyIn(d.data);
    if (k) {
      void rememberCounterKey(ref, k);
      return { ref, key: k, recovered: true };
    }
  }
  await load();
  const k = known.get(norm(ref));
  return k ? { ref, key: k, recovered: true } : null;
}

/** Each machine's production-counter key. Looked up in PARALLEL — one round
 *  trip instead of one per machine — and cached per machine: a register map
 *  changes when a PLC is reprogrammed, not between page loads. (Measured on
 *  this fleet: 679ms sequential -> 254ms parallel -> 0 warm.) */
export async function counterKeys(machines: string[]): Promise<CounterKey[]> {
  const found = await Promise.all([...new Set(machines)].map((ref) =>
    cached(`counterkey:${ref}`, 5 * 60_000, () => standingKey(ref))));
  return found.filter((x): x is CounterKey => x !== null);
}

/** The key a WINDOW's own readings name: its last reading, else its first —
 *  the same two the card reads (activity.service). For a machine with no
 *  standing key, so the board, the bars and the reports find a counter
 *  wherever the card finds one, however long the PLC has been off since.
 *  Two index-bounded point reads per machine; always `recovered`. */
export async function windowKeys(machines: string[], from: Date, to?: Date | null): Promise<CounterKey[]> {
  const range: Record<string, Date> = { $gte: from };
  if (to) range.$lte = to;
  const found = await Promise.all([...new Set(machines)].filter((ref) => !derivedCounterFor(ref)).map(async (ref) => {
    for (const dir of [-1, 1] as const) {
      const d = await Telemetry.findOne({ machineId: ref, timestamp: range }).sort({ timestamp: dir })
        .select({ data: 1 }).lean();
      if (!d) return null;               // nothing in the window at all
      const k = counterKeyIn(d.data);
      if (k) {
        void rememberCounterKey(ref, k, true);
        return { ref, key: k, recovered: true };
      }
    }
    return null;
  }));
  return found.filter((x): x is CounterKey => x !== null);
}

/** Startup: teach the memory every machine it does not know yet, from the
 *  week of readings already stored — hour by hour back from the machine's
 *  newest, a few readings at each step, so no time of day and no alternating
 *  agent can hide the name. After this the sweep keeps it current. Runs once
 *  per start, in the background; returns how many names it learned. */
export async function seedCounterKeys(): Promise<number> {
  await load();
  const machines = await Machine.find().select({ code: 1, machineId: 1 }).lean();
  const refs = [...new Set(machines.flatMap((m) => [m.code, m.machineId].filter(Boolean) as string[]))];
  let learned = 0;
  for (const ref of refs) {
    if (known.has(norm(ref)) || derivedCounterFor(ref)) continue;
    const newest = await Telemetry.findOne({ machineId: ref }).sort({ timestamp: -1 }).select({ timestamp: 1 }).lean();
    if (!newest?.timestamp) continue;
    const t0 = new Date(newest.timestamp).getTime();
    for (let h = 0; h <= 168; h += 1) {
      const batch = await Telemetry.find({ machineId: ref, timestamp: { $lte: new Date(t0 - h * HOUR_MS) } })
        .sort({ timestamp: -1 }).limit(RECENT).select({ data: 1 }).lean();
      if (!batch.length) break;          // nothing that old
      const k = batch.map((d) => counterKeyIn(d.data)).find((x) => !!x);
      if (k) {
        await rememberCounterKey(ref, k, true);
        learned += 1;
        break;
      }
    }
  }
  return learned;
}
