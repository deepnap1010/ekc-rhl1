// server/src/services/downtime.service.ts
// Downtime engine. Periodically derives each machine's effective state
// (running / idle / stopped / offline) and maintains open/closed downtime spans
// in the downtime_reports collection — a span opens when a machine goes down and
// closes (with a duration) when it recovers. Offline = no telemetry within the
// live window. Forward-looking (it can't reconstruct downtime from before it
// started running). Reads machine status; writes only downtime events.
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { Machine } from '../models/Machine.js';
import { DowntimeEvent } from '../models/DowntimeEvent.js';
import { SweepLock } from '../models/SweepLock.js';
import { errMessage } from '../utils/http.js';
import { ensureEventSeed, recordState, recordProduction } from './event.service.js';
import { normalizeStatus } from '../utils/status.js';

const SWEEP_MS = 30_000; // re-evaluate every 30s

// ── Single-writer lease ──────────────────────────────────────────────────────
// Only ONE instance may sweep, however many are connected to the database. Two
// were: a local dev server and the deployed one, both writing spans for the same
// machine 2 seconds apart, which produced overlapping (and backwards) rows and
// double-counted downtime until runtime read 0. The lease expires, so a leader
// that dies is replaced within one lease period instead of stopping the sweep.
const LOCK_ID = 'downtime-sweep';
const LEASE_MS = 75_000;   // > 2 sweep intervals: renewals never race the expiry
const OWNER = `${os.hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;
let wasLeader: boolean | null = null;

async function holdLease(now: Date): Promise<boolean> {
  try {
    // Take it only if free (expired) or already ours. A concurrent instance loses
    // the upsert with a duplicate-key error, which IS the "someone else holds it"
    // answer — the whole election is this one atomic write.
    const doc = await SweepLock.findOneAndUpdate(
      { _id: LOCK_ID, $or: [{ heldUntil: { $lte: now } }, { owner: OWNER }] },
      { $set: { owner: OWNER, heldUntil: new Date(now.getTime() + LEASE_MS) } },
      { upsert: true, new: true },
    ).lean();
    return doc?.owner === OWNER;
  } catch {
    return false;   // duplicate key = another instance is the leader right now
  }
}

type DownState = 'idle' | 'stopped' | 'offline';
type State = DownState | 'up';

interface MachineLike {
  status?: string;
}

/** Downtime state = the reported `status` field, trusted: idle / stopped /
 *  offline|disconnected are downtime; running (or anything else reporting) is up.
 *  Freshness is intentionally NOT used — a machine reporting "running" stays up
 *  even if its last payload is old, matching the status pills shown in the UI. */
// An unrecognised status still falls through to `up`, which is the safe read
// for a machine that IS reporting — but it is also how this went wrong quietly
// for hours. Saying it out loud once per spelling turns the next collector that
// invents a word into a log line instead of a machine that is stopped on the
// floor and running on the board. Once per value, not per sweep: this runs
// every 30 seconds over every machine.
const unknownSeen = new Set<string>();

function machineState(m: MachineLike): State {
  // Normalised, not just lower-cased: "Stop" is not "stopped", and the miss
  // used to land on the `up` default below — a stopped machine with no
  // downtime span, its whole window credited as runtime.
  const s = normalizeStatus(m.status).toLowerCase();
  if (s === 'idle') return 'idle';
  if (s === 'stopped') return 'stopped';
  if (s === 'offline' || s === 'disconnected') return 'offline';
  if (s && s !== 'running' && !unknownSeen.has(s)) {
    unknownSeen.add(s);
    console.warn(`[downtime] unrecognised machine status ${JSON.stringify(m.status)} — treated as running. Add it to utils/status if it means idle/stopped/offline.`);
  }
  return 'up';
}

/** Open/close the machine's downtime span to match its current state. */
async function evaluate(ref: string, state: State, now: Date): Promise<void> {
  const open = await DowntimeEvent.findOne({ machineId: ref, endedAt: null }).sort({ startedAt: -1 });

  if (state === 'up') {
    if (open) {
      open.endedAt = now;
      open.durationMs = now.getTime() - new Date(open.startedAt).getTime();
      await open.save();
    }
    return;
  }

  if (open && open.type === state) {
    // Still down — keep the ongoing duration current so totals reflect live downtime.
    open.durationMs = now.getTime() - new Date(open.startedAt).getTime();
    await open.save();
    return;
  }
  if (open) {                                        // state changed ⇒ close the prior span
    open.endedAt = now;
    open.durationMs = now.getTime() - new Date(open.startedAt).getTime();
    await open.save();
  }
  await DowntimeEvent.create({ machineId: ref, type: state, startedAt: now, endedAt: null, durationMs: 0 });
}

// Reentrancy guard: a sweep that outlasts SWEEP_MS (slow Atlas round trips at
// scale) must not overlap the next tick — overlapping sweeps could double-write
// production events and open duplicate state sessions.
// ponytail: single-process guard; a brief multi-instance overlap during a
// deploy can still double-observe one counter tick — move dedup into the DB
// (unique transition key) if the app is ever scaled to multiple instances.
let sweeping = false;

export async function sweepDowntime(): Promise<void> {
  if (sweeping) return;
  sweeping = true;
  try {
    const now = new Date();
    const leader = await holdLease(now);
    if (leader !== wasLeader) {
      console.log(leader
        ? `[downtime] this instance is the sweep leader (${OWNER})`
        : '[downtime] another instance is sweeping — standing by');
      wasLeader = leader;
    }
    if (!leader) return;

    await ensureEventSeed();
    const machines = await Machine.find({}).lean();
    for (const m of machines) {
      const ref = m.code || m.machineId || String(m._id);
      if (!ref) continue;
      const state = machineState(m);
      await evaluate(ref, state, now);
      // Same sweep, same state source → the operational event log can never
      // disagree with downtime_reports. Event errors are swallowed inside.
      await recordState(ref, state === 'up' ? 'running' : state, now);
      await recordProduction(ref, (m as { currentParameters?: Record<string, unknown> }).currentParameters, now);
    }
  } catch (err) {
    console.error('[downtime] sweep error:', errMessage(err));
  } finally {
    sweeping = false;
  }
}

let timer: NodeJS.Timeout | null = null;

export function startDowntimeMonitor(): void {
  void sweepDowntime(); // run once on boot
  timer = setInterval(() => void sweepDowntime(), SWEEP_MS);
  console.log(`[downtime] monitor active (every ${SWEEP_MS / 1000}s)`);
}

export function stopDowntimeMonitor(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
