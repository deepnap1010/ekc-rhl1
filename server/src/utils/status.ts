// server/src/utils/status.ts
// ONE vocabulary for what a machine's status string means.
//
// The status is whatever the PLC agent posts, stored verbatim by ingest, and
// then compared as an EXACT string in three unrelated places. That held only
// while every collector happened to spell it the same way. CUTTINGMACHINE04
// posts "Stop"; downtime.service tested `s === 'stopped'`, missed, and fell
// through to its `return 'up'` default — so no downtime span ever opened and
// the activity engine credited the whole window as runtime. The card read
// "Stop · uptime 3h53m · stopped 0m" while the machine sat stopped on the floor.
//
// Unknown values pass through UNCHANGED. A status nobody anticipated should
// look unfamiliar in the UI, not be silently forced into a bucket it may not
// belong to — guessing wrong here is worse than showing the raw word.
//
// A Map, not an object literal: the key comes from the factory's collector, and
// on an object `ALIASES['constructor']` resolves up the prototype chain to a
// FUNCTION — which `?? s` does not catch, so normalizeStatus would return
// something that is not a string at all.
const ALIASES = new Map<string, string>([
  ['run', 'running'], ['running', 'running'],
  ['stop', 'stopped'], ['stopped', 'stopped'], ['halt', 'stopped'], ['halted', 'stopped'],
  ['idle', 'idle'], ['standby', 'idle'],
  // NECKDRILLING1's run-status cycles idle / pause / run. Left unmapped, the
  // sweep's fallthrough treats an unknown word as RUNNING and credits paused
  // time as runtime — the CUTTINGMACHINE04 failure this table exists to stop.
  // A paused machine is loaded and powered but making nothing: that is idle.
  ['pause', 'idle'], ['paused', 'idle'],
  ['offline', 'offline'], ['disconnected', 'offline'],
]);

export interface StateSession { state?: string | null; startedAt: Date | string; endedAt?: Date | string | null }

/** The state the sweep RECORDED for a machine at `t`, or null when it recorded
 *  none — which means nothing was watching then, not that the machine was up.
 *
 *  Read, never inferred. The obvious-looking alternative is to use
 *  downtime_reports and treat "no span covers this minute" as running, since the
 *  sweep closes any open span the moment a machine reads as up. That inference
 *  is exactly right INSIDE the watched period and unfixably wrong at its edges,
 *  because a down-span only exists once a machine has been DOWN: a machine's
 *  first span is its first fault, not the day it was first watched, and on this
 *  plant's data those differ by four days — during which downtime_reports is
 *  silent while the sweep was running and writing. It has no right edge either,
 *  so a deploy or a lease handover, when nothing was sweeping, would read as
 *  solid running.
 *
 *  machine_events answers directly. The same sweep writes it in the same loop
 *  off the same machineState (services/downtime.service), it records 'running'
 *  as a state of its own, and its sessions tile the whole watched period — so an
 *  uncovered minute really does mean unwatched, and nothing has to be guessed. */
export function sessionStateAt(sessions: StateSession[], t: number): string | null {
  for (const s of sessions) {
    const st = new Date(s.startedAt).getTime();
    const en = s.endedAt ? new Date(s.endedAt).getTime() : Number.POSITIVE_INFINITY;
    if (t >= st && t <= en) return s.state || null;
  }
  return null;
}

/** True when the collector is telling us it cannot reach the machine at all.
 *  SPG07 and SPG08 post `master: 'silent'` with a `state_reason` naming the
 *  fault ('PLC disconnected (no frames)'). Only an explicit 'silent' counts:
 *  any other value, or none at all, leaves the reading's own status alone, so
 *  a collector we have never met cannot be reclassified by accident. */
export function linkIsDown(data: unknown): boolean {
  if (!data || typeof data !== 'object') return false;
  const m = (data as Record<string, unknown>).master;
  return typeof m === 'string' && m.trim().toLowerCase() === 'silent';
}

/** The canonical status, or the trimmed original when it is not one we know. */
export function normalizeStatus(raw: unknown): string {
  const s = String(raw ?? '').trim();
  if (!s) return s;
  // Collectors vary in case and separators: "Stop", "STOPPED", "stand-by".
  return ALIASES.get(s.toLowerCase().replace(/[\s_-]+/g, '')) ?? s;
}
