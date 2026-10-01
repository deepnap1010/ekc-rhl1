// server/src/utils/corrections.ts
// How a correction (models/MachineCorrection) reaches the figures.
//
// Pieces: every engine that counts works from a list of confirmed counter
// steps {t, made}. For a corrected period the engine's own steps inside it
// are dropped and the correction's pieces are laid down in their place as
// evenly spaced synthetic steps — so a shift split, an hourly bar, a target
// row or a day total that cuts through the period each gets its proportional
// share without knowing corrections exist. The PLC's data is never touched.
//
// Time: the engines book a window's running / idle / stopped / signal-lost
// from telemetry and spans; a correction with a state replaces that booking
// for the overlap. The activity engine does it by subtracting its own figure
// for the corrected period (computed raw) and adding the period as the stated
// state; the plant report cuts the period out of every interval it books and
// books the period as the stated state. Both are in their own files; here is
// what they share.
import { MachineCorrection, type IMachineCorrection } from '../models/MachineCorrection.js';
import { refCandidates } from './machineRef.js';

export type Correction = IMachineCorrection & { _id: unknown };
export interface Step { t: number; made: number }
export interface Interval { s: number; e: number }

/** Active corrections overlapping [from, to], by upper-cased machine ref. */
export async function loadCorrections(refs: string[], from: Date, to: Date): Promise<Map<string, Correction[]>> {
  const out = new Map<string, Correction[]>();
  if (!refs.length) return out;
  const ids = [...new Set(refs.flatMap(refCandidates))];
  const rows = await MachineCorrection.find({
    machineRef: { $in: ids }, revokedAt: null, from: { $lt: to }, to: { $gt: from },
  }).sort({ from: 1 }).lean() as Correction[];
  for (const c of rows) {
    const k = c.machineRef.toUpperCase();
    out.set(k, [...(out.get(k) || []), c]);
  }
  return out;
}

/** The part of a correction inside [from, to], or null. */
export const overlapOf = (c: Correction, from: number, to: number): Interval | null => {
  const s = Math.max(new Date(c.from).getTime(), from), e = Math.min(new Date(c.to).getTime(), to);
  return e > s ? { s, e } : null;
};

const MAX_SYNTHETIC = 240;
/** The correction's pieces as evenly spaced steps over its whole period —
 *  clipped later by whoever consumes them, so a sub-window gets its share. */
export function syntheticSteps(c: Correction): Step[] {
  const pieces = Math.max(0, Math.round(c.pieces ?? 0));
  if (!pieces) return [];
  const s = new Date(c.from).getTime(), e = new Date(c.to).getTime();
  const n = Math.min(pieces, MAX_SYNTHETIC);
  // Each step carries what the cumulative proportion has reached, so a
  // window cutting the period anywhere gets the share of the pieces its
  // share of the time deserves — never front-loaded.
  return Array.from({ length: n }, (_, i) => ({
    t: Math.round(s + ((i + 0.5) / n) * (e - s)),
    made: Math.floor(((i + 1) * pieces) / n) - Math.floor((i * pieces) / n),
  }));
}

/** The correction's pieces that fall inside [from, to] — the same steps every
 *  engine lays down, so the card's share and the report's split agree. */
export const piecesWithin = (c: Correction, from: number, to: number): number =>
  syntheticSteps(c).filter((st) => st.t >= from && st.t <= to).reduce((n, st) => n + st.made, 0);

/** Whether an instant lies inside a period whose PIECES a correction replaces. */
export const inPiecesPeriod = (corrections: Correction[] | undefined, t: number): boolean =>
  (corrections || []).some((c) => c.pieces != null && t >= new Date(c.from).getTime() && t < new Date(c.to).getTime());

/** Apply the piece corrections for one machine to its step list: the
 *  engine's steps inside a corrected period go, the correction's come in. */
export function correctSteps(steps: Step[], corrections: Correction[] | undefined, from: number, to: number): Step[] {
  const withPieces = (corrections || []).filter((c) => c.pieces != null);
  if (!withPieces.length) return steps;
  const inside = (t: number): boolean => withPieces.some((c) => t >= new Date(c.from).getTime() && t < new Date(c.to).getTime());
  const kept = steps.filter((st) => !inside(st.t));
  const added = withPieces.flatMap(syntheticSteps).filter((st) => st.t >= from && st.t <= to);
  return [...kept, ...added].sort((a, b) => a.t - b.t);
}

/** [s, e) minus every cut — the pieces of an interval a correction does not claim. */
export function cutOut(s: number, e: number, cuts: Interval[]): Interval[] {
  let parts: Interval[] = [{ s, e }];
  for (const c of cuts) {
    parts = parts.flatMap((p) => {
      if (c.e <= p.s || c.s >= p.e) return [p];
      const out: Interval[] = [];
      if (c.s > p.s) out.push({ s: p.s, e: c.s });
      if (c.e < p.e) out.push({ s: c.e, e: p.e });
      return out;
    });
  }
  return parts.filter((p) => p.e > p.s);
}

/** Whether a correction says anything about the period's TIME. */
export const speaksOfTime = (c: Correction): boolean => !!c.time || !!c.state;

export interface TimeSplit { runningMs: number; idleMs: number; stoppedMs: number; darkMs: number }
/** How the part [s, e) of a correction's period divides: the amounts the
 *  correction gives, scaled by the part's share of the period (a window that
 *  cuts the period takes its share of each), and what they leave unaccounted
 *  — signal lost, as the engines book silence. An older row that named one
 *  state for the whole period is that state for the whole part. null when
 *  the correction leaves time as recorded. */
export function timeSplitWithin(c: Correction, s: number, e: number): TimeSplit | null {
  const part = Math.max(0, e - s);
  if (!part) return null;
  if (c.time) {
    const span = Math.max(1, new Date(c.to).getTime() - new Date(c.from).getTime());
    const f = part / span;
    const r = Math.round(Math.max(0, c.time.runningMs) * f), i = Math.round(Math.max(0, c.time.idleMs) * f), st = Math.round(Math.max(0, c.time.stoppedMs) * f);
    const scale = r + i + st > part ? part / (r + i + st) : 1;   // never more than the part holds
    const rr = Math.round(r * scale), ii = Math.round(i * scale), ss = Math.round(st * scale);
    return { runningMs: rr, idleMs: ii, stoppedMs: ss, darkMs: Math.max(0, part - rr - ii - ss) };
  }
  if (c.state) {
    return { runningMs: c.state === 'running' ? part : 0, idleMs: c.state === 'idle' ? part : 0, stoppedMs: c.state === 'stopped' ? part : 0, darkMs: 0 };
  }
  return null;
}

/** The periods of one machine whose TIME a correction describes, inside [from, to]. */
export const timeCuts = (corrections: Correction[] | undefined, from: number, to: number): (Interval & { c: Correction })[] =>
  (corrections || []).filter(speaksOfTime).map((c) => { const o = overlapOf(c, from, to); return o ? { ...o, c } : null; })
    .filter((x): x is Interval & { c: Correction } => x !== null);
