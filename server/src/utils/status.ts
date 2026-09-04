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
  ['offline', 'offline'], ['disconnected', 'offline'],
]);

/** The canonical status, or the trimmed original when it is not one we know. */
export function normalizeStatus(raw: unknown): string {
  const s = String(raw ?? '').trim();
  if (!s) return s;
  // Collectors vary in case and separators: "Stop", "STOPPED", "stand-by".
  return ALIASES.get(s.toLowerCase().replace(/[\s_-]+/g, '')) ?? s;
}
