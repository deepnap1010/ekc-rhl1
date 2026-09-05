// Self-check for the window resolvers. Run: npx tsx client/src/store/filters.check.ts
import { dayWindowAt, shiftDayOn, clampToNow } from './filters.js';
import type { ShiftTiming } from '../lib/settings.js';

const eq = (what: string, got: unknown, want: unknown): void => {
  if (JSON.stringify(got) !== JSON.stringify(want)) throw new Error(`${what}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
};

const SHIFTS: ShiftTiming[] = [
  { name: 'A', start: '07:00', end: '15:00' },
  { name: 'B', start: '15:00', end: '23:00' },
  { name: 'C', start: '23:00', end: '07:00' },
];
const at = (d: number, h: number, m = 0): Date => new Date(2026, 8, d, h, m); // Sep 2026, local

// The production day runs 07:00 -> 07:00. A moment inside it maps to it…
eq('mid-morning belongs to its own day',
  dayWindowAt(SHIFTS, at(3, 10)).from.getTime(), shiftDayOn(SHIFTS, at(3, 0)).from.getTime());
// …and the small hours belong to YESTERDAY's day — the night shift clocked in
// on the 2nd, and the PLC stamps its pieces with the 2nd right through to 07:00.
eq('03:00 belongs to the previous production day',
  dayWindowAt(SHIFTS, at(3, 3)).from.getTime(), shiftDayOn(SHIFTS, at(2, 0)).from.getTime());
// The boundary minute itself opens the NEW day.
eq('07:00 exactly starts the new day',
  dayWindowAt(SHIFTS, at(3, 7)).from.getTime(), shiftDayOn(SHIFTS, at(3, 0)).from.getTime());
// No shifts configured -> plain calendar day, same fallback shiftDayOn uses.
eq('no shifts -> calendar day', dayWindowAt([], at(3, 3)).from.getHours(), 0);

// clampToNow: a finished day passes through untouched; its END must not move,
// or the last-active-day card would quietly shrink history.
const past = shiftDayOn(SHIFTS, at(1, 0));
eq('a finished day is not clipped', clampToNow(past).to.getTime(), past.to.getTime());

// A schedule with a gap (no night shift): a 23:30 reading still belongs to its
// own day, in a window stretched to contain it — not to a window that ends at
// 23:00 and would exclude the machine's own last half hour.
const DAY_SHIFTS: ShiftTiming[] = [
  { name: 'A', start: '07:00', end: '15:00' },
  { name: 'B', start: '15:00', end: '23:00' },
];
const gapRead = at(3, 23, 30);
const gapWin = dayWindowAt(DAY_SHIFTS, gapRead);
eq('a gap reading stays on its own day', gapWin.from.getTime(), shiftDayOn(DAY_SHIFTS, at(3, 0)).from.getTime());
eq('and the window contains it', gapWin.to.getTime() > gapRead.getTime(), true);

console.log('filters: all checks passed');
