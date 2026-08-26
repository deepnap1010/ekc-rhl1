// client/src/components/TargetsBoard.tsx
// The line-dashboard view of targets: one ring per machine that carries a DIA,
// achievement filling it — teal at/over target, amber behind, red far behind —
// with produced-of-target, the DIA · stage it is held to, and its downtime for
// the window. One glance answers "who is making rate and who is not".
//
// Data is the page's own activity rows (already scoped: an operator whose
// account is limited to their machines sees only those rings) joined with the
// current assignments; the target math is the same net-assigned-seconds ÷
// processing-seconds every other surface uses. Clicking a ring opens the
// machine, where the hourly bars break the same day down hour by hour.
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Target } from 'lucide-react';
import TargetDrilldown from './TargetDrilldown';
import { productionApi } from '../api/endpoints';
import { useAuthStore } from '../store/auth';
import { useAppConfig } from '../hooks/useAppConfig';
import { fmtNum, fmtDuration } from '../lib/format';
import { windowNetMs, targetUnits, achievementPct, fmtTarget, hourlyRate } from '../lib/targets';
import type { MachineActivityRow } from '../types/api';

const TEAL = '#0D9488', AMBER = '#D97706', RED = '#DC2626';

export default function TargetsBoard({ rows, from, to, windowMs }: {
  rows: MachineActivityRow[];
  from?: string;
  to?: string;
  windowMs?: number;
}): JSX.Element | null {
  const can = useAuthStore((s) => s.can);
  const { breaks } = useAppConfig();
  const [drill, setDrill] = useState<string | null>(null);   // machineRef of the open drilldown
  const { data: asgData } = useQuery({
    queryKey: ['assignments', 'current'],
    queryFn: () => productionApi.currentAssignments().then((r) => r.data),
    enabled: can('production', 'view'),
    staleTime: 30_000,
    refetchInterval: 60_000,
    retry: false,
  });
  if (!from || !to || !asgData?.length) return null;

  const winFrom = new Date(from).getTime();
  const winTo = Math.min(new Date(to).getTime(), Date.now());
  const rowBy = new Map(rows.map((r) => [r.code.toUpperCase(), r]));

  const tiles = asgData.map((a) => {
    const row = rowBy.get(a.machineRef.toUpperCase());
    if (!row) return null;                       // outside scope / window
    // The whole filter window at the DIA's rate — a 1-hour filter asks for the
    // hourly rate, a day asks for the day's quota. The assignment only decides
    // WHICH rate this machine is held to.
    const ms = windowNetMs(winFrom, winTo, breaks);
    const target = targetUnits(a.snapshot.processingSec, ms);
    if (target <= 0) return null;
    const produced = row.production;
    const pct = produced != null ? achievementPct(produced, a.snapshot.processingSec, ms) : null;
    return {
      code: a.machineRef,
      dia: `${a.snapshot.diaName} · ${a.snapshot.stageName}`,
      rate: hourlyRate(a.snapshot.processingSec),
      produced, target, pct,
      downMs: row.idleMs + row.stoppedMs,
      borrowed: row.productionFrom || null,
    };
  }).filter(Boolean) as {
    code: string; dia: string; rate: number; produced: number | null; target: number;
    pct: number | null; downMs: number; borrowed: string | null;
  }[];
  if (!tiles.length) return null;

  const onTarget = tiles.filter((t) => (t.pct ?? 0) >= 100).length;
  const behind = tiles.filter((t) => t.pct != null && t.pct < 100).length;

  return (
    <div className="panel p-4">
      <div className="flex items-center gap-2 mb-3 flex-wrap">
        <Target size={15} className="text-accent" />
        <h3 className="font-semibold text-sm text-primary">Targets</h3>
        <span className="text-[11px] text-steel">
          {onTarget} at or over target · {behind} behind
        </span>
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6 gap-3">
        {tiles.map((t) => <RingTile key={t.code} t={t} onOpen={() => setDrill(t.code)} />)}
      </div>

      {drill && (() => {
        const t = tiles.find((x) => x.code === drill);
        const row = rowBy.get(drill.toUpperCase());
        const a = asgData.find((x) => x.machineRef === drill);
        if (!t || !row || !a) return null;
        return (
          <TargetDrilldown code={drill} row={row} assignment={a}
            from={from} to={to} windowMs={windowMs || (winTo - winFrom)}
            produced={t.produced} target={t.target} pct={t.pct}
            onClose={() => setDrill(null)} />
        );
      })()}
    </div>
  );
}

function RingTile({ t, onOpen }: { t: {
  code: string; dia: string; rate: number; produced: number | null; target: number;
  pct: number | null; downMs: number; borrowed: string | null;
}; onOpen: () => void }): JSX.Element {
  const color = t.pct == null ? '#94A3B8' : t.pct >= 100 ? TEAL : t.pct >= 50 ? AMBER : RED;
  const R = 26, C = 2 * Math.PI * R;
  const fill = t.pct == null ? 0 : Math.min(t.pct, 100) / 100;
  return (
    <button
      onClick={onOpen}
      title={`${t.code} — ${t.produced ?? '—'} of ${fmtTarget(t.target)} · click for the ${'hour-by-hour'} story`}
      className="rounded-xl border border-line bg-base p-3 flex flex-col items-center text-center hover:border-accent/40 hover:-translate-y-0.5 transition-all cursor-pointer"
    >
      <span className="data text-xs font-bold text-primary truncate max-w-full">{t.code}</span>
      <span className="text-[10px] text-steel truncate max-w-full mb-1.5">{t.dia}</span>
      <span className="relative">
        <svg width="64" height="64" viewBox="0 0 64 64">
          <circle cx="32" cy="32" r={R} fill="none" stroke="rgb(var(--c-line))" strokeWidth="6" />
          <circle cx="32" cy="32" r={R} fill="none" stroke={color} strokeWidth="6" strokeLinecap="round"
            strokeDasharray={`${C * fill} ${C}`} transform="rotate(-90 32 32)" />
        </svg>
        <span className="absolute inset-0 flex items-center justify-center data text-[13px] font-bold" style={{ color }}>
          {t.pct != null ? `${Math.round(t.pct)}%` : '—'}
        </span>
      </span>
      <span className="mt-1.5 text-[11px]">
        <span className="data font-bold text-primary">{t.produced != null ? fmtNum(t.produced) : '—'}</span>
        <span className="text-steel"> / {fmtTarget(t.target)} @ {fmtTarget(t.rate)}/hr</span>
      </span>
      {/* the same progress, horizontal — the bar the eye tracks across tiles */}
      <span className="block w-full h-1.5 bg-line rounded-full overflow-hidden mt-1.5">
        <span className="block h-full rounded-full transition-all" style={{
          width: `${Math.min(t.pct ?? 0, 100)}%`, background: color,
        }} />
      </span>
      <span className="mt-1 text-[10px] text-steel">
        {t.downMs >= 60_000 ? `${fmtDuration(t.downMs)} down` : 'no downtime'}
        {t.borrowed ? ` · from ${t.borrowed}` : ''}
      </span>
    </button>
  );
}
