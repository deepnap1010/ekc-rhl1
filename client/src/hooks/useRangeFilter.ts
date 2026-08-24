// client/src/hooks/useRangeFilter.ts
// One window control, one behaviour, wherever a page needs "which period am I
// looking at": the presets, the custom date+time popup and the resolver are all
// shared, so "This Week" means the same window on the dashboard, the history log
// and the downtime archive — and a page can never quietly invent its own.
//
// The page owns the state; this only wires it to store/filters#resolveRange and
// hands back the resolved edges as ISO strings, which is what every API wants.
import { useState } from 'react';
import type { RangeValue } from '../components/RangeFilter';
import { resolveRange, type DatePreset } from '../store/filters';
import { useAppConfig } from './useAppConfig';

export interface RangeFilterState {
  value: RangeValue;
  setValue: (v: RangeValue) => void;
  /** Resolved window, or null while a custom range is half-filled. */
  range: { from: Date; to: Date } | null;
  fromISO?: string;
  toISO?: string;
}

export function useRangeFilter(initial: DatePreset = 'week'): RangeFilterState {
  // Shifts matter because the production day runs 07:00 -> 07:00, not midnight
  // to midnight — resolveRange needs them to answer "today" the way the plant does.
  const { shifts } = useAppConfig();
  const [value, setValue] = useState<RangeValue>({ preset: initial, customFrom: '', customTo: '' });
  const range = resolveRange(
    { preset: value.preset, shiftName: '', customFrom: value.customFrom, customTo: value.customTo },
    shifts,
  );
  return {
    value,
    setValue,
    range,
    fromISO: range?.from.toISOString(),
    toISO: range?.to.toISOString(),
  };
}
