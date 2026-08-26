// client/src/lib/targets.ts
// Target arithmetic — ONE formula for every window:
//
//     target = assigned seconds in the window ÷ processing seconds per unit
//
// "Assigned seconds" is the overlap between the window and the assignment's
// [effectiveFrom, effectiveTo) range, which natively handles a machine assigned
// mid-window, reassigned mid-hour, or unassigned entirely (overlap 0 → no
// target, never a fake 0%). Math stays EXACT — 60/7 is 8.571…, not 8 or 9 —
// and only the display rounds, because either rounding compounds into a lie by
// the end of a day.

export interface AssignmentRange {
  effectiveFrom: string | Date;
  effectiveTo?: string | Date | null;   // null/undefined = still active
  snapshot: { processingSec: number };
}

/** Milliseconds of [winFrom, winTo] covered by the assignment. */
export function assignedMs(a: AssignmentRange, winFrom: number, winTo: number): number {
  const s = Math.max(new Date(a.effectiveFrom).getTime(), winFrom);
  const e = Math.min(a.effectiveTo ? new Date(a.effectiveTo).getTime() : winTo, winTo);
  return Math.max(0, e - s);
}

const IST_MS = 5.5 * 3_600_000;
const DAY_MS = 24 * 3_600_000;

/** Overlap of [s, e) with the plant's DAILY break windows (HH:MM, plant clock).
 *  Mirrors the server (services/targets.service#breakOverlapMs) so a card and
 *  the report can never disagree about what lunch costs a target. */
export function breakOverlapMs(s: number, e: number, breaks: { start: string; end: string }[]): number {
  if (!breaks?.length || e <= s) return 0;
  const hm = (v: string): number => {
    const [h, m] = v.split(':').map(Number);
    return (h * 60 + (m || 0)) * 60_000;
  };
  let sum = 0;
  const base0 = Math.floor((s + IST_MS) / DAY_MS) * DAY_MS - IST_MS;
  for (const base of [base0 - DAY_MS, base0, base0 + DAY_MS]) {
    for (const b of breaks) {
      const bs = base + hm(b.start);
      let be = base + hm(b.end);
      if (be <= bs) be += DAY_MS;
      sum += Math.max(0, Math.min(be, e) - Math.max(bs, s));
    }
  }
  return sum;
}

/** Assigned time NET of planned breaks — what targets divide by. */
export function netAssignedMs(a: AssignmentRange, winFrom: number, winTo: number, breaks: { start: string; end: string }[] = []): number {
  const s = Math.max(new Date(a.effectiveFrom).getTime(), winFrom);
  const e = Math.min(a.effectiveTo ? new Date(a.effectiveTo).getTime() : winTo, winTo);
  if (e <= s) return 0;
  return Math.max(0, (e - s) - breakOverlapMs(s, e, breaks));
}

/** Exact target units for a stretch of assigned time. */
export const targetUnits = (processingSec: number, ms: number): number =>
  processingSec > 0 ? (ms / 1000) / processingSec : 0;

/** Achievement % (1 decimal, uncapped — 125% renders as 125%). null when the
 *  target is too small to be meaningful (< 60 assigned seconds), so a machine
 *  assigned moments ago never flashes 4000%. */
export function achievementPct(actual: number, processingSec: number, ms: number): number | null {
  if (ms < 60_000) return null;
  const target = targetUnits(processingSec, ms);
  if (target <= 0) return null;
  return Math.round((actual / target) * 1000) / 10;
}

/** Display form of a target: whole number when it is one, else 1 decimal. */
export const fmtTarget = (n: number): string =>
  Number.isInteger(Math.round(n * 10) / 10) ? String(Math.round(n)) : (Math.round(n * 10) / 10).toFixed(1);

/** "3m" / "2m 30s" — how a processing time reads on a card. */
export function fmtProcessing(sec: number): string {
  const m = Math.floor(sec / 60), s = sec % 60;
  if (!m) return `${s}s`;
  return s ? `${m}m ${s}s` : `${m}m`;
}

/** Per-hour rate for a processing time — the number supervisors sanity-check. */
export const hourlyRate = (processingSec: number): number => targetUnits(processingSec, 3_600_000);
