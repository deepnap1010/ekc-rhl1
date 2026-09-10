// client/src/components/ProductionClassPopup.tsx
// Operator side of production classification: every counter advance on THEIR
// machines that nobody has answered yet, one at a time, oldest first.
//
// The popup never gates the count — the event is already recorded AND already
// classified with the admin's default when it appears here. A button press
// refines it; the countdown running out just marks "asked, no answer" so the
// row leaves the queue with its default intact. Multiple advances queue up:
// one popup per event, each with its own full countdown, so nothing is merged,
// lost, or answered twice (the server takes the first answer atomically).
import { useEffect, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Factory } from 'lucide-react';
import Modal from './Modal';
import { productionApi } from '../api/endpoints';
import { useAuthStore } from '../store/auth';
import { useAppConfig } from '../hooks/useAppConfig';
import { toast } from '../store/toast';
import { fmtNum, fmtTime } from '../lib/format';
import { useMachineName } from '../lib/machineName';

// One accent per internal value — labels are the admin's, colors are ours.
export const CLASS_COLORS: Record<string, string> = {
  OK: '#0D9488', DRY_CYCLE: '#D97706', DEFECTIVE: '#DC2626', SAMPLE: '#64748B',
};

export function ProductionClassPopup(): JSX.Element | null {
  const user = useAuthStore((s) => s.user);
  const can = useAuthStore((s) => s.can);
  const { prodClass } = useAppConfig();
  const mName = useMachineName();
  const qc = useQueryClient();
  const isOperator = (user?.assignedMachines?.length ?? 0) > 0;
  const active = !!prodClass?.enabled && isOperator && can('production', 'view');

  const { data } = useQuery({
    queryKey: ['prodclass', 'queue'],
    queryFn: () => productionApi.classQueue().then((r) => r.data),
    enabled: active,
    refetchInterval: 20_000,
  });

  // Answered here and now: the event leaves the screen on click, not a
  // round-trip later. A refused ANSWER comes back with a toast; a refused
  // timeout stays gone (the row already holds the default either way).
  const [handled, setHandled] = useState<string[]>([]);
  const rows = (data || []).filter((r) => !handled.includes(r._id));
  const current = rows[0];
  const currentId = current?._id;

  const mut = useMutation({
    mutationFn: ({ id, value }: { id: string; value: string | null }) =>
      productionApi.classifyEvent(id, value ? { value } : { timeout: true }),
    onSuccess: (r, v) => {
      qc.invalidateQueries({ queryKey: ['prodclass'] });
      // Two devices, one event: the server keeps the FIRST answer. Tell the
      // second person theirs didn't land instead of faking success.
      if (v.value && !r.data?.handled) toast.info('Already answered on another device — that answer stands');
    },
    onError: (e: unknown, v) => {
      if (v.value) {
        setHandled((h) => h.filter((x) => x !== v.id));
        toast.error(e instanceof Error ? e.message : 'Could not save — try again');
      }
    },
  });
  const answer = (id: string, value: string | null): void => {
    setHandled((h) => [...h, id]);
    mut.mutate({ id, value });
  };

  // Each event gets the admin-configured window, in full, from the moment it
  // reaches the front of the queue. ONE effect owns both the cosmetic ticker
  // and the expiry, and the expiry timer is closure-bound to the event id that
  // armed it — a separate "left <= 0" watcher effect re-fired on the queue
  // advancing (stale left=0, new id) and silently timed out the NEXT event
  // with a zero-second window. Cleanup on id change cancels both timers, so a
  // fronted event can only ever be expired by its own clock.
  const timeoutSec = Math.min(600, Math.max(3, Math.round(prodClass?.timeoutSec ?? 20)));
  const [left, setLeft] = useState(timeoutSec);
  useEffect(() => {
    if (!currentId) return;
    setLeft(timeoutSec);
    const t = setInterval(() => setLeft((l) => l - 1), 1000);
    const expiry = setTimeout(() => answer(currentId, null), timeoutSec * 1000);
    return () => { clearInterval(t); clearTimeout(expiry); };
  }, [currentId, timeoutSec]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!active || !current) return null;

  const options = (prodClass?.options || []).filter((o) => o.enabled).sort((a, b) => a.order - b.order);
  const defaultLabel = (prodClass?.options || []).find((o) => o.value === prodClass?.defaultValue)?.label || 'OK';
  const pct = Math.max(0, Math.min(100, (left / timeoutSec) * 100));

  return (
    // Esc / backdrop / X is a LOCAL skip, not a server timeout: a stray tap on
    // a shop-floor touchscreen must not consume the ask — the event stays
    // 'default' and comes back after a reload or on another device. Only the
    // countdown genuinely running out marks "asked, no answer" server-side.
    <Modal title="Production increased" subtitle="What was this production?" icon={Factory}
      onClose={() => setHandled((h) => [...h, current._id])} maxW="max-w-md">
      <div className="space-y-4">
        <div className="rounded-xl border border-accent/30 bg-accent/5 px-4 py-3">
          <div className="flex items-baseline justify-between gap-3">
            <span className="font-semibold text-primary truncate">{mName(current.machineId)}</span>
            <span className="data text-xs text-steel shrink-0">{fmtTime(current.startedAt)}</span>
          </div>
          <div className="mt-1 flex items-baseline gap-2">
            <span className="data text-2xl font-bold text-primary tabular-nums">
              {fmtNum(current.prevValue ?? 0)} → {fmtNum(current.newValue ?? 0)}
            </span>
            <span className="pill bg-running/10 text-running font-bold">+{fmtNum(current.delta || 0)} pc{(current.delta || 0) === 1 ? '' : 's'}</span>
          </div>
          {rows.length > 1 && (
            <div className="text-[11px] text-steel mt-1">{rows.length - 1} more waiting — each gets its own turn</div>
          )}
        </div>

        {/* Big touch targets: this is read at arm's length on a shop floor. */}
        <div className="grid grid-cols-2 gap-2.5">
          {options.map((o) => {
            const c = CLASS_COLORS[o.value] || '#0D9488';
            return (
              <button key={o.value} onClick={() => answer(current._id, o.value)}
                className="rounded-xl border-2 py-4 px-3 text-base font-semibold transition-colors hover:opacity-90 active:scale-[0.98]"
                style={{ borderColor: `${c}55`, background: `${c}14`, color: c }}>
                {o.label}
              </button>
            );
          })}
        </div>

        <div>
          <div className="h-1.5 rounded-full bg-line overflow-hidden">
            <div className="h-full rounded-full transition-all duration-1000 ease-linear"
              style={{ width: `${pct}%`, background: left <= 5 ? '#DC2626' : 'rgb(var(--c-accent, 13 148 136))' }} />
          </div>
          <div className="flex items-center justify-between mt-1.5 text-[11px] text-steel">
            <span>No answer in <span className="data font-semibold text-primary">{Math.max(0, left)}s</span> → recorded as {defaultLabel}</span>
            <span>The count is already saved either way</span>
          </div>
        </div>
      </div>
    </Modal>
  );
}
