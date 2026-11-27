// client/src/lib/machineStatus.ts
// Status model — the reported server/PLC `status` field, trusted while the
// machine is actually SENDING (a machine streaming "stopped" shows Stopped).
// ONE exception (explicit product decision): whatever the last status claimed
// (running / idle / stopped), if the machine has sent NOTHING for 10+ minutes
// the SIGNAL is lost — we show "Signal Lost" instead of a misleading stale
// status + "2h ago". A feed-reported offline stays Offline. Data freshness
// (the last-seen time / "reporting now" KPI) stays separate via isStale().
import type { Machine } from '../types/api';
import { normalizeStatus } from './format';

/** Live window for the data-freshness ("reporting now") signal — NOT the status pill. */
export const STALE_MS = 120_000;

/** Silence threshold after which any machine is shown as Signal Lost. */
export const NETWORK_LOST_MS = 10 * 60_000;

/** How long after the last BLIND reading we go on saying the link is unstable.
 *
 *  A collector that cannot reach the PLC is not reporting the machine's state,
 *  so the word it sends is not about the machine at all — and on a link that
 *  drops in and out, the one reading in a hundred that gets through flips the
 *  pill to Running while the machine is invisible. SPG07 changed its pill 223
 *  times in ten minutes across a shift that was 98% blind.
 *
 *  Blind readings keep ARRIVING while a link flaps, so the stamp this reads
 *  keeps refreshing and the pill holds one steady word. A link that genuinely
 *  recovers stops refreshing it and the machine's own status is back within
 *  two minutes. */
export const LINK_UNSTABLE_MS = 120_000;

/** True while the collector has recently said it cannot see the machine.
 *
 *  Compared as an ABSOLUTE distance, because the stamp is written by the
 *  factory server's clock and read against the browser's. A browser running a
 *  couple of minutes slow sees every stamp in the future, and a plain
 *  `now - t < LIMIT` would then be true forever — pinning a machine on Signal
 *  Lost for good over a clock that is merely out of step. Either way round,
 *  skew now costs at most the window itself. */
export function linkUnstable(lastSilentAt?: string | null, now = Date.now()): boolean {
  const t = Date.parse(String(lastSilentAt ?? ''));
  return Number.isFinite(t) && Math.abs(now - t) < LINK_UNSTABLE_MS;
}

/** How long a reading that COULD see the machine goes on speaking for it.
 *
 *  Matches LIVE_GRACE_MS in the server's ingest controller, and must: the
 *  server stops letting blind readings overwrite the status on exactly this
 *  boundary, and a pill that drew the line somewhere else would contradict the
 *  very durations printed beneath it.
 *
 *  SPG07's collector sends 11 readings a minute that can see the machine and
 *  523 that cannot. Being outnumbered 48 to 1 is not the same as being gone —
 *  one good look a minute is the resolution this dashboard works at. */
export const LIVE_GRACE_MS = 5 * 60_000;

/** True while a reading that could actually see the machine is recent.
 *  Absolute distance, for the same clock-skew reason as linkUnstable. */
export function liveRecent(lastLiveReadingAt?: string | null, now = Date.now()): boolean {
  const t = Date.parse(String(lastLiveReadingAt ?? ''));
  return Number.isFinite(t) && Math.abs(now - t) < LIVE_GRACE_MS;
}

export function isStale(lastReadingAt?: string | null, now = Date.now()): boolean {
  if (!lastReadingAt) return true;
  const t = new Date(lastReadingAt).getTime();
  return Number.isNaN(t) || now - t > STALE_MS;
}

/** Displayed status: the reported field while data flows — silence 10+ min
 *  becomes 'network' (Signal Lost), whatever the last status claimed. */
export function effectiveStatus(
  m: Pick<Machine, 'status' | 'lastReadingAt' | 'linkLastSilentAt' | 'lastLiveReadingAt'>,
  now = Date.now(),
): string {
  // Before anything else: when the collector cannot see the PLC we have no
  // word about the MACHINE to report, however many readings are arriving.
  // Signal Lost already means exactly that, is already in the filters, tiles
  // and reports, and b2e68f2 already keeps it out of downtime — so this reuses
  // it rather than inventing a bucket the rest of the app would not know.
  //   …unless something that COULD see the machine spoke recently. SPG07's box
  // sends 523 blind readings a minute beside 11 real ones; "blind readings are
  // arriving" and "the machine cannot be seen" are not the same sentence, and
  // only the second one justifies throwing away a status we actually have.
  if (linkUnstable(m.linkLastSilentAt, now) && !liveRecent(m.lastLiveReadingAt, now)) return 'network';
  // Normalised, not merely lower-cased. Collectors disagree on spelling — PC04
  // posts "Stop" — and this one value decides the pill, the KPI tiles, the
  // status filter and the sort order. Lower-casing alone left them disagreeing
  // with each other: a card whose pill read "Stopped" that the Stopped filter
  // hid and the Stopped tile counted as offline.
  const s = normalizeStatus(m.status || 'offline').toLowerCase();
  if (s !== 'offline' && m.lastReadingAt) {
    const t = new Date(m.lastReadingAt).getTime();
    if (!Number.isNaN(t) && now - t > NETWORK_LOST_MS) return 'network';
  }
  return s;
}

/** The tick-aware CURRENT status: the socket's word when one has arrived,
 *  else the machine document's, both through the same 10-minute silence rule.
 *  One helper, used by the Machines page and the Dashboard board alike, so the
 *  two surfaces cannot drift into answering "now" differently. */
export function liveStatus(
  m: Pick<Machine, 'status' | 'lastReadingAt' | 'linkLastSilentAt' | 'lastLiveReadingAt'>,
  tick?: { status?: string | null; lastReadingAt?: string | null } | null,
  now = Date.now(),
): string {
  // The NEWER of the two timestamps, not tick-first: a socket that dropped ten
  // minutes ago holds a frozen tick, and letting it out-vote a fresh list doc
  // would flip a healthy, polling fleet to Signal Lost.
  const tickAt = Date.parse(tick?.lastReadingAt ?? '') || 0;
  const docAt = Date.parse(String(m.lastReadingAt ?? '')) || 0;
  return effectiveStatus(
    {
      status: tick?.status || m.status,
      lastReadingAt: tickAt >= docAt ? tick?.lastReadingAt : m.lastReadingAt,
      // Not taken from the tick: a socket frame is ONE sample, and one sample
      // deciding the pill is the thing this is here to stop.
      linkLastSilentAt: m.linkLastSilentAt,
      lastLiveReadingAt: m.lastLiveReadingAt,
    },
    now,
  );
}

/** What the COLLECTOR says about its own link to the machine, in its own words.
 *  SPG07 and SPG08 run a collector that posts `state_reason` and `master`
 *  beside the status — e.g. `state_reason: 'PLC disconnected (no frames)'`
 *  with `master: 'silent'` — and we threw both away.
 *
 *  That cost us a real, reported contradiction on 2026-11-17: SPG07's PLC had
 *  been unreachable for 1 h 45 m while its `status` field kept flipping, 1,651
 *  times in 75 minutes — one change every 2.7 seconds. Two screens opened
 *  seconds apart each faithfully showed the latest reading and so honestly
 *  disagreed about the same machine, and both of them printed a bare
 *  "Stopped", which reads as THE MACHINE having stopped. It had not. The link
 *  to it was dead, and the collector said so in every one of those readings.
 *
 *  So we quote it. What this does NOT do is rewrite the status word: the
 *  reports still count that time exactly as the collector reported it, and a
 *  caption that quietly disagreed with the reliability sheet would only move
 *  the contradiction somewhere else instead of answering it. */
export interface CollectorNote {
  /** The collector's sentence, quoted — '' when it posts none. */
  text: string;
  /** Its unambiguous "I cannot see the machine" flag. Unknown values are not
   *  it: anything other than a silent master leaves this false. */
  linkDown: boolean;
}

export function collectorNote(params?: Record<string, unknown> | null): CollectorNote {
  const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
  const reason = str(params?.state_reason);
  const linkDown = str(params?.master).toLowerCase() === 'silent';
  return { text: reason || (linkDown ? 'PLC silent — no frames from the machine' : ''), linkDown };
}

export interface StatusTally {
  total: number;
  running: number;
  idle: number;
  stopped: number;
  offline: number;
}

/** Status counts driven by the reported status field. */
export function statusCounts(machines: Machine[]): StatusTally {
  const c: StatusTally = { total: machines.length, running: 0, idle: 0, stopped: 0, offline: 0 };
  for (const m of machines) {
    const s = effectiveStatus(m);
    if (s === 'running') c.running += 1;
    else if (s === 'idle') c.idle += 1;
    else if (s === 'stopped') c.stopped += 1;
    else c.offline += 1;
  }
  return c;
}

// ── Data freshness — the live / last-updated signal (separate from status) ──────
export interface Freshness {
  state: 'live' | 'recent' | 'idle' | 'stale' | 'unknown';
  label: string;
  color: string;
  pulse: boolean;
}

function fmtAge(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

/** Liveness of the last reading: Live (≤2m) → recent → idle → stale, with colour. */
export function freshness(lastReadingAt?: string | null, now = Date.now()): Freshness {
  if (!lastReadingAt) return { state: 'unknown', label: 'No data', color: '#94A3B8', pulse: false };
  const age = now - new Date(lastReadingAt).getTime();
  if (!Number.isFinite(age)) return { state: 'unknown', label: 'No data', color: '#94A3B8', pulse: false };
  if (age <= STALE_MS) return { state: 'live', label: 'Live', color: '#0D9488', pulse: true };
  if (age <= 30 * 60_000) return { state: 'recent', label: fmtAge(age), color: '#0D9488', pulse: false };
  if (age <= 24 * 3_600_000) return { state: 'idle', label: fmtAge(age), color: '#D97706', pulse: false };
  return { state: 'stale', label: fmtAge(age), color: '#94A3B8', pulse: false };
}
