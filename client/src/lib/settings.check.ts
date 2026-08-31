// client/src/lib/settings.check.ts — npx tsx src/lib/settings.check.ts
// The dashboard opens on the shift that is on the floor, so "which shift is
// running" has to be right at every hour of the clock — including the night
// shift, whose window belongs to the day it clocked IN on.
import { currentShift, shiftWindowOn, type ShiftTiming } from './settings.js';

const SHIFTS: ShiftTiming[] = [
  { name: 'Shift A', start: '07:00', end: '15:00' },
  { name: 'Shift B', start: '15:00', end: '23:00' },
  { name: 'Shift C', start: '23:00', end: '07:00' },
];

const eq = (a: unknown, b: unknown, m: string): void => {
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`);
};
const at = (h: number, m = 0): Date => new Date(2026, 7, 31, h, m, 0, 0);
const shiftAt = (h: number, m = 0): string => currentShift(SHIFTS, at(h, m))?.name ?? '—';

// ── every hour of the clock lands in exactly one shift ───────────────────────
for (const h of [0, 1, 3, 6]) eq(shiftAt(h), 'Shift C', `${h}:00 is the night shift`);
for (const h of [7, 11, 14]) eq(shiftAt(h), 'Shift A', `${h}:00 is the morning shift`);
for (const h of [15, 19, 22]) eq(shiftAt(h), 'Shift B', `${h}:00 is the afternoon shift`);
eq(shiftAt(23), 'Shift C', '23:00 starts the night shift');

// ── a shift owns its own start minute, not the previous shift's end ──────────
eq(shiftAt(15, 0), 'Shift B', '15:00 exactly belongs to the shift starting');
eq(shiftAt(14, 59), 'Shift A', '14:59 still belongs to the shift ending');
eq(shiftAt(6, 59), 'Shift C', '06:59 is still the night shift');
eq(shiftAt(7, 0), 'Shift A', '07:00 hands over to the morning');

// ── never guess ──────────────────────────────────────────────────────────────
eq(currentShift([], at(10)), null, 'no shifts configured → no default');
eq(currentShift([{ name: 'Day', start: '09:00', end: '17:00' }], at(3)), null,
  'a gap in the schedule defaults to nothing rather than the wrong shift');

// ── the night shift really does span midnight ────────────────────────────────
const w = shiftWindowOn(SHIFTS[2], new Date(2026, 7, 30));
eq([w.from.getDate(), w.to.getDate()], [30, 31], 'the night window runs into the next day');

// ── a single round-the-clock shift covers everything ─────────────────────────
const allDay: ShiftTiming[] = [{ name: 'General', start: '00:00', end: '00:00' }];
eq(currentShift(allDay, at(13))?.name, 'General', 'a 24h shift covers midday');
eq(currentShift(allDay, at(2))?.name, 'General', 'and the small hours');

console.log('settings: all checks passed');
