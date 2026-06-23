// server/src/services/downtime.service.ts
// Downtime engine. Periodically derives each machine's effective state
// (running / idle / stopped / offline) and maintains open/closed downtime spans
// in the downtime_reports collection — a span opens when a machine goes down and
// closes (with a duration) when it recovers. Offline = no telemetry within the
// live window. Forward-looking (it can't reconstruct downtime from before it
// started running). Reads machine status; writes only downtime events.
import { Machine } from '../models/Machine.js';
import { DowntimeEvent } from '../models/DowntimeEvent.js';
import { errMessage } from '../utils/http.js';

const SWEEP_MS = 30_000; // re-evaluate every 30s

type DownState = 'idle' | 'stopped' | 'offline';
type State = DownState | 'up';

interface MachineLike {
  status?: string;
}

/** Downtime state = the reported `status` field, trusted: idle / stopped /
 *  offline|disconnected are downtime; running (or anything else reporting) is up.
 *  Freshness is intentionally NOT used — a machine reporting "running" stays up
 *  even if its last payload is old, matching the status pills shown in the UI. */
function machineState(m: MachineLike): State {
  const s = String(m.status ?? '').toLowerCase();
  if (s === 'idle') return 'idle';
  if (s === 'stopped') return 'stopped';
  if (s === 'offline' || s === 'disconnected') return 'offline';
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

export async function sweepDowntime(): Promise<void> {
  try {
    const machines = await Machine.find({}).lean();
    const now = new Date();
    for (const m of machines) {
      const ref = m.code || m.machineId || String(m._id);
      if (!ref) continue;
      await evaluate(ref, machineState(m), now);
    }
  } catch (err) {
    console.error('[downtime] sweep error:', errMessage(err));
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
