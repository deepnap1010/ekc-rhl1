// client/src/components/machine/TargetPanel.tsx
// The operator's answer at a glance: WHAT am I making, what STAGE, what's the
// TARGET, how much is PRODUCED, how much is ACHIEVED. Target = the day's
// assigned seconds ÷ the assignment's frozen processing time; produced = the
// same verified counter steps every other surface shows. Over 100% keeps
// filling — beating the target is the good case, not an error.
import { useState, useEffect } from 'react';
import { Target, UserRound } from 'lucide-react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { productionApi, userApi } from '../../api/endpoints';
import { useCurrentAssignment } from './AssignDia';
import Modal from '../Modal';
import { useAuthStore } from '../../store/auth';
import { toast } from '../../store/toast';
import { useMachineName } from '../../lib/machineName';
import { useAppConfig } from '../../hooks/useAppConfig';
import { fmtNum } from '../../lib/format';
import { windowNetMs, targetUnits, achievementPct, fmtTarget, fmtProcessing, hourlyRate } from '../../lib/targets';
import type { MachineActivityRow, OperatorSession } from '../../types/api';

export default function TargetPanel({ code, actRow, dayFrom, dayTo, label = 'Today' }: {
  code: string;
  actRow?: MachineActivityRow | null;   // the SELECTED window's activity row
  dayFrom: string;                      // the window that row covers
  dayTo: string;
  label?: string;                       // what that window is called — "Yesterday · Shift A"
}): JSX.Element | null {
  const current = useCurrentAssignment(code);
  const { breaks } = useAppConfig();   // planned pauses — targets exclude them

  // Bar-by-bar actual vs target — the operator's pacing view, the same report
  // the Targets tab reads. HOURS for a day or a shift; DAYS once the window is
  // longer, because 48 hourly bars cannot hold a month and would quietly show
  // its first two days as if they were the whole thing.
  const spanMs = new Date(dayTo).getTime() - new Date(dayFrom).getTime();
  const byDay = spanMs > 36 * 3_600_000;
  const groupBy = byDay ? 'day' : 'hour';
  const limit = byDay ? 400 : 48;
  // A window that has already CLOSED is history: it had a target even if the
  // machine carries no assignment today, so the report is fetched either way.
  const past = new Date(dayTo).getTime() <= Date.now();
  const { data: hourData, error } = useQuery({
    queryKey: ['targets-report', code, dayFrom, dayTo, groupBy, limit, 1],
    queryFn: () => productionApi.targets({ from: dayFrom, to: dayTo, machineId: code, groupBy, limit }),
    enabled: !!current || past,
    refetchInterval: 60_000,
    retry: false,
  });
  // Two assignments in one hour → one bar: sum both halves.
  const hours = (() => {
    const by = new Map<string, { t: number; actual: number; target: number }>();
    for (const r of hourData?.data || []) {
      const acc = by.get(r.bucket) || { t: new Date(r.bucket).getTime(), actual: 0, target: 0 };
      acc.actual += r.actual; acc.target += r.target;
      by.set(r.bucket, acc);
    }
    return [...by.values()].sort((a, b) => a.t - b.t);
  })();

  // A CLOSED window belongs to the assignment that was actually in force then —
  // which is exactly what the report returns, cut at every reassignment. Pricing
  // last Tuesday at today's DIA rate put a headline on this card that disagreed
  // with the bars printed directly underneath it. Only a window still RUNNING is
  // held to the rate on the machine now, and lib/targets explains why that one
  // is deliberate. Taking the dia/stage off the report too means the card still
  // opens for a machine that has since been unassigned.
  const rows = hourData?.data || [];
  const snap = current?.snapshot ?? (rows.length
    ? { diaName: rows[0].dia, dims: rows[0].dims, stageName: rows[0].stage, processingSec: rows[0].processingSec }
    : null);
  if (!snap) return null;               // nothing was assigned then, and nothing is now

  const winFrom = new Date(dayFrom).getTime();
  const winTo = Math.min(new Date(dayTo).getTime(), Date.now());
  // A RUNNING window at this DIA's rate — the quota is the window's, no matter
  // what time the assignment row was created (otherwise a machine assigned at
  // 17:50 reads "56 of 2 · 2783%": a day of pieces against ten minutes of
  // target). A closed window instead sums the report's own assignment-exact
  // rows, so this figure and the bars below it are the same arithmetic.
  const ms = windowNetMs(winFrom, winTo, breaks);
  const sec = snap.processingSec;
  const historical = past && rows.length > 0;
  const target = historical ? rows.reduce((n, r) => n + r.target, 0) : targetUnits(sec, ms);
  const produced = actRow?.production ?? null;
  const pct = produced == null ? null
    : historical ? (target > 0 ? Math.round((produced / target) * 1000) / 10 : null)
    : achievementPct(produced, sec, ms);
  const borrowed = actRow?.productionFrom || null;
  const remaining = produced != null ? Math.max(0, target - produced) : null;

  // Ring geometry — fills with achievement, capped visually at 100.
  const R = 34, C = 2 * Math.PI * R;
  const fill = pct == null ? 0 : Math.min(pct, 100) / 100;
  const over = pct != null && pct > 100;

  return (
    <div className="panel p-5">
      <div className="flex items-center gap-2 mb-4">
        <Target size={15} className="text-accent" />
        <h3 className="font-semibold text-sm text-primary flex-1">Target · {label}</h3>
        <span className="text-[11px] text-steel">
          {snap.diaName}{snap.dims ? ` · ${snap.dims}` : ''} — {snap.stageName} · {fmtProcessing(sec)}/unit → {fmtTarget(hourlyRate(sec))}/hr
        </span>
        <OperatorBadge code={code} />
      </div>

      <div className="flex items-center gap-6 flex-wrap">
        <div className="relative shrink-0" aria-label={pct != null ? `Achievement ${pct}%` : 'No achievement yet'}>
          <svg width="88" height="88" viewBox="0 0 88 88">
            <circle cx="44" cy="44" r={R} fill="none" stroke="rgb(var(--c-line))" strokeWidth="8" />
            <circle cx="44" cy="44" r={R} fill="none"
              stroke={over ? '#0D9488' : pct != null && pct < 60 ? '#D97706' : '#0D9488'}
              strokeWidth="8" strokeLinecap="round"
              strokeDasharray={`${C * fill} ${C}`} transform="rotate(-90 44 44)" />
          </svg>
          <div className="absolute inset-0 flex flex-col items-center justify-center">
            <span className="data text-lg font-bold text-primary leading-none">{pct != null ? `${Math.round(pct)}%` : '—'}</span>
          </div>
        </div>

        <div className="flex-1 min-w-[220px]">
          <div className="flex items-baseline gap-2">
            <span className="data text-3xl font-bold text-primary">{produced != null ? fmtNum(produced) : '—'}</span>
            <span className="text-steel text-sm">of</span>
            <span className="data text-3xl font-bold text-accent">{fmtTarget(target)}</span>
            <span className="text-steel text-sm">pcs</span>
          </div>
          <div className="text-xs text-steel mt-1.5 space-x-3">
            {remaining != null && <span>{remaining <= 0 ? 'Target met' : `${fmtTarget(remaining)} to go`}</span>}
            {pct != null && over && <span className="text-accent font-semibold">{pct}% — ahead of target</span>}
            {borrowed && <span>counted at {borrowed} · 2 min behind</span>}
          </div>
          {/* thin progress bar mirrors the ring for a straight-line read */}
          <div className="h-1.5 bg-line rounded-full overflow-hidden mt-3">
            <div className="h-full rounded-full" style={{
              width: `${Math.min(pct ?? 0, 100)}%`,
              background: over ? '#0D9488' : (pct ?? 0) < 60 ? '#D97706' : '#0D9488',
            }} />
          </div>
        </div>
      </div>

      {/* Hour by hour — amber = that hour missed its target, teal = made it.
          The dotted line is the full-hour target. */}
      {/* The report refuses a span over 92 days. Printing its own words beats
          rendering nothing, which read as "this machine made nothing". */}
      {!!error && (
        <div className="mt-5 pt-4 border-t border-line text-[11px] text-steel">{(error as Error).message}</div>
      )}
      {hours.length >= 2 && (() => {
        const max = Math.max(...hours.map((h) => Math.max(h.actual, h.target)), 1);
        return (
          <div className="mt-5 pt-4 border-t border-line">
            <div className="text-[10px] uppercase tracking-wide text-steel mb-2">{byDay ? 'Daily production' : 'Hourly production'}</div>
            <div className="flex items-end gap-1.5 h-24 overflow-x-auto pb-1">
              {hours.map((h) => {
                const made = h.actual >= h.target * 0.999;
                return (
                  <div key={h.t} className="flex flex-col items-center gap-1 min-w-[34px] flex-1 h-full"
                    title={`${byDay
                      ? new Date(h.t).toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' })
                      : new Date(h.t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} — ${h.actual} of ${fmtTarget(h.target)}`}>
                    <span className="data text-[10px] leading-none" style={{ color: made ? '#0D9488' : '#D97706' }}>{h.actual}</span>
                    <div className="w-full flex-1 relative">
                      <div className="absolute bottom-0 left-0 right-0 rounded-t" style={{
                        height: `${Math.max((h.actual / max) * 100, 2)}%`,
                        background: made ? '#0D9488' : '#D97706', opacity: 0.85,
                      }} />
                      {h.target > 0 && (
                        // the hour's target, on the same scale — the bar chases this line
                        <div className="absolute left-0 right-0 border-t border-dashed border-steel/70"
                          style={{ bottom: `${Math.min((h.target / max) * 100, 100)}%` }} />
                      )}
                    </div>
                    <span className="text-[11px] font-semibold text-steel leading-none whitespace-nowrap">
                      {byDay
                        ? new Date(h.t).toLocaleDateString([], { day: 'numeric', month: 'short' })
                        : new Date(h.t).toLocaleTimeString([], { hour: 'numeric' }).replace(' ', '').toLowerCase()}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        );
      })()}
    </div>
  );
}

// ── Who is on the machine ────────────────────────────────────────────────────
// The handover flow: starting a session closes the previous one, and the
// targets report splits its rows at that instant — each person answers for the
// pieces counted on their watch. Holders of production.update change it;
// everyone else just sees the name.
function OperatorBadge({ code }: { code: string }): JSX.Element | null {
  const can = useAuthStore((s) => s.can);
  const mName = useMachineName();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [userId, setUserId] = useState('');
  // Opening the modal lands on the person it almost certainly is: the running
  // session's operator, else the machine's assigned employee.
  useEffect(() => {
    if (open && !userId) setUserId(mine?.userId || assignedUser?.id || '');
  }, [open]);   // eslint-disable-line react-hooks/exhaustive-deps
  const editable = can('production', 'update');

  const { data: sessions } = useQuery({
    queryKey: ['operators', 'current'],
    queryFn: () => productionApi.currentOperators().then((r) => r.data),
    staleTime: 30_000,
    refetchInterval: 60_000,
    retry: false,
  });
  const mine: OperatorSession | undefined =
    (sessions || []).find((s) => s.machineRef.toUpperCase() === code.toUpperCase());

  // Employees serve two things: the picker inside the modal, and the badge's
  // PREFILL — a machine assigned to an employee (assignedMachines) shows that
  // person even before any session is started.
  const canSeeUsers = can('employees') || editable;
  const { data: users } = useQuery({
    queryKey: ['users', 'operator-pick'],
    queryFn: () => userApi.list({ limit: 200 }).then((r) => r.data),
    enabled: open || canSeeUsers,
    staleTime: 60_000,
    retry: false,
  });
  // The employee this machine BELONGS to — the operator whose account lists it.
  const assignedUser = (users || []).find((u) =>
    (u.assignedMachines || []).some((m) => String(m).toUpperCase() === code.toUpperCase()));

  const done = () => { qc.invalidateQueries({ queryKey: ['operators'] }); qc.invalidateQueries({ queryKey: ['targets-report'] }); setOpen(false); };
  const setMut = useMutation({
    mutationFn: () => productionApi.setOperator({ machineRef: code, userId }),
    onSuccess: (r) => { toast.success(`${r.data.userName} is on ${mName(code)}`); done(); },
    onError: (e: unknown) => toast.error(e instanceof Error ? e.message : 'Could not set operator'),
  });
  const endMut = useMutation({
    mutationFn: () => productionApi.endOperator(code),
    onSuccess: () => { toast.success('Session ended'); done(); },
    onError: (e: unknown) => toast.error(e instanceof Error ? e.message : 'Could not end session'),
  });

  if (!mine && !assignedUser && !editable) return null;
  // A running session wins; otherwise the assigned employee prefills the badge.
  const shown = mine?.userName || assignedUser?.name || 'No operator';
  const filled = !!mine || !!assignedUser;
  return (
    <>
      <button
        onClick={editable ? () => setOpen(true) : undefined} disabled={!editable}
        title={editable
          ? 'Hand the machine over'
          : !mine && assignedUser ? `${assignedUser.name} — assigned employee` : undefined}
        className={`inline-flex items-center gap-1 text-[11px] px-2 py-0.5 rounded-full border ${
          filled ? 'border-accent/30 bg-accent/10 text-accent' : 'border-line bg-base text-steel'
        } ${editable ? 'hover:border-accent cursor-pointer' : 'cursor-default'}`}
      >
        <UserRound size={11} /> {shown}
      </button>
      {open && (
        <Modal title={`Operator — ${mName(code)}`} subtitle="Report rows split at every handover" icon={UserRound} onClose={() => setOpen(false)} maxW="max-w-sm">
          <div className="space-y-4">
            <div>
              <div className="label mb-1.5">Employee</div>
              <select value={userId} onChange={(e) => setUserId(e.target.value)}
                className="w-full bg-base border border-line rounded-lg px-3 py-2 text-sm outline-none focus:border-accent">
                <option value="">Select…</option>
                {(users || []).map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
              </select>
            </div>
            <div className="flex items-center justify-between gap-2">
              {mine ? (
                <button onClick={() => endMut.mutate()} disabled={endMut.isPending}
                  className="text-xs text-stopped hover:underline disabled:opacity-50">End {mine.userName}'s session</button>
              ) : <span />}
              <span className="flex gap-2">
                <button onClick={() => setOpen(false)} className="px-3.5 py-2 rounded-lg border border-line text-sm text-steel hover:bg-base">Cancel</button>
                <button onClick={() => setMut.mutate()} disabled={!userId || setMut.isPending}
                  className="px-3.5 py-2 rounded-lg bg-accent text-white text-sm font-medium disabled:opacity-50">
                  {setMut.isPending ? 'Starting…' : mine ? 'Hand over' : 'Start session'}
                </button>
              </span>
            </div>
          </div>
        </Modal>
      )}
    </>
  );
}
