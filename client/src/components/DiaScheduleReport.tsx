// client/src/components/DiaScheduleReport.tsx
// Which dia is on which machine — now, and next. READ ONLY.
//
// The two answers live in two collections and, until this, in two places nobody
// looked at together: the running assignment (machine_assignments, frozen at
// assignment time) and the pending switch (scheduled dias, applied by the
// ticker when its moment arrives). A supervisor planning tomorrow had to open
// each machine to see what it is making, then open the schedule modal to see
// what it will make. This is one table: what is running, since when and who set
// it, and what takes over, when, and who scheduled it.
//
// Nothing here writes. Scheduling stays behind the modal, where it belongs.
import { useQuery, keepPreviousData } from '@tanstack/react-query';
import { CalendarClock, Ruler } from 'lucide-react';
import { productionApi } from '../api/endpoints';
import { Spinner } from './ui';
import { fmtTime } from '../lib/format';
import { fmtProcessing } from '../lib/targets';
import { processCompare } from '../lib/machineOrder';
import { useMachineName, useMachineTitle } from '../lib/machineName';
import type { MachineAssignment, ScheduledDia } from '../types/api';

/** A machine's line in the table: what runs now, what is queued next. */
interface Row {
  ref: string;
  now: MachineAssignment | null;
  next: ScheduledDia[];          // pending only, earliest first
}

export default function DiaScheduleReport({ machineId }: { machineId?: string }): JSX.Element {
  const mName = useMachineName();
  const mTitle = useMachineTitle();

  const { data: current, isLoading: curLoading } = useQuery({
    queryKey: ['assignments', 'current'],
    queryFn: () => productionApi.currentAssignments().then((r) => r.data),
    refetchInterval: 60_000,
    placeholderData: keepPreviousData,
    retry: false,
  });
  const { data: sched, isLoading: schLoading } = useQuery({
    queryKey: ['production', 'schedules'],
    queryFn: () => productionApi.schedules().then((r) => r.data),
    refetchInterval: 60_000,
    placeholderData: keepPreviousData,
    retry: false,
  });

  // One row per machine that has EITHER a running dia or a pending one. A
  // machine with neither has nothing to say here and is left out rather than
  // padding the table with blanks.
  const rows: Row[] = (() => {
    const by = new Map<string, Row>();
    const at = (ref: string): Row => {
      const k = String(ref).toUpperCase();
      if (!by.has(k)) by.set(k, { ref, now: null, next: [] });
      return by.get(k) as Row;
    };
    for (const a of current || []) at(a.machineRef).now = a;
    for (const s of sched || []) if (s.status === 'pending') at(s.machineRef).next.push(s);
    const out = [...by.values()];
    out.forEach((r) => r.next.sort((a, b) => +new Date(a.applyAt) - +new Date(b.applyAt)));
    return out
      .filter((r) => !machineId || r.ref.toUpperCase() === machineId.toUpperCase())
      .sort((a, b) => processCompare({ code: a.ref }, { code: b.ref }));
  })();

  if (curLoading || schLoading) return <div className="p-10"><Spinner label="Loading dia assignments" /></div>;

  if (!rows.length) {
    return (
      <div className="panel p-10 text-center text-sm text-steel">
        No dia is running or scheduled{machineId ? ' on this machine' : ''} yet.
        <div className="text-[11px] text-steel/70 mt-1">
          Assign one from a machine's page, or schedule a future switch with <span className="font-medium text-primary">Schedule Dia</span>.
        </div>
      </div>
    );
  }

  const pending = rows.reduce((n, r) => n + r.next.length, 0);

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3 flex-wrap text-xs text-steel">
        <span className="inline-flex items-center gap-1.5">
          <Ruler size={13} className="text-accent" />
          <span className="data font-semibold text-primary">{rows.filter((r) => r.now).length}</span> running now
        </span>
        <span className="inline-flex items-center gap-1.5">
          <CalendarClock size={13} className="text-accent" />
          <span className="data font-semibold text-primary">{pending}</span> scheduled ahead
        </span>
      </div>

      <div className="panel overflow-x-auto">
        <table className="w-full text-sm whitespace-nowrap">
          <thead className="bg-base">
            <tr className="text-steel">
              <th className="text-left label px-4 py-3">Machine</th>
              <th className="text-left label px-4 py-3">Running now</th>
              <th className="text-left label px-4 py-3">Since</th>
              <th className="text-left label px-4 py-3">Set by</th>
              <th className="text-left label px-4 py-3 border-l border-line">Scheduled next</th>
              <th className="text-left label px-4 py-3">Switches at</th>
              <th className="text-left label px-4 py-3">Scheduled by</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.ref} className="border-t border-line align-top hover:bg-base/60">
                <td className="px-4 py-3">
                  <span className="data font-semibold text-primary" title={mTitle(r.ref)}>{mName(r.ref)}</span>
                </td>

                {/* ── what it is making right now ─────────────────────────── */}
                <td className="px-4 py-3">
                  {r.now ? (
                    <>
                      <span className="data font-medium text-primary">{r.now.snapshot.diaName}</span>
                      {r.now.snapshot.dims && <span className="text-steel"> · {r.now.snapshot.dims}</span>}
                      <div className="text-[11px] text-steel">
                        {r.now.snapshot.stageName} · {fmtProcessing(r.now.snapshot.processingSec)}/unit
                      </div>
                    </>
                  ) : <span className="text-steel/50">—</span>}
                </td>
                <td className="px-4 py-3 data text-xs text-steel">
                  {r.now ? fmtTime(r.now.effectiveFrom) : '—'}
                </td>
                <td className="px-4 py-3 text-xs text-steel">
                  {r.now?.assignedBy?.name || <span className="text-steel/50">—</span>}
                </td>

                {/* ── and what takes over. Every pending one, earliest first:
                       a machine can have more than one queued, and hiding the
                       rest is how a switch nobody expected happens. ───────── */}
                <td className="px-4 py-3 border-l border-line">
                  {r.next.length ? r.next.map((s) => (
                    <div key={s._id} className="mt-2 first:mt-0">
                      <span className="data font-medium text-primary">{s.diaName}</span>
                      <div className="text-[11px] text-steel">{s.stageName}</div>
                    </div>
                  )) : <span className="text-steel/50">—</span>}
                </td>
                <td className="px-4 py-3">
                  {r.next.length ? r.next.map((s) => (
                    <div key={s._id} className="mt-2 first:mt-0 data text-xs text-accent font-medium">
                      {fmtTime(s.applyAt)}
                    </div>
                  )) : <span className="text-steel/50 text-xs">—</span>}
                </td>
                <td className="px-4 py-3">
                  {r.next.length ? r.next.map((s) => (
                    <div key={s._id} className="mt-2 first:mt-0 text-xs text-steel">
                      {s.createdBy?.name || '—'}
                    </div>
                  )) : <span className="text-steel/50 text-xs">—</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="text-[11px] text-steel px-1">
        A scheduled dia switches itself at its moment and the machine's operator is shown a notice
        until they dismiss it. Times are the plant clock.
      </p>
    </div>
  );
}
