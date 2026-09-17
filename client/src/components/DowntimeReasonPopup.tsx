// client/src/components/DowntimeReasonPopup.tsx
// Operator side of downtime reasons: a machine of THEIRS that has been idle
// or stopped for longer than the admin's ask-after mark asks why, one span
// at a time, oldest first. Sibling of ProductionClassPopup — same queue /
// answer / local-skip contract:
//   · the span is already recorded; the answer only adds words to it;
//   · with a countdown, running out marks "asked, no answer" and the span
//     leaves the queue (the Downtime page can still add the reason later);
//   · without one (the admin's default) the popup waits — the operator is
//     usually AT the stopped machine, not at the screen, and the ask must
//     still be there when they come back;
//   · Esc / backdrop is a local skip: the ask returns after a reload or on
//     another device. Only a real answer or a real timeout is written.
import { useEffect, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { PauseCircle } from 'lucide-react';
import Modal from './Modal';
import { productionApi } from '../api/endpoints';
import { useAuthStore } from '../store/auth';
import { useAppConfig } from '../hooks/useAppConfig';
import { toast } from '../store/toast';
import { fmtDuration, fmtTime } from '../lib/format';
import { useMachineName } from '../lib/machineName';

const TYPE_COLOR: Record<string, string> = { idle: '#D97706', stopped: '#DC2626' };

export function DowntimeReasonPopup(): JSX.Element | null {
  const user = useAuthStore((s) => s.user);
  const can = useAuthStore((s) => s.can);
  const { downtimeAsk } = useAppConfig();
  const mName = useMachineName();
  const qc = useQueryClient();
  const isOperator = (user?.assignedMachines?.length ?? 0) > 0;
  const active = !!downtimeAsk?.enabled && isOperator && can('production', 'view');

  const { data } = useQuery({
    queryKey: ['downtime-ask', 'queue'],
    queryFn: () => productionApi.downtimeQueue().then((r) => r.data),
    enabled: active,
    refetchInterval: 30_000,
  });

  const [handled, setHandled] = useState<string[]>([]);
  const rows = (data || []).filter((r) => !handled.includes(r._id));
  const current = rows[0];
  const currentId = current?._id;
  const [custom, setCustom] = useState('');

  const mut = useMutation({
    mutationFn: ({ id, reason }: { id: string; reason: string | null }) =>
      productionApi.answerDowntime(id, reason ? { reason } : { timeout: true }),
    onSuccess: (r, v) => {
      qc.invalidateQueries({ queryKey: ['downtime-ask'] });
      // The words now show on the Downtime page and in the History Log.
      qc.invalidateQueries({ queryKey: ['downtime'] });
      qc.invalidateQueries({ queryKey: ['events'] });
      if (v.reason && !r.data?.handled) toast.info('Already answered on another device — that answer stands');
    },
    onError: (e: unknown, v) => {
      if (v.reason) {
        setHandled((h) => h.filter((x) => x !== v.id));
        toast.error(e instanceof Error ? e.message : 'Could not save — try again');
      }
    },
  });
  const answer = (id: string, reason: string | null): void => {
    setHandled((h) => [...h, id]);
    setCustom('');
    mut.mutate({ id, reason });
  };

  // One effect owns the countdown AND the expiry, closure-bound to the span
  // that armed it (see ProductionClassPopup for why). timeoutSec 0 = no
  // countdown: the ticker below only keeps "idle for 12 min" current.
  const timeoutSec = Math.max(0, Math.round(downtimeAsk?.timeoutSec ?? 0));
  const [left, setLeft] = useState(timeoutSec);
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!currentId) return;
    setLeft(timeoutSec);
    const t = setInterval(() => { setLeft((l) => l - 1); setTick((n) => n + 1); }, 1000);
    const expiry = timeoutSec > 0 ? setTimeout(() => answer(currentId, null), timeoutSec * 1000) : null;
    return () => { clearInterval(t); if (expiry) clearTimeout(expiry); };
  }, [currentId, timeoutSec]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!active || !current) return null;

  const color = TYPE_COLOR[current.type] || '#64748B';
  const open = !current.endedAt;
  const lastedMs = open ? Date.now() - new Date(current.startedAt).getTime() : (current.durationMs || 0);
  const reasons = (downtimeAsk?.reasons || []).filter((r) => r.types.includes(current.type as 'idle' | 'stopped')).map((r) => r.label);
  const pct = timeoutSec > 0 ? Math.max(0, Math.min(100, (left / timeoutSec) * 100)) : 0;
  const typed = custom.trim();

  return (
    <Modal title={`Machine ${current.type}${open ? '' : ' earlier'}`} subtitle="What was the reason?" icon={PauseCircle}
      onClose={() => setHandled((h) => [...h, current._id])} maxW="max-w-md">
      <div className="space-y-4">
        <div className="rounded-xl border px-4 py-3" style={{ borderColor: `${color}55`, background: `${color}0F` }}>
          <div className="flex items-baseline justify-between gap-3">
            <span className="font-semibold text-primary truncate">{mName(current.machineId)}</span>
            <span className="pill font-bold uppercase" style={{ background: `${color}1A`, color }}>{current.type}</span>
          </div>
          <div className="mt-1 flex items-baseline gap-2">
            <span className="data text-2xl font-bold text-primary tabular-nums">{fmtDuration(lastedMs)}</span>
            <span className="text-[11px] text-steel">
              {open ? `since ${fmtTime(current.startedAt)} · still ${current.type}` : `${fmtTime(current.startedAt)} → ${fmtTime(current.endedAt)}`}
            </span>
          </div>
          {rows.length > 1 && (
            <div className="text-[11px] text-steel mt-1">{rows.length - 1} more waiting — each gets its own turn</div>
          )}
        </div>

        {/* Big touch targets: this is read at arm's length on a shop floor. */}
        {reasons.length > 0 && (
          <div className="grid grid-cols-2 gap-2.5">
            {reasons.map((label) => (
              <button key={label} onClick={() => answer(current._id, label)}
                className="rounded-xl border-2 py-3.5 px-3 text-sm font-semibold transition-colors hover:opacity-90 active:scale-[0.98]"
                style={{ borderColor: `${color}55`, background: `${color}14`, color }}>
                {label}
              </button>
            ))}
          </div>
        )}

        {downtimeAsk?.allowCustom && (
          <div className="flex gap-2">
            <input value={custom} maxLength={200} onChange={(e) => setCustom(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && typed) { e.preventDefault(); answer(current._id, typed); } }}
              placeholder={reasons.length ? 'Another reason…' : 'Type the reason…'}
              className="flex-1 border border-line rounded-lg px-3 py-2 text-sm bg-base text-primary outline-none focus:border-accent" />
            <button disabled={!typed} onClick={() => answer(current._id, typed)}
              className="px-4 py-2 rounded-lg bg-accent text-white text-sm font-semibold disabled:opacity-50">Save</button>
          </div>
        )}

        {timeoutSec > 0 ? (
          <div>
            <div className="h-1.5 rounded-full bg-line overflow-hidden">
              <div className="h-full rounded-full transition-all duration-1000 ease-linear"
                style={{ width: `${pct}%`, background: left <= 5 ? '#DC2626' : 'rgb(var(--c-accent, 13 148 136))' }} />
            </div>
            <div className="flex items-center justify-between mt-1.5 text-[11px] text-steel">
              <span>No answer in <span className="data font-semibold text-primary">{Math.max(0, left)}s</span> → left without a reason</span>
              <span>Can be added later on the Downtime page</span>
            </div>
          </div>
        ) : (
          <div className="text-[11px] text-steel">This stays until answered. Esc skips it for now — it comes back later.</div>
        )}
      </div>
    </Modal>
  );
}
