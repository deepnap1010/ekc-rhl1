// client/src/store/filters.ts
// Global analysis filters — ONE machine / shift / date-range selection shared by
// the Dashboard (and any page that opts in), so every metric on a filtered view
// derives from the same dataset. Selection survives navigation within a session.
import { useEffect } from 'react';
import { create } from 'zustand';
import { currentShift, shiftWindowOn, type ShiftTiming } from '../lib/settings';

export type DatePreset = 'today' | 'yesterday' | 'week' | 'prevWeek' | 'month' | 'year' | 'custom';

// The quick presets rendered as buttons (custom lives behind its own popup).
export const DATE_PRESETS: { value: DatePreset; label: string }[] = [
  { value: 'today',     label: 'Today' },
  { value: 'yesterday', label: 'Yesterday' },
  { value: 'week',      label: 'This Week' },
  { value: 'prevWeek',  label: 'Previous Week' },
  { value: 'month',     label: 'This Month' },
  { value: 'year',      label: 'This Year' },
];

export const presetLabel = (p: DatePreset): string =>
  p === 'custom' ? 'Custom range' : (DATE_PRESETS.find((d) => d.value === p)?.label || '');

interface FiltersState {
  machineId: string;   // '' = all machines
  shiftName: string;   // '' = all shifts / full day
  preset: DatePreset;
  customFrom: string;  // datetime-local strings (custom preset only)
  customTo: string;
  // False until someone picks a shift themselves. While it is false the shift
  // follows the clock (see useCurrentShiftDefault) — a board on the wall should
  // be showing the shift that is on the floor, not the one that opened the page.
  shiftPicked: boolean;
  set: (patch: Partial<Omit<FiltersState, 'set' | 'reset'>>) => void;
  reset: () => void;
}

export const useFilters = create<FiltersState>((set) => ({
  machineId: '', shiftName: '', preset: 'today', customFrom: '', customTo: '', shiftPicked: false,
  // Choosing a shift by hand pins it; everything else leaves it following.
  set: (patch) => set('shiftName' in patch ? { ...patch, shiftPicked: true } : patch),
  reset: () => set({ machineId: '', shiftName: '', preset: 'today', customFrom: '', customTo: '', shiftPicked: false }),
}));

/** Keeps the filter on the shift that is running, until someone picks one.
 *
 *  The default view of a factory dashboard is the work happening now, and "now"
 *  on a three-shift floor is a shift, not a calendar day — a full day at 08:00
 *  averages the shift in progress with two that have not run. Re-checked every
 *  minute, so a screen left open rolls over at the shift change on its own.
 *  Only ever writes while the user has not chosen a shift, and never on a
 *  multi-day preset, where a single shift window would be a lie. */
export function useCurrentShiftDefault(shifts: ShiftTiming[]): void {
  const shiftPicked = useFilters((s) => s.shiftPicked);
  const preset = useFilters((s) => s.preset);
  const shiftName = useFilters((s) => s.shiftName);
  useEffect(() => {
    if (shiftPicked || !shifts.length) return;
    const apply = (): void => {
      if (!shiftApplies(preset)) return;
      const now = currentShift(shifts)?.name || '';
      // setState directly: going through `set` would mark the shift as picked.
      if (now !== useFilters.getState().shiftName) useFilters.setState({ shiftName: now });
    };
    apply();
    const t = setInterval(apply, 60_000);
    return () => clearInterval(t);
  }, [shifts, shiftPicked, preset, shiftName]);
}

// A shift only narrows a SINGLE-DAY selection (today / yesterday) to its concrete
// window — multi-day "shift totals" would need per-day windows the range engine
// doesn't reconstruct yet, and we never show approximations as real figures.
export function shiftApplies(preset: DatePreset): boolean {
  return preset === 'today' || preset === 'yesterday';
}

const dayStart = (offsetDays: number): Date => {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + offsetDays);
  return d;
};

// Monday-based week start (factory weeks run Mon–Sun here).
const weekStart = (offsetWeeks: number): Date => {
  const d = dayStart(0);
  const back = (d.getDay() + 6) % 7;          // Sun(0) → 6, Mon(1) → 0
  d.setDate(d.getDate() - back + offsetWeeks * 7);
  return d;
};

const monthStart = (): Date => {
  const d = dayStart(0);
  d.setDate(1);
  return d;
};

const yearStart = (): Date => {
  const d = monthStart();
  d.setMonth(0);
  return d;
};

// `to` is rounded down to the minute so query keys (and the server-side cache)
// stay stable between renders instead of busting on every tick.
const nowRounded = (): Date => new Date(Math.floor(Date.now() / 60_000) * 60_000);

/** THE production day for a calendar date — the UNION of that day's shift
 *  windows, so "Full day" is exactly Shift A + Shift B + Shift C and no piece is
 *  counted in two days or in none.
 *
 *  With A 07:00-15:00 / B 15:00-23:00 / C 23:00-07:00 the day runs 07:00 -> 07:00
 *  next morning: the night shift's output stays with the day it CLOCKED IN on,
 *  which is the same day the PLC stamps into SHIFT_DATE (it resets PROD_DAY at
 *  07:00, not at midnight). A plain midnight-to-midnight day splits that shift in
 *  half and reads its post-midnight pieces as today's.
 *
 *  No shifts configured -> the calendar day, unchanged. */
export function shiftDayOn(shifts: ShiftTiming[], day: Date): { from: Date; to: Date } {
  if (!shifts.length) {
    const from = new Date(day); from.setHours(0, 0, 0, 0);
    const to = new Date(from); to.setDate(to.getDate() + 1);
    return { from, to };
  }
  const wins = shifts.map((sh) => shiftWindowOn(sh, day));
  return {
    from: new Date(Math.min(...wins.map((w) => w.from.getTime()))),
    to: new Date(Math.max(...wins.map((w) => w.to.getTime()))),
  };
}

/** The production day CONTAINING `at` — the window a historical moment belongs
 *  to. A reading at 03:00 belongs to YESTERDAY's production day, by the same
 *  rule runningDayAnchor applies to "now". Built for the machine cards' dark
 *  fallback: a machine whose signal died on Tuesday answers for Tuesday. */
export function dayWindowAt(shifts: ShiftTiming[], at: Date): { from: Date; to: Date } {
  const day = new Date(at);
  day.setHours(0, 0, 0, 0);
  const w = shiftDayOn(shifts, day);
  if (at.getTime() < w.from.getTime()) {
    day.setDate(day.getDate() - 1);
    return shiftDayOn(shifts, day);
  }
  return w;
}

/** The calendar date whose production day is RUNNING right now.
 *
 *  At 03:00 the plant is mid night-shift, and that shift belongs to YESTERDAY —
 *  which is exactly what the PLC still stamps into SHIFT_DATE (verified: the
 *  23:00 shift carries the previous date right through to 07:00). Anchoring on
 *  today's calendar date instead would open a window that starts in the future,
 *  and the night shift would stare at an empty dashboard until 07:00. */
function runningDayAnchor(shifts: ShiftTiming[]): Date {
  const today = dayStart(0);
  return nowRounded() < shiftDayOn(shifts, today).from ? dayStart(-1) : today;
}

/** Today's production day so far. EVERY "today" surface — the machine cards, the
 *  machine Overview tiles, the Full-day filter — must resolve through this, or
 *  two panels on one screen quote different days. */
export function todayWindow(shifts: ShiftTiming[]): { from: Date; to: Date } {
  const { from } = shiftDayOn(shifts, runningDayAnchor(shifts));
  return { from, to: new Date(Math.max(nowRounded().getTime(), from.getTime() + 60_000)) };
}

/** Clip a window's end to NOW, rounded to the minute.
 *
 *  A shift window runs to the shift's SCHEDULED end, so mid-shift it reaches
 *  into the future — and then a card prints a range it has no readings for and
 *  a reading count that covers only part of it. Rounding matters as much as the
 *  clipping: an unrounded now() changes every react-query key on every render
 *  and refetches in a loop. todayWindow already does this for itself; anything
 *  built from shiftWindowOn has to ask. */
export function clampToNow(r: { from: Date; to: Date }): { from: Date; to: Date } {
  if (r.to.getTime() <= Date.now()) return r;
  const now = Math.max(nowRounded().getTime(), r.from.getTime() + 60_000);
  return { from: r.from, to: new Date(now) };
}

/** Resolve the current filter selection to a concrete [from, to], or null while
 *  a custom range is incomplete/invalid. */
export function resolveRange(
  f: Pick<FiltersState, 'preset' | 'shiftName' | 'customFrom' | 'customTo'>,
  shifts: ShiftTiming[]
): { from: Date; to: Date } | null {
  if (f.preset === 'custom') {
    const from = new Date(f.customFrom);
    const to = new Date(f.customTo);
    if (!f.customFrom || !f.customTo || Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || from >= to) return null;
    return { from, to };
  }

  // "Today" and "Yesterday" are production days, counted from the one running
  // now — so at 03:00 they don't silently shift by one under the night shift.
  const anchor = runningDayAnchor(shifts);
  const prev = new Date(anchor); prev.setDate(prev.getDate() - 1);
  const shift = f.shiftName && shiftApplies(f.preset) ? shifts.find((s) => s.name === f.shiftName) : null;
  if (f.preset === 'today') {
    if (shift) return shiftWindowOn(shift, anchor);
    return todayWindow(shifts);
  }
  if (f.preset === 'yesterday') {
    if (shift) return shiftWindowOn(shift, prev);
    return shiftDayOn(shifts, prev);
  }
  // Completed period → fixed end; running period → up to now.
  if (f.preset === 'prevWeek') return { from: weekStart(-1), to: weekStart(0) };
  const from = f.preset === 'week' ? weekStart(0) : f.preset === 'month' ? monthStart() : yearStart();
  return { from, to: new Date(Math.max(nowRounded().getTime(), from.getTime() + 60_000)) };
}
