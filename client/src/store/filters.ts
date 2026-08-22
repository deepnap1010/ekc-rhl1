// client/src/store/filters.ts
// Global analysis filters — ONE machine / shift / date-range selection shared by
// the Dashboard (and any page that opts in), so every metric on a filtered view
// derives from the same dataset. Selection survives navigation within a session.
import { create } from 'zustand';
import { shiftWindowOn, type ShiftTiming } from '../lib/settings';

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
  set: (patch: Partial<Omit<FiltersState, 'set' | 'reset'>>) => void;
  reset: () => void;
}

export const useFilters = create<FiltersState>((set) => ({
  machineId: '', shiftName: '', preset: 'today', customFrom: '', customTo: '',
  set: (patch) => set(patch),
  reset: () => set({ machineId: '', shiftName: '', preset: 'today', customFrom: '', customTo: '' }),
}));

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

/** Today's production day so far. EVERY "today" surface — the machine cards, the
 *  machine Overview tiles, the Full-day filter — must resolve through this, or
 *  two panels on one screen quote different days. */
export function todayWindow(shifts: ShiftTiming[]): { from: Date; to: Date } {
  const { from } = shiftDayOn(shifts, dayStart(0));
  // Before the first shift starts, today's day hasn't opened yet: the window
  // stays empty (the shift running at 03:00 belongs to YESTERDAY's last shift).
  return { from, to: new Date(Math.max(nowRounded().getTime(), from.getTime() + 60_000)) };
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

  const shift = f.shiftName && shiftApplies(f.preset) ? shifts.find((s) => s.name === f.shiftName) : null;
  if (f.preset === 'today') {
    if (shift) return shiftWindowOn(shift, dayStart(0));
    return todayWindow(shifts);
  }
  if (f.preset === 'yesterday') {
    if (shift) return shiftWindowOn(shift, dayStart(-1));
    return shiftDayOn(shifts, dayStart(-1));
  }
  // Completed period → fixed end; running period → up to now.
  if (f.preset === 'prevWeek') return { from: weekStart(-1), to: weekStart(0) };
  const from = f.preset === 'week' ? weekStart(0) : f.preset === 'month' ? monthStart() : yearStart();
  return { from, to: new Date(Math.max(nowRounded().getTime(), from.getTime() + 60_000)) };
}
