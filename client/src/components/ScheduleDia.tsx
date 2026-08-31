// client/src/components/ScheduleDia.tsx
// Dia scheduling, both ends of it:
//   · ScheduleDiaModal — supervisor side: pick machine + dia + moment, and see
//     every upcoming/recent schedule with cancel. Opened from the Production
//     Targets header.
//   · ScheduledDiaPopup — operator side: a notice that STAYS on the dashboard
//     until each instruction is dismissed ("Got it" / X), per person.
// The switch itself happens on the server at the scheduled minute; these are
// just the two windows onto that row.
import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { CalendarClock, Ruler, Check, AlertTriangle, X as XIcon } from 'lucide-react';
import Modal from './Modal';
import { productionApi, machineApi } from '../api/endpoints';
import { useAuthStore } from '../store/auth';
import { useAppConfig } from '../hooks/useAppConfig';
import { toast } from '../store/toast';
import { stageForMachine } from '../lib/diaStage';
import { fmtTarget, hourlyRate, secToMinPerPc } from '../lib/targets';
import { fmtTime } from '../lib/format';
import { useMachineName, useMachineTitle } from '../lib/machineName';
import type { ScheduledDia } from '../types/api';

/** Tomorrow at the first shift's start, as a datetime-local value. */
export function defaultApplyAt(shiftStart?: string): string {
  const [h, m] = (shiftStart || '07:00').split(':').map(Number);
  const d = new Date();
  d.setDate(d.getDate() + 1);
  d.setHours(h || 7, m || 0, 0, 0);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

const STATUS_PILL: Record<ScheduledDia['status'], string> = {
  pending: 'bg-accent/10 text-accent',
  applied: 'bg-running/10 text-running',
  failed: 'bg-stopped/10 text-stopped',
  cancelled: 'bg-base text-steel',
};
const STATUS_LABEL: Record<ScheduledDia['status'], string> = {
  pending: 'scheduled', applied: 'applied', failed: 'failed', cancelled: 'cancelled',
};

/** Supervisor console: schedule a dia onto any machine, manage the queue. */
export function ScheduleDiaModal({ onClose }: { onClose: () => void }): JSX.Element {
  const qc = useQueryClient();
  const mName = useMachineName();
  const mTitle = useMachineTitle();
  const { shifts } = useAppConfig();
  const { data: machines } = useQuery({
    queryKey: ['machines', 'list'],
    queryFn: () => machineApi.list({ limit: 200 }).then((r) => r.data),
    staleTime: 60_000,
  });
  const { data: dias } = useQuery({
    queryKey: ['dia-configs'],
    queryFn: () => productionApi.dia().then((r) => r.data),
  });
  const { data: sched, refetch } = useQuery({
    queryKey: ['schedules'],
    queryFn: () => productionApi.schedules().then((r) => r.data),
    refetchInterval: 60_000,
  });
  const options = (dias || []).filter((d) => d.active);
  const codes = (machines || []).map((m) => String(m.code).toUpperCase()).sort();

  const [machine, setMachine] = useState('');
  const [diaId, setDiaId] = useState('');
  const [stageKey, setStageKey] = useState('');
  const [when, setWhen] = useState(() => defaultApplyAt(shifts[0]?.start));
  const dia = options.find((d) => d._id === diaId);
  const stage = dia?.stages.find((s) => s.key === stageKey && s.active);

  // Same auto-pick rule as assigning right now: the machine's family names the
  // stage, a single-stage dia decides itself, otherwise we ask.
  const matchStage = (code: string, id: string): void => {
    const d = options.find((x) => x._id === id);
    const active = (d?.stages || []).filter((st) => st.active);
    const hit = (code && stageForMachine(code, d)) || (active.length === 1 ? active[0] : null);
    setStageKey(hit?.key || '');
  };

  const whenAt = when ? new Date(when) : null;
  const whenOk = !!whenAt && !Number.isNaN(whenAt.getTime()) && whenAt.getTime() > Date.now() - 60_000;

  const createMut = useMutation({
    mutationFn: () => productionApi.schedule({
      machineRef: machine, diaId, stageKey, applyAt: new Date(when).toISOString(),
    }),
    onSuccess: () => {
      toast.success(`Scheduled: ${mName(machine)} → ${dia?.name} from ${fmtTime(new Date(when).toISOString())}`);
      qc.invalidateQueries({ queryKey: ['schedules'] });
      setMachine(''); setDiaId(''); setStageKey('');
      void refetch();
    },
    onError: (e: unknown) => toast.error(e instanceof Error ? e.message : 'Could not schedule'),
  });
  const cancelMut = useMutation({
    mutationFn: (id: string) => productionApi.cancelSchedule(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['schedules'] }),
    onError: (e: unknown) => toast.error(e instanceof Error ? e.message : 'Could not cancel'),
  });

  const pending = (sched || []).filter((s) => s.status === 'pending');
  const recent = (sched || []).filter((s) => s.status !== 'pending');

  return (
    <Modal title="Schedule dia" subtitle="Set now — the machine switches itself at that moment, and its operator sees a notice until they dismiss it" icon={CalendarClock} onClose={onClose} maxW="max-w-lg">
      <div className="space-y-4">
        <div className="grid sm:grid-cols-2 gap-3">
          <div>
            <div className="label mb-1.5">Machine</div>
            <select value={machine}
              onChange={(e) => { setMachine(e.target.value); if (diaId) matchStage(e.target.value, diaId); }}
              className="w-full bg-base border border-line rounded-lg px-3 py-2 text-sm outline-none focus:border-accent">
              <option value="">Select a machine…</option>
              {codes.map((c) => <option key={c} value={c}>{mName(c)}</option>)}
            </select>
          </div>
          <div>
            <div className="label mb-1.5">Dia to run</div>
            <select value={diaId}
              onChange={(e) => { setDiaId(e.target.value); matchStage(machine, e.target.value); }}
              className="w-full bg-base border border-line rounded-lg px-3 py-2 text-sm outline-none focus:border-accent">
              <option value="">Select a dia…</option>
              {options.map((d) => <option key={d._id} value={d._id}>{d.name}{d.dims ? ` · ${d.dims}` : ''}</option>)}
            </select>
          </div>
        </div>

        {dia && !stage && (
          <div>
            <div className="label mb-1.5">Which stage of {dia.name} does this machine run?</div>
            <select value={stageKey} onChange={(e) => setStageKey(e.target.value)}
              className="w-full bg-base border border-line rounded-lg px-3 py-2 text-sm outline-none focus:border-accent">
              <option value="">Select a stage…</option>
              {dia.stages.filter((s) => s.active).map((s) => (
                <option key={s.key} value={s.key}>{s.name} — {secToMinPerPc(s.processingSec)} min/pc</option>
              ))}
            </select>
          </div>
        )}

        <div>
          <div className="label mb-1.5">Switches at</div>
          <input type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)}
            className="w-full bg-base border border-line rounded-lg px-3 py-2 text-sm outline-none focus:border-accent data" />
          {!whenOk && <p className="text-[11px] text-stopped mt-1">Pick a moment in the future.</p>}
        </div>

        {dia && stage && machine && (
          <div className="rounded-xl border border-accent/20 bg-accent/5 px-4 py-2.5 text-sm">
            <span className="data font-bold text-primary" title={mTitle(machine)}>{mName(machine)}</span>
            <span className="text-steel"> switches to </span>
            <span className="data font-bold text-accent">{dia.name}</span>
            <span className="text-steel"> · {stage.name} ({secToMinPerPc(stage.processingSec)} min/pc → {fmtTarget(hourlyRate(stage.processingSec))}/hr) at </span>
            <span className="data font-semibold text-primary">{whenOk ? fmtTime(new Date(when).toISOString()) : '—'}</span>
          </div>
        )}

        <div className="flex justify-end gap-2">
          <button onClick={onClose} className="px-3.5 py-2 rounded-lg border border-line text-sm text-steel hover:bg-base">Close</button>
          <button onClick={() => createMut.mutate()}
            disabled={!machine || !dia || !stage || !whenOk || createMut.isPending}
            className="px-3.5 py-2 rounded-lg bg-accent text-white text-sm font-medium disabled:opacity-50">
            {createMut.isPending ? 'Saving…' : 'Schedule dia'}
          </button>
        </div>

        {/* The queue — what's set to happen, then what just did */}
        {(pending.length > 0 || recent.length > 0) && (
          <div className="border-t border-line pt-3 space-y-3">
            {pending.length > 0 && (
              <div>
                <div className="text-[10px] uppercase tracking-wide text-steel mb-1.5">Upcoming</div>
                <div className="space-y-1">
                  {pending.map((s) => <ScheduleRow key={s._id} s={s} onCancel={() => cancelMut.mutate(s._id)} />)}
                </div>
              </div>
            )}
            {recent.length > 0 && (
              <div>
                <div className="text-[10px] uppercase tracking-wide text-steel mb-1.5">Recent</div>
                <div className="space-y-1">
                  {recent.map((s) => <ScheduleRow key={s._id} s={s} />)}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </Modal>
  );
}

function ScheduleRow({ s, onCancel }: { s: ScheduledDia; onCancel?: () => void }): JSX.Element {
  const mName = useMachineName();
  const mTitle = useMachineTitle();
  return (
    <div className="text-[11px] flex items-baseline gap-1.5 flex-wrap rounded-lg border border-line bg-base px-2.5 py-1.5">
      <span className="data font-bold text-primary" title={mTitle(s.machineRef)}>{mName(s.machineRef)}</span>
      <span className="text-steel">→</span>
      <span className="data font-semibold text-accent">{s.diaName}</span>
      <span className="text-steel">· {s.stageName} · {fmtTime(s.applyAt)}</span>
      {s.createdBy?.name && <span className="text-steel/70">· by {s.createdBy.name}</span>}
      <span className={`pill !text-[10px] font-semibold ml-auto ${STATUS_PILL[s.status]}`}>{STATUS_LABEL[s.status]}</span>
      {s.status === 'failed' && s.reason && <span className="text-stopped w-full">{s.reason}</span>}
      {s.status === 'applied' && s.reason && <span className="text-steel/70 w-full">{s.reason}</span>}
      {onCancel && (
        <button onClick={onCancel} title="Cancel this schedule" className="text-steel hover:text-stopped shrink-0"><XIcon size={12} /></button>
      )}
    </div>
  );
}

/** Operator notice: every un-dismissed instruction for THEIR machines. It comes
 *  back on every dashboard visit until each row is acknowledged. */
export function ScheduledDiaPopup(): JSX.Element | null {
  const user = useAuthStore((s) => s.user);
  const can = useAuthStore((s) => s.can);
  const qc = useQueryClient();
  const isOperator = (user?.assignedMachines?.length ?? 0) > 0;
  const { data } = useQuery({
    queryKey: ['schedules', 'unacked'],
    queryFn: () => productionApi.schedules({ unacked: '1' }).then((r) => r.data),
    enabled: isOperator && can('production', 'view'),
    refetchInterval: 60_000,
  });
  // Dismissed here and now: the row leaves the screen on click, not a
  // round-trip later, and comes back if the server refuses.
  const [dismissed, setDismissed] = useState<string[]>([]);
  const ackMut = useMutation({
    mutationFn: (id: string) => productionApi.ackSchedule(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['schedules'] }),
    onError: (e: unknown, id) => {
      setDismissed((d) => d.filter((x) => x !== id));
      toast.error(e instanceof Error ? e.message : 'Could not dismiss — try again');
    },
  });
  const ack = (id: string): void => { setDismissed((d) => [...d, id]); ackMut.mutate(id); };
  const rows = (data || []).filter((r) => !dismissed.includes(r._id));
  if (!isOperator || !rows.length) return null;

  const ackAll = (): void => rows.forEach((r) => ack(r._id));

  return (
    <Modal title="Dia instructions" subtitle="Set by your supervisor — dismiss each once you've read it" icon={CalendarClock} onClose={ackAll} maxW="max-w-md">
      <div className="space-y-2.5">
        {rows.map((s) => {
          const applied = s.status === 'applied';
          const failed = s.status === 'failed';
          return (
            <div key={s._id} className={`rounded-xl border px-4 py-3 flex items-start gap-3 ${
              failed ? 'border-stopped/30 bg-stopped/5' : 'border-accent/30 bg-accent/5'}`}>
              <span className={`w-9 h-9 rounded-lg flex items-center justify-center shrink-0 ${
                failed ? 'bg-stopped/10 text-stopped' : 'bg-accent/10 text-accent'}`}>
                {failed ? <AlertTriangle size={16} /> : <Ruler size={16} />}
              </span>
              <div className="min-w-0">
                <div className="text-sm font-semibold text-primary leading-snug">
                  {failed
                    ? <>{s.machineRef} did NOT switch to <span className="data text-stopped">{s.diaName}</span></>
                    : applied
                      ? <>{s.machineRef} is now making <span className="data text-accent">{s.diaName}</span></>
                      : <>Run <span className="data text-accent">{s.diaName}</span> on {s.machineRef}</>}
                </div>
                <div className="text-[11px] text-steel mt-0.5">
                  {failed
                    ? `${s.reason || 'the switch could not be applied'} — keep running the current dia and ask your supervisor`
                    : <>
                        {s.stageName}
                        {applied
                          ? ` · since ${fmtTime(s.appliedAt || s.applyAt)}`
                          : ` · from ${fmtTime(s.applyAt)} — the machine switches itself`}
                        {s.createdBy?.name ? ` · set by ${s.createdBy.name}` : ''}
                      </>}
                </div>
              </div>
              <button onClick={() => ack(s._id)}
                className={`ml-auto shrink-0 inline-flex items-center gap-1 text-xs font-medium border rounded-lg px-2.5 py-1.5 ${
                  failed ? 'text-stopped border-stopped/30 hover:bg-stopped/10' : 'text-accent border-accent/30 hover:bg-accent/10'}`}>
                <Check size={13} /> Got it
              </button>
            </div>
          );
        })}
        <button onClick={ackAll} className="w-full text-center text-[11px] text-steel hover:text-accent pt-1">
          Dismiss all
        </button>
      </div>
    </Modal>
  );
}
