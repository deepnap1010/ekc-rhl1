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
    const from = dayStart(0);
    // First minute after midnight: nowRounded() == from — keep to strictly after from.
    const to = new Date(Math.max(nowRounded().getTime(), from.getTime() + 60_000));
    return { from, to };
  }
  if (f.preset === 'yesterday') {
    if (shift) return shiftWindowOn(shift, dayStart(-1));
    return { from: dayStart(-1), to: dayStart(0) };
  }
  // Completed period → fixed end; running period → up to now.
  if (f.preset === 'prevWeek') return { from: weekStart(-1), to: weekStart(0) };
  const from = f.preset === 'week' ? weekStart(0) : f.preset === 'month' ? monthStart() : yearStart();
  return { from, to: new Date(Math.max(nowRounded().getTime(), from.getTime() + 60_000)) };
}
