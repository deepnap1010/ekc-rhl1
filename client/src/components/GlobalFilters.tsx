// client/src/components/GlobalFilters.tsx
// THE selection every analysis screen shares — machine · shift · date window,
// held in store/filters. One bar, rendered by the Dashboard and the Reports
// page, so what you pick on one is what the other shows; both then read the
// same activity dataset for the same window, and their figures cannot drift.
import { useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { CalendarRange, RotateCcw } from 'lucide-react';
import { machineApi } from '../api/endpoints';
import { CustomRangeModal } from './RangeFilter';
import { useAppConfig } from '../hooks/useAppConfig';
import { useFilters, resolveRange, shiftApplies, presetLabel, DATE_PRESETS, useCurrentShiftDefault } from '../store/filters';
import { fmtTime, fmtRangeLabel, prettyType } from '../lib/format';
import { useMachineName } from '../lib/machineName';

/** The shared selection resolved to one concrete window, plus the words for it. */
export function useGlobalWindow() {
  const { shifts } = useAppConfig();
  const f = useFilters();
  const range = resolveRange(f, shifts);
  const windowLabel = f.preset === 'custom' && range
    ? fmtRangeLabel(range.from, range.to)
    : f.shiftName && shiftApplies(f.preset)
      ? `${f.shiftName} · ${presetLabel(f.preset)}`
      : presetLabel(f.preset);
  return { f, shifts, range, fromISO: range?.from.toISOString(), toISO: range?.to.toISOString(), windowLabel };
}

export default function GlobalFilters({ extra, modalSubtitle }: { extra?: ReactNode; modalSubtitle?: string }): JSX.Element {
  const mName = useMachineName();
  const { defaultWindow } = useAppConfig();
  const { f, shifts, range, windowLabel } = useGlobalWindow();
  // Keeps the shift on the one running until someone picks — owned here, once
  // per page, because this bar is mounted exactly once on every page that has it.
  useCurrentShiftDefault(shifts, defaultWindow === 'shift');
  const [pickRange, setPickRange] = useState(false);

  // Machine selector options — the real machine dataset, not a hard-coded list.
  const { data: machineList } = useQuery({
    queryKey: ['machines', 'selector'],
    queryFn: () => machineApi.list({ limit: 200, sort: 'name' }).then((r) => r.data),
    staleTime: 60_000,
    refetchInterval: 60_000,
  });
  // The shift default is not a filter the user set, so it does not count as dirty.
  const atDefaults = !f.machineId && !f.shiftPicked && f.preset === 'today';

  return (
    <>
      <div className="panel p-3 space-y-2.5">
        <div className="flex items-center gap-2 flex-wrap">
          <select
            value={f.machineId}
            onChange={(e) => f.set({ machineId: e.target.value })}
            className={`rounded-xl border px-3 py-2 text-sm outline-none cursor-pointer transition-colors hover:border-accent/40 max-w-[240px] ${f.machineId ? 'border-accent/40 bg-accent/5 text-accent font-medium' : 'border-line bg-base text-primary'}`}
            title="Scope every figure to one machine"
          >
            <option value="">All Machines</option>
            {(machineList || []).map((m) => {
              const code = m.code || m.machineId || m._id;
              return <option key={code} value={code}>{mName(code)}{m.type ? ` · ${prettyType(m.type)}` : ''}</option>;
            })}
          </select>

          <select
            value={shiftApplies(f.preset) ? f.shiftName : ''}
            onChange={(e) => f.set({ shiftName: e.target.value })}
            disabled={!shiftApplies(f.preset)}
            className={`rounded-xl border px-3 py-2 text-sm outline-none cursor-pointer transition-colors hover:border-accent/40 disabled:opacity-45 disabled:cursor-not-allowed ${f.shiftName && shiftApplies(f.preset) ? 'border-accent/40 bg-accent/5 text-accent font-medium' : 'border-line bg-base text-primary'}`}
            title={shiftApplies(f.preset) ? 'Scope to a shift window' : 'Shift filtering applies to Today / Yesterday'}
          >
            <option value="">All Shifts</option>
            {shifts.map((sh) => <option key={sh.name} value={sh.name}>{sh.name} · {sh.start}–{sh.end}</option>)}
          </select>

          <span className="ml-auto text-[11px] text-steel">
            {range ? `${fmtTime(range.from)} → ${fmtTime(range.to)}` : 'Pick a valid start & end to apply the range.'}
          </span>
        </div>

        {/* Date window — buttons, with the custom picker behind a popup */}
        <div className="flex items-center gap-1.5 flex-wrap">
          {DATE_PRESETS.map((p) => (
            <PresetButton key={p.value} active={f.preset === p.value} onClick={() => f.set({ preset: p.value })}>
              {p.label}
            </PresetButton>
          ))}
          <PresetButton active={f.preset === 'custom'} onClick={() => setPickRange(true)}>
            <CalendarRange size={13} /> {f.preset === 'custom' && range ? windowLabel : 'Custom…'}
          </PresetButton>
          {/* Always present, never a surprise: a control that appears only once
              you've changed something is a control nobody knows exists. */}
          <button
            onClick={() => f.reset()}
            disabled={atDefaults}
            title={atDefaults ? 'Filters are already at their defaults' : 'Back to All Machines · the running shift · Today'}
            className="inline-flex items-center gap-1.5 rounded-lg border border-line px-2.5 py-1.5 text-xs font-medium text-steel hover:text-accent hover:border-accent/40 transition-colors shrink-0 disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:text-steel disabled:hover:border-line"
          >
            <RotateCcw size={13} /> Reset
          </button>
          {extra}
        </div>
      </div>

      {pickRange && (
        <CustomRangeModal
          from={f.customFrom} to={f.customTo}
          subtitle={modalSubtitle}
          onClose={() => setPickRange(false)}
          onApply={(customFrom, customTo) => { f.set({ preset: 'custom', customFrom, customTo }); setPickRange(false); }}
        />
      )}
    </>
  );
}

function PresetButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: ReactNode }): JSX.Element {
  return (
    <button onClick={onClick}
      className={`inline-flex items-center gap-1 rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors ${
        active ? 'border-accent bg-accent text-white' : 'border-line bg-base text-steel hover:text-accent hover:border-accent/40'
      }`}
    >
      {children}
    </button>
  );
}
