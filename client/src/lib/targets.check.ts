// client/src/lib/targets.check.ts — run: npx tsx client/src/lib/targets.check.ts
import { assignedMs, targetUnits, achievementPct, fmtTarget, fmtProcessing, hourlyRate } from './targets.js';

const eq = (a: unknown, b: unknown, m: string): void => {
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`);
};
const close = (a: number, b: number, m: string): void => {
  if (Math.abs(a - b) > 1e-9) throw new Error(`${m}: ${a} != ${b}`);
};

const T0 = Date.parse('2026-08-26T07:00:00Z');
const HOUR = 3_600_000;
const asg = (from: number, to: number | null, sec = 180) => ({
  effectiveFrom: new Date(from), effectiveTo: to == null ? null : new Date(to), snapshot: { processingSec: sec },
});

// The brief's own example: 3 min/unit → 20/hr, 160 per 8h shift.
close(targetUnits(180, HOUR), 20, '3 min → 20/hr');
close(targetUnits(180, 8 * HOUR), 160, '3 min → 160/shift');
close(hourlyRate(180), 20, 'hourlyRate agrees');

// 60/7 stays EXACT — never floored to 8 or ceiled to 9.
close(targetUnits(7 * 60, HOUR), 60 / 7, '60/7 exact');
eq(fmtTarget(60 / 7), '8.6', '60/7 displays 8.6');
close(targetUnits(7 * 60, 8 * HOUR), 480 / 7, '8h at 60/7 = 68.57…, not 64 or 72');

// Overlap: assigned mid-window → partial target.
eq(assignedMs(asg(T0 + 37 * 60_000, null), T0, T0 + HOUR), 23 * 60_000, 'assigned at :37 → 23 min of the hour');
close(targetUnits(180, assignedMs(asg(T0 + 37 * 60_000, null), T0, T0 + HOUR)), 23 / 3, 'partial-hour target');

// Reassignment mid-hour: the two ranges split the hour exactly, nothing lost.
const mid = T0 + 30 * 60_000;
eq(assignedMs(asg(T0 - HOUR, mid), T0, T0 + HOUR) + assignedMs(asg(mid, null), T0, T0 + HOUR), HOUR, 'mid-hour split sums to the hour');

// No assignment overlap → zero, and achievement suppresses instead of exploding.
eq(assignedMs(asg(T0 + 2 * HOUR, null), T0, T0 + HOUR), 0, 'future assignment → 0');
eq(achievementPct(5, 180, 30_000), null, '30s assigned → suppressed, not 4000%');

// Achievement: the brief's 50% and 125% cases, exact and uncapped.
close(achievementPct(10, 180, HOUR) as number, 50, '10 of 20 → 50%');
close(achievementPct(25, 180, HOUR) as number, 125, '25 of 20 → 125% (uncapped)');

// Display helpers.
eq(fmtTarget(20), '20', 'whole targets stay whole');
eq(fmtProcessing(180), '3m', '180s → 3m');
eq(fmtProcessing(150), '2m 30s', '150s → 2m 30s');
eq(fmtProcessing(45), '45s', '45s → 45s');

console.log('targets: all checks passed');
