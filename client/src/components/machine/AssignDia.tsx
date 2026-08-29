// client/src/components/machine/AssignDia.tsx
// The machine-side DIA controls: a header chip showing what the machine is
// running ("40L · Cutting"), which — for anyone holding production.update —
// opens the assignment modal right there on the floor. Both this and the
// Configure tab write through the same endpoint: close the open assignment,
// freeze a new snapshot, write an audit row.
import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Target, Check, Ruler, History as HistoryIcon, CalendarClock } from 'lucide-react';
import { productionApi } from '../../api/endpoints';
import Modal from '../Modal';
import { useAuthStore } from '../../store/auth';
import { toast } from '../../store/toast';
import { fmtTarget, fmtProcessing, hourlyRate, secToMinPerPc } from '../../lib/targets';
import { stageForMachine } from '../../lib/diaStage';
import { useAppConfig } from '../../hooks/useAppConfig';
import { fmtTime } from '../../lib/format';
import { defaultApplyAt } from '../ScheduleDia';
import type { MachineAssignment } from '../../types/api';

/** The machine's open assignment, shared by every surface on the page. */
export function useCurrentAssignment(code: string): MachineAssignment | null {
  const can = useAuthStore((s) => s.can);
  const { data } = useQuery({
    queryKey: ['assignments', 'current'],
    queryFn: () => productionApi.currentAssignments().then((r) => r.data),
    enabled: can('production', 'view'),
    staleTime: 30_000,
    refetchInterval: 60_000,
    retry: false,
  });
  const up = code.toUpperCase();
  return (data || []).find((a) => a.machineRef.toUpperCase() === up) || null;
}

/** Header chip: current DIA · stage. A control when the user may assign. */
export function DiaChip({ code }: { code: string }): JSX.Element | null {
  const can = useAuthStore((s) => s.can);
  const current = useCurrentAssignment(code);
  const [open, setOpen] = useState(false);
  if (!can('production', 'view')) return null;
  const editable = can('production', 'update');
  const label = current ? `${current.snapshot.diaName} · ${current.snapshot.stageName}` : 'No DIA assigned';
  return (
    <>
      <button
        onClick={editable ? () => setOpen(true) : undefined}
        disabled={!editable}
        title={editable ? 'Change what this machine is running' : label}
        className={`inline-flex items-center gap-1.5 text-[11px] font-medium px-2.5 py-1 rounded-full border transition-colors ${
          current ? 'border-accent/30 bg-accent/10 text-accent' : 'border-line bg-base text-steel'
        } ${editable ? 'hover:border-accent cursor-pointer' : 'cursor-default'}`}
      >
        <Target size={11} /> {label}
      </button>
      {open && <AssignDiaModal code={code} current={current} onClose={() => setOpen(false)} />}
    </>
  );
}

/** DIA → stage → target preview → confirm. Also used by the Configure tab. */
export function AssignDiaModal({ code, current, onClose }: {
  code: string; current: MachineAssignment | null; onClose: () => void;
}): JSX.Element {
  const qc = useQueryClient();
  const { data: dias } = useQuery({
    queryKey: ['dia-configs'],
    queryFn: () => productionApi.dia().then((r) => r.data),
  });
  const options = (dias || []).filter((d) => d.active);
  const { shifts } = useAppConfig();
  const { data: trail } = useQuery({
    queryKey: ['dia-history', code],
    queryFn: () => productionApi.assignments({ machineRef: code, limit: 6 }).then((r) => r.data),
  });
  const [diaId, setDiaId] = useState(current?.diaId || '');
  const [stageKey, setStageKey] = useState(current?.stageKey || '');
  const dia = options.find((d) => d._id === diaId);
  const stage = dia?.stages.find((s) => s.key === stageKey && s.active);

  // Picking a dia AUTO-SELECTS the stage: the machine's family names it
  // (a cutting machine gets Cutting), a single-stage dia decides itself. Only
  // when neither settles it does a stage select appear — same rule as the
  // server, which refuses to guess.
  const [askStage, setAskStage] = useState(false);
  const pickDia = (id: string) => {
    setDiaId(id);
    setAskStage(false);
    const d = options.find((x) => x._id === id);
    const active = (d?.stages || []).filter((st) => st.active);
    const hit = stageForMachine(code, d) || (active.length === 1 ? active[0] : null);
    setStageKey(hit?.key || '');
  };

  // ── Schedule for later: same picks, applied at a chosen future minute ──────
  const [schedMode, setSchedMode] = useState(false);
  const [when, setWhen] = useState('');
  const whenAt = when ? new Date(when) : null;
  const whenOk = !!whenAt && !Number.isNaN(whenAt.getTime()) && whenAt.getTime() > Date.now() - 60_000;
  const { data: sched } = useQuery({
    queryKey: ['schedules', code],
    queryFn: () => productionApi.schedules({ machineRef: code }).then((r) => r.data),
  });
  const pendingSched = (sched || []).filter((s) => s.status === 'pending');

  // Per-shift figure beside the hourly one — the number a supervisor plans by.
  const shiftMins = (() => {
    const sh = shifts[0];
    if (!sh) return 8 * 60;
    const [h1, m1] = sh.start.split(':').map(Number);
    const [h2, m2] = sh.end.split(':').map(Number);
    let d = h2 * 60 + m2 - (h1 * 60 + m1);
    if (d <= 0) d += 24 * 60;
    return d;
  })();

  const done = () => {
    qc.invalidateQueries({ queryKey: ['assignments'] });
    qc.invalidateQueries({ queryKey: ['dia-configs'] });
    onClose();
  };
  const assignMut = useMutation({
    mutationFn: () => productionApi.assign({ machineRef: code, diaId, stageKey }),
    onSuccess: () => { toast.success(`${code} → ${dia?.name} / ${stage?.name}`); done(); },
    onError: (e: unknown) => toast.error(e instanceof Error ? e.message : 'Could not assign'),
  });
  const unassignMut = useMutation({
    mutationFn: () => productionApi.unassign(code),
    onSuccess: () => { toast.success('Assignment removed'); done(); },
    onError: (e: unknown) => toast.error(e instanceof Error ? e.message : 'Could not remove'),
  });
  const scheduleMut = useMutation({
    mutationFn: () => productionApi.schedule({ machineRef: code, diaId, stageKey, applyAt: new Date(when).toISOString() }),
    onSuccess: () => {
      toast.success(`Scheduled: ${code} → ${dia?.name} from ${fmtTime(new Date(when).toISOString())}`);
      qc.invalidateQueries({ queryKey: ['schedules'] });
      onClose();
    },
    onError: (e: unknown) => toast.error(e instanceof Error ? e.message : 'Could not schedule'),
  });
  const cancelSchedMut = useMutation({
    mutationFn: (id: string) => productionApi.cancelSchedule(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['schedules'] }),
    onError: (e: unknown) => toast.error(e instanceof Error ? e.message : 'Could not cancel'),
  });

  return (
    <Modal title={`Assign dia · ${code}`} subtitle="The dia defines the product this machine is set up to make" icon={Ruler} onClose={onClose} maxW="max-w-md">
      <div className="space-y-4">
        {/* What it's making right now — the anchor for the change below */}
        {current && (
          <div className="rounded-xl border border-line bg-base px-4 py-2.5 flex items-center gap-2.5">
            <span className="w-7 h-7 rounded-lg bg-running/10 text-running flex items-center justify-center shrink-0"><Check size={14} /></span>
            <div className="min-w-0">
              <div className="text-[10px] uppercase tracking-wide text-steel">Currently making</div>
              <div className="data text-sm font-bold text-primary truncate">{current.snapshot.diaName} · {current.snapshot.stageName}</div>
            </div>
            <span className="ml-auto text-[10px] text-steel shrink-0">since {fmtTime(current.effectiveFrom)}</span>
          </div>
        )}

        {!options.length ? (
          <p className="text-sm text-steel">No active DIA configured yet — create one under <span className="font-medium text-primary">Production Targets</span> first.</p>
        ) : (
          <>
            <div>
              <div className="flex items-center justify-between mb-1.5">
                <span className="label">{current ? 'Change to' : 'DIA / Product'}</span>
                <button
                  onClick={() => { setSchedMode((m) => !m); if (!when) setWhen(defaultApplyAt(shifts[0]?.start)); }}
                  title="Pick a future moment — the machine switches itself then"
                  className={`inline-flex items-center gap-1 text-[11px] font-medium transition-colors ${schedMode ? 'text-accent' : 'text-steel hover:text-accent'}`}
                >
                  <CalendarClock size={11} /> {schedMode ? 'Assign now instead' : 'Schedule for later'}
                </button>
              </div>
              <select value={diaId} onChange={(e) => pickDia(e.target.value)}
                className="w-full bg-base border border-line rounded-lg px-3 py-2 text-sm outline-none focus:border-accent">
                <option value="">No dia</option>
                {options.map((d) => (
                  <option key={d._id} value={d._id}>{d.name}{d.dims ? ` · ${d.dims}` : ''}</option>
                ))}
              </select>
            </div>

            {/* The stage is auto-selected from the machine's family; the saved
                cycle count for it previews right here — their exact card. */}
            {dia && stage && !askStage ? (
              <div className="rounded-xl border border-accent/20 bg-accent/5 px-4 py-3">
                <div className="text-[10px] uppercase tracking-wide text-steel mb-1">
                  {dia.name} · Saved cycle count for this stage
                </div>
                <div className="font-semibold text-sm text-primary">{stage.name}</div>
                <div className="text-sm mt-0.5">
                  <span className="text-steel">1 pc every </span>
                  <span className="data font-bold text-accent">{secToMinPerPc(stage.processingSec)} min</span>
                  <span className="text-steel"> → </span>
                  <span className="data font-bold text-accent">{fmtTarget(hourlyRate(stage.processingSec))}/hr</span>
                  <span className="text-steel"> · </span>
                  <span className="data font-bold text-accent">{fmtTarget((shiftMins * 60) / stage.processingSec)}</span>
                  <span className="text-steel">/shift</span>
                </div>
                {dia.stages.filter((st) => st.active).length > 1 && (
                  <button onClick={() => setAskStage(true)} className="text-[11px] text-steel hover:text-accent mt-1.5">
                    Not {stage.name}? Choose a different stage
                  </button>
                )}
              </div>
            ) : dia ? (
              <div>
                <div className="label mb-1.5">
                  {askStage ? 'Stage' : `Which stage of ${dia.name} does this machine run?`}
                </div>
                <select value={stageKey} onChange={(e) => setStageKey(e.target.value)}
                  className="w-full bg-base border border-line rounded-lg px-3 py-2 text-sm outline-none focus:border-accent">
                  <option value="">Select a stage…</option>
                  {dia.stages.filter((s) => s.active).map((s) => (
                    <option key={s.key} value={s.key}>{s.name} — {fmtProcessing(s.processingSec)}/pc · {fmtTarget(hourlyRate(s.processingSec))}/hr</option>
                  ))}
                </select>
                {askStage && stageKey && (
                  <button onClick={() => setAskStage(false)} className="text-[11px] text-steel hover:text-accent mt-1.5">Done</button>
                )}
              </div>
            ) : null}

            {/* Schedule mode: when does this switch happen? */}
            {schedMode && (
              <div className="rounded-xl border border-accent/20 bg-accent/5 px-4 py-3">
                <div className="text-[10px] uppercase tracking-wide text-steel mb-1.5 inline-flex items-center gap-1">
                  <CalendarClock size={11} /> Switches itself at
                </div>
                <input type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)}
                  className="w-full bg-base border border-line rounded-lg px-3 py-2 text-sm outline-none focus:border-accent data" />
                {!whenOk && <p className="text-[11px] text-stopped mt-1">Pick a moment in the future.</p>}
                <p className="text-[11px] text-steel mt-1.5">
                  Nothing changes until then. At that moment the machine switches on its own, and the
                  operator sees a notice on their dashboard until they dismiss it.
                </p>
              </div>
            )}
          </>
        )}

        {/* Already queued for this machine */}
        {pendingSched.length > 0 && (
          <div>
            <div className="text-[10px] uppercase tracking-wide text-steel mb-1.5 inline-flex items-center gap-1">
              <CalendarClock size={11} /> Scheduled
            </div>
            <div className="space-y-1">
              {pendingSched.map((s) => (
                <div key={s._id} className="text-[11px] flex items-baseline gap-1.5 flex-wrap rounded-lg border border-accent/20 bg-accent/5 px-2.5 py-1.5">
                  <span className="data font-semibold text-accent">{s.diaName}</span>
                  <span className="text-steel">· {s.stageName} — from {fmtTime(s.applyAt)}</span>
                  {s.createdBy?.name && <span className="text-steel/70">· by {s.createdBy.name}</span>}
                  <button onClick={() => cancelSchedMut.mutate(s._id)} className="ml-auto font-medium text-steel hover:text-stopped">Cancel</button>
                </div>
              ))}
            </div>
          </div>
        )}
        {/* The machine's record trail — past dias struck through, spans, who */}
        {(trail || []).filter((h) => h.effectiveTo).length > 0 && (
          <div className="pt-1">
            <div className="text-[10px] uppercase tracking-wide text-steel mb-1.5 inline-flex items-center gap-1">
              <HistoryIcon size={11} /> Past dias (records)
            </div>
            <div className="space-y-0.5">
              {(trail || []).filter((h) => h.effectiveTo).slice(0, 4).map((h) => (
                <div key={h._id} className="text-[11px] flex items-baseline gap-1.5 flex-wrap">
                  <span className="data font-medium text-steel line-through">{h.snapshot.diaName}</span>
                  <span className="text-steel">{fmtTime(h.effectiveFrom)} → {fmtTime(h.effectiveTo as string)}</span>
                  {h.assignedBy?.name && <span className="text-steel/70 ml-auto">by {h.assignedBy.name}</span>}
                </div>
              ))}
            </div>
          </div>
        )}

        <div className="flex justify-end gap-2 pt-1">
          <button onClick={onClose} className="px-3.5 py-2 rounded-lg border border-line text-sm text-steel hover:bg-base">Cancel</button>
          <button
            onClick={() => (schedMode ? scheduleMut.mutate() : diaId ? assignMut.mutate() : unassignMut.mutate())}
            disabled={schedMode
              ? !diaId || !stage || !whenOk || scheduleMut.isPending
              : (diaId ? !stage || assignMut.isPending : !current || unassignMut.isPending)}
            className="px-3.5 py-2 rounded-lg bg-accent text-white text-sm font-medium disabled:opacity-50">
            {assignMut.isPending || unassignMut.isPending || scheduleMut.isPending ? 'Saving…'
              : schedMode ? 'Schedule dia' : diaId ? 'Assign dia' : 'Clear dia'}
          </button>
        </div>
      </div>
    </Modal>
  );
}
