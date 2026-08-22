// client/src/components/RangeFilter.tsx
// ONE window control, reused wherever a page or panel asks "which time window am
// I looking at": a single button that opens the presets (Today / Yesterday /
// This Week / Previous Week / This Month / This Year) plus a custom range picked
// as SEPARATE date and OPTIONAL time — two dates on their own mean whole days.
//
// It owns no state: the caller keeps {preset, customFrom, customTo} and resolves
// it with store/filters#resolveRange, so the same selection also drives shifts.
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Calendar, CalendarRange, Check, ChevronDown } from 'lucide-react';
import Modal from './Modal';
import { fmtTime, fmtRangeLabel } from '../lib/format';
import { DATE_PRESETS, presetLabel, type DatePreset } from '../store/filters';

export interface RangeValue {
  preset: DatePreset;
  customFrom: string;   // datetime-local strings, custom preset only
  customTo: string;
}

interface RangeFilterProps {
  value: RangeValue;
  onChange: (value: RangeValue) => void;
  /** The resolved window, used to label the button when the preset is custom. */
  range?: { from: Date; to: Date } | null;
  className?: string;
  title?: string;
}

export default function RangeFilter({ value, onChange, range, className = '', title = 'Change the window' }: RangeFilterProps): JSX.Element {
  const [open, setOpen] = useState(false);
  const [picking, setPicking] = useState(false);
  const box = useRef<HTMLDivElement | null>(null);

  // Close on outside click / Escape — a menu that traps the page is worse than
  // no menu. Listeners only exist while it's open.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (box.current && !box.current.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey); };
  }, [open]);

  const label = value.preset === 'custom'
    ? (range ? fmtRangeLabel(range.from, range.to) : 'Custom range')
    : presetLabel(value.preset);

  return (
    <div ref={box} className={`relative ${className}`}>
      <button
        type="button" onClick={() => setOpen((v) => !v)} title={title}
        className="inline-flex items-center gap-1.5 rounded-lg border border-line bg-base px-2.5 py-1.5 text-sm text-primary hover:border-accent/40 transition-colors max-w-full"
      >
        <Calendar size={14} className="text-accent shrink-0" />
        <span className="truncate">{label}</span>
        <ChevronDown size={13} className={`text-steel shrink-0 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>

      {open && (
        <div className="absolute right-0 z-30 mt-1 w-56 panel p-1 shadow-lg">
          {DATE_PRESETS.map((p) => (
            <MenuItem key={p.value} active={value.preset === p.value} onClick={() => { onChange({ ...value, preset: p.value }); setOpen(false); }}>
              {p.label}
            </MenuItem>
          ))}
          <div className="my-1 border-t border-line" />
          <MenuItem active={value.preset === 'custom'} onClick={() => { setOpen(false); setPicking(true); }}>
            <span className="inline-flex items-center gap-1.5"><CalendarRange size={13} /> Custom date &amp; time…</span>
          </MenuItem>
        </div>
      )}

      {picking && (
        <CustomRangeModal
          from={value.customFrom} to={value.customTo}
          onClose={() => setPicking(false)}
          onApply={(from, to) => { onChange({ preset: 'custom', customFrom: from, customTo: to }); setPicking(false); }}
        />
      )}
    </div>
  );
}

function MenuItem({ active, onClick, children }: { active: boolean; onClick: () => void; children: ReactNode }): JSX.Element {
  return (
    <button
      type="button" onClick={onClick}
      className={`w-full text-left rounded-md px-2.5 py-1.5 text-sm flex items-center justify-between gap-2 transition-colors ${
        active ? 'bg-accent/10 text-accent font-medium' : 'text-primary hover:bg-base'
      }`}
    >
      {children}
      {active && <Check size={13} className="shrink-0" />}
    </button>
  );
}

// Custom window picker — a popup, so these inputs never clutter the filter bar.
// Date and time are SEPARATE, and the time is optional: two dates on their own
// are a complete range (00:00 of the first day → 23:59 of the last).
export function CustomRangeModal({ from, to, subtitle = 'Every figure in this view uses this window', onClose, onApply }: {
  from: string; to: string; subtitle?: string; onClose: () => void; onApply: (from: string, to: string) => void;
}): JSX.Element {
  const [fromDay, setFromDay] = useState(from.split('T')[0] || '');
  const [fromTime, setFromTime] = useState(from.split('T')[1] || '');
  const [toDay, setToDay] = useState(to.split('T')[0] || '');
  const [toTime, setToTime] = useState(to.split('T')[1] || '');

  // Callers keep datetime-local strings, so re-attach the implied times here.
  const start = fromDay ? `${fromDay}T${fromTime || '00:00'}` : '';
  const end = toDay ? `${toDay}T${toTime || '23:59'}` : '';
  const valid = !!start && !!end && new Date(start) < new Date(end);

  return (
    <Modal title="Custom date range" subtitle={subtitle} icon={CalendarRange} onClose={onClose} maxW="max-w-md">
      <div className="space-y-4">
        <DayTimeRow label="From" day={fromDay} time={fromTime} onDay={setFromDay} onTime={setFromTime} maxDay={toDay || undefined} />
        <DayTimeRow label="To" day={toDay} time={toTime} onDay={setToDay} onTime={setToTime} minDay={fromDay || undefined} />

        <div className="rounded-xl border border-line bg-base px-3.5 py-2.5 text-xs">
          <span className="text-steel">Window · </span>
          {valid
            ? <span className="data font-semibold text-primary">{fmtTime(start)} → {fmtTime(end)}</span>
            : <span className="text-steel/70">pick a start date and an end date</span>}
          <div className="text-[10px] text-steel/70 mt-0.5">Leave a time empty to cover the whole day.</div>
        </div>

        {!valid && !!start && !!end && <div className="text-[11px] text-amber-600">The start must come before the end.</div>}

        <div className="flex justify-end gap-2 pt-1">
          <button onClick={onClose} className="rounded-xl border border-line px-3.5 py-2 text-sm text-steel hover:text-primary transition-colors">Cancel</button>
          <button onClick={() => onApply(start, end)} disabled={!valid}
            className="rounded-xl bg-accent px-3.5 py-2 text-sm font-medium text-white disabled:opacity-40 disabled:cursor-not-allowed hover:opacity-90 transition-opacity">
            Apply range
          </button>
        </div>
      </div>
    </Modal>
  );
}

// One edge of the range: the date (required) and the time (optional, clearable).
function DayTimeRow({ label, day, time, onDay, onTime, minDay, maxDay }: {
  label: string; day: string; time: string; onDay: (v: string) => void; onTime: (v: string) => void; minDay?: string; maxDay?: string;
}): JSX.Element {
  const field = 'rounded-xl border border-line bg-base px-3 py-2 text-sm text-primary outline-none focus:border-accent';
  return (
    <div>
      <div className="label mb-1">{label}</div>
      <div className="flex items-center gap-2">
        <input type="date" value={day} min={minDay} max={maxDay} onChange={(e) => onDay(e.target.value)} className={`${field} flex-1`} />
        <input type="time" value={time} onChange={(e) => onTime(e.target.value)} className={`${field} w-[130px]`} title="Optional" />
        {time && (
          <button onClick={() => onTime('')} title="Clear time"
            className="text-[10px] text-steel hover:text-accent transition-colors shrink-0">clear</button>
        )}
      </div>
    </div>
  );
}
