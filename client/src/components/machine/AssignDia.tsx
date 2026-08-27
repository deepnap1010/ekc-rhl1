// client/src/components/machine/AssignDia.tsx
// The machine-side DIA controls: a header chip showing what the machine is
// running ("40L · Cutting"), which — for anyone holding production.update —
// opens the assignment modal right there on the floor. Both this and the
// Configure tab write through the same endpoint: close the open assignment,
// freeze a new snapshot, write an audit row.
import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Target, Check } from 'lucide-react';
import { productionApi } from '../../api/endpoints';
import Modal from '../Modal';
import { useAuthStore } from '../../store/auth';
import { toast } from '../../store/toast';
import { fmtTarget, fmtProcessing, hourlyRate } from '../../lib/targets';
import { stageForMachine } from '../../lib/diaStage';
import { useAppConfig } from '../../hooks/useAppConfig';
import { fmtTime } from '../../lib/format';
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
  const [diaId, setDiaId] = useState(current?.diaId || '');
  const [stageKey, setStageKey] = useState(current?.stageKey || '');
  const dia = options.find((d) => d._id === diaId);
  const stage = dia?.stages.find((s) => s.key === stageKey && s.active);

  // Picking a dia AUTO-FILLS the stage from the machine's family (a cutting
  // machine gets Cutting) — the select stays there to override the guess.
  const pickDia = (id: string) => {
    setDiaId(id);
    const d = options.find((x) => x._id === id);
    setStageKey(stageForMachine(code, d)?.key || '');
  };

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

  return (
    <Modal title={`Assign DIA — ${code}`} subtitle="The machine's target follows the stage's processing time" icon={Target} onClose={onClose} maxW="max-w-md">
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
              <div className="label mb-1.5">DIA / Product</div>
              <select value={diaId} onChange={(e) => pickDia(e.target.value)}
                className="w-full bg-base border border-line rounded-lg px-3 py-2 text-sm outline-none focus:border-accent">
                <option value="">Select a DIA…</option>
                {options.map((d) => (
                  <option key={d._id} value={d._id}>{d.name}{d.dims ? ` · ${d.dims}` : ''}</option>
                ))}
              </select>
            </div>
            <div>
              <div className="label mb-1.5">Stage</div>
              <select value={stageKey} onChange={(e) => setStageKey(e.target.value)} disabled={!dia}
                className="w-full bg-base border border-line rounded-lg px-3 py-2 text-sm outline-none focus:border-accent disabled:opacity-50">
                <option value="">Select a stage…</option>
                {(dia?.stages || []).filter((s) => s.active).map((s) => (
                  <option key={s.key} value={s.key}>{s.name} — {fmtProcessing(s.processingSec)}/unit</option>
                ))}
              </select>
            </div>
            {stage && (
              <div className="rounded-lg border border-accent/20 bg-accent/5 px-4 py-3 text-sm">
                <span className="text-steel">Target: </span>
                <span className="data font-bold text-accent">{fmtTarget(hourlyRate(stage.processingSec))}/hour</span>
                <span className="text-steel"> · {fmtTarget((shiftMins * 60) / stage.processingSec)} per {Math.round(shiftMins / 60)}h shift · {fmtProcessing(stage.processingSec)}/pc</span>
              </div>
            )}
          </>
        )}
        <div className="flex items-center justify-between gap-2 pt-1">
          {current ? (
            <button onClick={() => unassignMut.mutate()} disabled={unassignMut.isPending}
              className="text-xs text-stopped hover:underline disabled:opacity-50">Remove assignment</button>
          ) : <span />}
          <span className="flex gap-2">
            <button onClick={onClose} className="px-3.5 py-2 rounded-lg border border-line text-sm text-steel hover:bg-base">Cancel</button>
            <button onClick={() => assignMut.mutate()} disabled={!stage || assignMut.isPending}
              className="px-3.5 py-2 rounded-lg bg-accent text-white text-sm font-medium disabled:opacity-50">
              {assignMut.isPending ? 'Assigning…' : 'Assign'}
            </button>
          </span>
        </div>
      </div>
    </Modal>
  );
}
