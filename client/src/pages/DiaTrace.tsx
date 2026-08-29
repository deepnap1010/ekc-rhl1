// client/src/pages/DiaTrace.tsx — the dia-wise story, whole.
// One section per dia: which machines ran it, since when, what each counted
// while it was live, who set it — and because rows are time-ranged, "the dia
// changed and THEN what happened" reads straight down the timeline. Opens with
// a right-to-left slide (see styles/index.css · .page-slide-in).
//
// Numbers come from /production/trace: the same confirmed-counter-step engine
// as every report, summed inside each assignment's own span — so a figure here
// always agrees with the reports that cover the same hours.
import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, Ruler, Search, Waypoints } from 'lucide-react';
import { productionApi } from '../api/endpoints';
import { Spinner } from '../components/ui';
import { fmtNum, fmtTime, fmtDuration } from '../lib/format';
import { targetUnits, secToMinPerPc } from '../lib/targets';
import type { DiaTraceRow } from '../types/api';

const TEAL = '#0D9488', AMBER = '#D97706', RED = '#DC2626', SLATE = '#94A3B8';

/** produced vs what the frozen rate allows over the run's gross span. */
export function attainOf(r: DiaTraceRow): number | null {
  if (r.produced == null) return null;
  const end = r.to ? +new Date(r.to) : Date.now();
  const ms = end - +new Date(r.from);
  if (ms < 5 * 60_000) return null;              // too young to judge
  const expected = targetUnits(r.processingSec, ms);
  return expected > 0 ? Math.round((r.produced / expected) * 100) : null;
}
const attainColor = (p: number | null): string => (p == null ? SLATE : p > 90 ? TEAL : p >= 50 ? AMBER : RED);

/** One run on the timeline — shared by this page and the machine-card modal. */
export function TraceRun({ r, showMachine = true, showDia = false }: {
  r: DiaTraceRow; showMachine?: boolean; showDia?: boolean;
}): JSX.Element {
  const current = !r.to;
  const end = r.to ? +new Date(r.to) : Date.now();
  const durMs = end - +new Date(r.from);
  const p = attainOf(r);
  return (
    <div className="relative pl-6 pb-4 last:pb-0">
      {/* timeline rail + dot — the current run pulses accent */}
      <span className="absolute left-[7px] top-[18px] bottom-0 w-px bg-line" aria-hidden />
      <span className={`absolute left-0 top-[5px] w-[15px] h-[15px] rounded-full border-2 ${
        current ? 'bg-accent border-accent/30 ring-4 ring-accent/10' : 'bg-surface border-line'
      }`} aria-hidden />

      <div className="flex items-baseline gap-2 flex-wrap">
        {showMachine && <span className="data font-bold text-sm text-primary">{r.machineRef.toUpperCase()}</span>}
        {showDia && (
          <span className="inline-flex items-center gap-1 pill bg-accent/10 text-accent data !text-[10px]">
            <Ruler size={10} /> {r.dia}
          </span>
        )}
        <span className="text-[11px] text-steel">{r.stage} · {secToMinPerPc(r.processingSec)} min/pc</span>
        {current && <span className="pill bg-running/10 text-running !text-[10px] font-semibold">running now</span>}
        <span className="ml-auto text-right shrink-0">
          <span className="data text-lg font-bold" style={{ color: r.produced == null ? SLATE : attainColor(p) }}>
            {r.produced != null ? fmtNum(r.produced) : '—'}
          </span>
          <span className="text-[11px] text-steel"> pcs</span>
        </span>
      </div>
      <div className="flex items-baseline gap-2 flex-wrap mt-0.5 text-[11px] text-steel">
        <span className="data">{fmtTime(r.from)} → {r.to ? fmtTime(r.to) : 'now'}</span>
        <span>· {fmtDuration(durMs)}</span>
        {r.assignedBy && <span>· set by {r.assignedBy}</span>}
        {r.truncated && <span className="text-idle">· counted from the last 92 days only</span>}
        {r.produced == null && <span>· this machine publishes no counter</span>}
        {p != null && (
          <span className="ml-auto data font-semibold" style={{ color: attainColor(p) }}>{p}% of rate</span>
        )}
      </div>
    </div>
  );
}

export default function DiaTrace(): JSX.Element {
  const nav = useNavigate();
  const [q, setQ] = useState('');

  const { data, isLoading } = useQuery({
    queryKey: ['dia-trace', 'all'],
    queryFn: () => productionApi.trace().then((r) => r.data),
    refetchInterval: 60_000,
  });

  const ql = q.trim().toUpperCase();
  const rows = (data || []).filter((r) =>
    !ql || r.dia.toUpperCase().includes(ql) || r.machineRef.toUpperCase().includes(ql));

  // Grouped by dia, richest first; rows inside stay newest-first (server order).
  const groups = useMemo(() => {
    const by = new Map<string, DiaTraceRow[]>();
    for (const r of rows) {
      const arr = by.get(r.dia) || [];
      arr.push(r);
      by.set(r.dia, arr);
    }
    return [...by.entries()]
      .map(([dia, runs]) => ({
        dia,
        dims: runs.find((r) => r.dims)?.dims || '',
        runs,
        produced: runs.reduce((n, r) => n + (r.produced ?? 0), 0),
        machines: new Set(runs.map((r) => r.machineRef)).size,
        live: runs.filter((r) => !r.to).length,
      }))
      .sort((a, b) => b.produced - a.produced || b.runs.length - a.runs.length);
  }, [rows]);

  const totals = {
    dias: groups.length,
    runs: rows.length,
    produced: groups.reduce((n, g) => n + g.produced, 0),
  };

  return (
    <div className="page-slide-in">
      {/* Header — a destination page, so the way back leads it */}
      <div className="sticky top-0 z-10 bg-surface/95 backdrop-blur border-b border-line px-4 sm:px-6 py-4 shadow-sm">
        <div className="flex items-center gap-3 flex-wrap">
          <button onClick={() => nav('/production')}
            className="flex items-center gap-1.5 text-steel hover:text-primary text-sm transition-colors">
            <ArrowLeft size={16} /> Production Targets
          </button>
          <span className="text-line">/</span>
          <span className="w-8 h-8 rounded-lg bg-accent/10 flex items-center justify-center"><Waypoints size={15} className="text-accent" /></span>
          <div className="min-w-0">
            <h1 className="text-lg font-semibold text-primary leading-tight">Dia Trace</h1>
            <p className="text-xs text-steel">Every dia's journey — which machines ran it, when, and what each one counted</p>
          </div>
          <div className="ml-auto flex items-center gap-4 text-right">
            <HeaderStat label="Dias" value={fmtNum(totals.dias)} />
            <HeaderStat label="Runs" value={fmtNum(totals.runs)} />
            <HeaderStat label="Pieces counted" value={fmtNum(totals.produced)} accent />
          </div>
        </div>
      </div>

      <div className="px-4 sm:px-6 py-6 space-y-5 max-w-5xl">
        {/* Search — one box, filters dia AND machine */}
        <div className="relative">
          <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-steel" />
          <input value={q} onChange={(e) => setQ(e.target.value)}
            placeholder="Filter by dia or machine — e.g. CN 410 or SPG02"
            className="w-full bg-surface border border-line rounded-xl pl-9 pr-3 py-2.5 text-sm outline-none focus:border-accent" />
        </div>

        {isLoading ? <Spinner /> : !groups.length ? (
          <div className="panel p-10 text-center">
            <Waypoints size={28} className="mx-auto text-steel mb-3" />
            <p className="text-sm text-steel max-w-md mx-auto">
              {q ? 'Nothing matches that filter.' : 'No dia has been assigned yet — the first assignment starts the trail.'}
            </p>
          </div>
        ) : groups.map((g, i) => (
          <section key={g.dia} className="panel overflow-hidden page-slide-in" style={{ animationDelay: `${Math.min(i * 60, 300)}ms` }}>
            {/* Dia header band */}
            <div className="flex items-center gap-3 flex-wrap px-5 py-4 bg-base border-b border-line">
              <span className="w-10 h-10 rounded-xl bg-accent/10 flex items-center justify-center shrink-0">
                <Ruler size={18} className="text-accent" />
              </span>
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <h2 className="data font-bold text-primary truncate">{g.dia}</h2>
                  {g.dims && <span className="text-xs text-steel">· {g.dims}</span>}
                  {g.live > 0 && <span className="pill bg-running/10 text-running !text-[10px] font-semibold">on {g.live} machine{g.live === 1 ? '' : 's'} now</span>}
                </div>
                <p className="text-[11px] text-steel">{g.runs.length} run{g.runs.length === 1 ? '' : 's'} across {g.machines} machine{g.machines === 1 ? '' : 's'}</p>
              </div>
              <div className="ml-auto text-right shrink-0">
                <div className="data text-2xl font-bold text-accent leading-none">{fmtNum(g.produced)}</div>
                <div className="label mt-0.5">pieces under this dia</div>
              </div>
            </div>
            {/* The timeline */}
            <div className="px-5 py-4">
              {g.runs.map((r) => <TraceRun key={`${r.machineRef}-${r.from}`} r={r} />)}
            </div>
          </section>
        ))}

        {groups.length > 0 && (
          <p className="text-[11px] text-steel">
            Pieces are the same confirmed counter steps every report uses, summed inside each
            assignment's own span — a run's figure always matches the reports covering those hours.
          </p>
        )}
      </div>
    </div>
  );
}

function HeaderStat({ label, value, accent }: { label: string; value: string; accent?: boolean }): JSX.Element {
  return (
    <div>
      <div className={`data text-lg font-bold leading-none ${accent ? 'text-accent' : 'text-primary'}`}>{value}</div>
      <div className="label mt-0.5">{label}</div>
    </div>
  );
}
