// client/src/components/machine/TargetPanel.tsx
// The operator's answer at a glance: WHAT am I making, what STAGE, what's the
// TARGET, how much is PRODUCED, how much is ACHIEVED. Target = the day's
// assigned seconds ÷ the assignment's frozen processing time; produced = the
// same verified counter steps every other surface shows. Over 100% keeps
// filling — beating the target is the good case, not an error.
import { Target } from 'lucide-react';
import { useCurrentAssignment } from './AssignDia';
import { fmtNum } from '../../lib/format';
import { assignedMs, targetUnits, achievementPct, fmtTarget, fmtProcessing } from '../../lib/targets';
import type { MachineActivityRow } from '../../types/api';

export default function TargetPanel({ code, actRow, dayFrom, dayTo }: {
  code: string;
  actRow?: MachineActivityRow | null;   // TODAY's activity row (07:00 → now)
  dayFrom: string;                      // the production-day window the row covers
  dayTo: string;
}): JSX.Element | null {
  const current = useCurrentAssignment(code);
  if (!current) return null;            // unassigned machines add no target noise

  const winFrom = new Date(dayFrom).getTime();
  const winTo = Math.min(new Date(dayTo).getTime(), Date.now());
  const ms = assignedMs(current, winFrom, winTo);
  const sec = current.snapshot.processingSec;
  const target = targetUnits(sec, ms);
  const produced = actRow?.production ?? null;
  const pct = produced != null ? achievementPct(produced, sec, ms) : null;
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
        <h3 className="font-semibold text-sm text-primary flex-1">Today's Target</h3>
        <span className="text-[11px] text-steel">
          {current.snapshot.diaName}{current.snapshot.dims ? ` · ${current.snapshot.dims}` : ''} — {current.snapshot.stageName} · {fmtProcessing(sec)}/unit
        </span>
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
            <span className="text-steel text-sm">pcs today</span>
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
    </div>
  );
}
