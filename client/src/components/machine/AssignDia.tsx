// client/src/components/machine/AssignDia.tsx
// The machine-side DIA controls: a header chip showing what the machine is
// running ("40L · Cutting"), which — for anyone holding production.update —
// opens the assignment modal right there on the floor. Both this and the
// Configure tab write through the same endpoint: close the open assignment,
// freeze a new snapshot, write an audit row.
import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Target } from 'lucide-react';
import { productionApi } from '../../api/endpoints';
import Modal from '../Modal';
import { useAuthStore } from '../../store/auth';
import { toast } from '../../store/toast';
import { fmtTarget, fmtProcessing, hourlyRate } from '../../lib/targets';
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
  const [diaId, setDiaId] = useState(current?.diaId || '');
  const [stageKey, setStageKey] = useState(current?.stageKey || '');
  const dia = options.find((d) => d._id === diaId);
  const stage = dia?.stages.find((s) => s.key === stageKey && s.active);

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
        {!options.length ? (
          <p className="text-sm text-steel">No active DIA configured yet — create one under <span className="font-medium text-primary">Production Targets</span> first.</p>
        ) : (
          <>
            <div>
              <div className="label mb-1.5">DIA / Product</div>
              <select value={diaId} onChange={(e) => { setDiaId(e.target.value); setStageKey(''); }}
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
                <span className="text-steel"> · {fmtTarget(hourlyRate(stage.processingSec) * 8)} per 8h shift</span>
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
