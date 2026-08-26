// client/src/components/machine/DiaAssignmentSection.tsx
// The Configure tab's assignment block: what this machine is running, since
// when, by whom — plus the change control and the assignment history. Writes
// through the same endpoint as the header chip.
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Target } from 'lucide-react';
import { productionApi } from '../../api/endpoints';
import { useAuthStore } from '../../store/auth';
import { fmtTime } from '../../lib/format';
import { fmtTarget, fmtProcessing, hourlyRate } from '../../lib/targets';
import { AssignDiaModal, useCurrentAssignment } from './AssignDia';

export default function DiaAssignmentSection({ code }: { code: string }): JSX.Element | null {
  const can = useAuthStore((s) => s.can);
  const current = useCurrentAssignment(code);
  const [open, setOpen] = useState(false);
  const { data: history } = useQuery({
    queryKey: ['assignments', 'history', code],
    queryFn: () => productionApi.assignments({ machineRef: code, limit: 10 }).then((r) => r.data),
    enabled: can('production', 'view'),
    retry: false,
  });
  if (!can('production', 'view')) return null;

  return (
    <div>
      <div className="label mb-2">DIA / Production Target</div>
      <div className="panel p-4">
        <div className="flex items-center gap-3 flex-wrap">
          <Target size={16} className="text-accent shrink-0" />
          {current ? (
            <div className="min-w-0 flex-1">
              <div className="text-sm font-semibold text-primary">
                {current.snapshot.diaName}{current.snapshot.dims ? ` · ${current.snapshot.dims}` : ''} — {current.snapshot.stageName}
              </div>
              <div className="text-xs text-steel">
                {fmtProcessing(current.snapshot.processingSec)}/unit → <span className="data text-accent font-semibold">{fmtTarget(hourlyRate(current.snapshot.processingSec))}/hr</span>
                {' '}· since {fmtTime(current.effectiveFrom)}{current.assignedBy?.name ? ` · by ${current.assignedBy.name}` : ''}
              </div>
            </div>
          ) : (
            <span className="text-sm text-steel flex-1">No DIA assigned — this machine has no production target.</span>
          )}
          {can('production', 'update') && (
            <button onClick={() => setOpen(true)}
              className="shrink-0 px-3 py-1.5 rounded-lg border border-accent/20 bg-accent/5 text-accent text-xs font-medium hover:bg-accent/10">
              {current ? 'Change' : 'Assign DIA'}
            </button>
          )}
        </div>

        {(history || []).length > 1 && (
          <div className="mt-3 pt-3 border-t border-line">
            <div className="text-[10px] uppercase tracking-wide text-steel mb-1.5">Assignment history</div>
            <div className="space-y-1">
              {(history || []).filter((h) => h.effectiveTo).slice(0, 5).map((h) => (
                <div key={h._id} className="flex items-baseline justify-between gap-2 text-xs">
                  <span className="text-primary truncate">{h.snapshot.diaName} — {h.snapshot.stageName}</span>
                  <span className="data text-steel shrink-0">{fmtTime(h.effectiveFrom)} → {h.effectiveTo ? fmtTime(h.effectiveTo) : 'now'}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
      {open && <AssignDiaModal code={code} current={current} onClose={() => setOpen(false)} />}
    </div>
  );
}
