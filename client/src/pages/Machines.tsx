// client/src/pages/Machines.tsx
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Search, Filter, Layers, Activity, Pause, Square, ArrowRight, type LucideIcon } from 'lucide-react';
import { machineApi } from '../api/endpoints';
import { StatusPill } from '../components/ui';
import Sparkline from '../components/Sparkline';
import Freshness from '../components/Freshness';
import PageHeader from '../components/PageHeader';
import { fmtCompact, fmtMetric, prettyKey, prettyType, fmtTime, breachesThreshold, isNumeric } from '../lib/format';
import { cardParams, paramLabel, isRawAddress } from '../lib/params';
import { statusCounts, effectiveStatus } from '../lib/machineStatus';
import { computeHeadline, type Headline } from '../lib/headline';
import { useDashboardLive } from '../hooks/useLive';
import type { Machine, MachineTick } from '../types/api';

const TEAL = '#0D9488';
const AMBER = '#D97706';
const RED = '#DC2626';
const HEADLINE_TONE: Record<string, string> = { good: TEAL, warn: AMBER, bad: RED, neutral: '#1E293B' };
const STATUS_FILTERS = ['all', 'running', 'idle', 'stopped', 'offline'];

export default function Machines() {
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('all');
  const live = useDashboardLive();

  const { data, isLoading } = useQuery({
    queryKey: ['machines', search],
    queryFn: () => machineApi.list({ search, limit: 100 }),
    refetchInterval: 15000,
  });

  const allMachines = data?.data || [];
  const counts = statusCounts(allMachines);
  const machines = status === 'all' ? allMachines : allMachines.filter((m) => effectiveStatus(m) === status);

  return (
    <div>
      <PageHeader title="Machines" subtitle={`${counts.total} registered`} live={Object.keys(live).length} />

      <div className="px-4 sm:px-6 pb-8 space-y-5 pt-5">
        {/* KPI tiles */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          <Kpi label="Total"   value={counts.total}   sub="All machines"   color={TEAL}  icon={Layers} />
          <Kpi label="Running" value={counts.running} sub="Active now"     color={TEAL}  icon={Activity} />
          <Kpi label="Idle"    value={counts.idle}    sub="No activity"    color={AMBER} icon={Pause} />
          <Kpi label="Stopped" value={counts.stopped} sub="Not operational" color={RED}  icon={Square} />
        </div>

        {/* Search + filter bar */}
        <div className="panel p-2.5 flex flex-wrap items-center gap-2">
          <div className="flex items-center gap-2 bg-base border border-line rounded-xl px-3.5 py-2.5 flex-1 min-w-[240px]">
            <Search size={16} className="text-steel" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search machine, code, type…"
              className="bg-transparent outline-none text-sm flex-1 text-primary placeholder:text-steel/60"
            />
          </div>
          <div className="flex items-center gap-1 bg-base/60 rounded-xl p-1">
            {STATUS_FILTERS.map((s) => (
              <button
                key={s}
                onClick={() => setStatus(s)}
                className={`px-3 py-1.5 rounded-lg text-xs capitalize transition-colors ${
                  status === s ? 'bg-accent/10 text-accent font-semibold' : 'text-steel hover:text-primary'
                }`}
              >
                {s}
              </button>
            ))}
          </div>
          <button
            onClick={() => { setSearch(''); setStatus('all'); }}
            title="Reset filters"
            className="w-10 h-10 flex items-center justify-center rounded-xl border border-line text-steel hover:text-accent hover:border-accent/40 transition-colors shrink-0"
          >
            <Filter size={16} />
          </button>
        </div>

        {isLoading ? (
          <div className="grid md:grid-cols-2 xl:grid-cols-3 gap-4">
            {Array.from({ length: 6 }).map((_, i) => <CardSkeleton key={i} />)}
          </div>
        ) : machines.length === 0 ? (
          <div className="panel p-12 text-center">
            <Layers size={28} className="text-steel/40 mx-auto mb-3" />
            <div className="text-sm text-steel">No machines match the current filter.</div>
          </div>
        ) : (
          <div className="grid md:grid-cols-2 xl:grid-cols-3 gap-4">
            {machines.map((m) => (
              <MachineCard key={m.code || m._id} machine={m} liveTick={live[m.code || m._id]} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function Kpi({ label, value, sub, color, icon: Icon }: { label: string; value: number; sub: string; color: string; icon: LucideIcon }) {
  return (
    <div className="card p-4 flex items-center justify-between gap-3">
      <div className="min-w-0">
        <div className="label">{label}</div>
        <div className="data text-3xl font-bold mt-1 leading-none" style={{ color }}>{value}</div>
        <div className="text-[11px] text-steel mt-1.5">{sub}</div>
      </div>
      <span className="w-11 h-11 rounded-xl flex items-center justify-center shrink-0" style={{ background: `${color}1a`, color }}>
        <Icon size={22} />
      </span>
    </div>
  );
}

interface MachineCardProps {
  machine: Machine;
  liveTick?: MachineTick;
}

function MachineCard({ machine, liveTick }: MachineCardProps) {
  const cp        = liveTick?.currentParameters || machine.currentParameters || {};
  const params    = Object.keys(cp).length ? cp : (machine.latestData || {});
  const status    = effectiveStatus({ status: liveTick?.status || machine.status, lastReadingAt: liveTick?.lastReadingAt || machine.lastReadingAt });
  const lastSeen  = liveTick?.lastReadingAt || machine.lastReadingAt;
  const thresholds = machine.thresholds || {};
  const id        = machine.code || machine._id;
  const code      = machine.code || machine.machineId || machine.name || '—';
  const nameLabel = machine.name || machine.machineName;
  const showName  = !!nameLabel && String(nameLabel).toUpperCase() !== String(code).toUpperCase();
  const typeLabel = machine.type || machine.machineType;
  const prettyT   = typeLabel && typeLabel !== 'UNKNOWN' ? prettyType(typeLabel) : null;
  const subtitle  = [(showName ? nameLabel : null) || (prettyT ? null : 'UNKNOWN'), prettyT || '—'].filter(Boolean).join(' · ');

  // Signal-mapping awareness — honest "what's live vs what still needs mapping".
  const sigEntries = Object.entries(params).filter(([k]) => k.toLowerCase() !== 'status');
  const sigTotal   = sigEntries.length;
  const rawCount   = sigEntries.filter(([k]) => isRawAddress(k)).length;
  const namedCount = sigTotal - rawCount;
  const liveCount  = sigEntries.filter(([, v]) => (isNumeric(v) && Number(v) !== 0) || (typeof v === 'string' && v.trim() !== '')).length;
  const rawOnly    = sigTotal > 0 && namedCount === 0;

  const cells = cardParams(params, 9);
  const headline = computeHeadline(params);
  const hero: Headline = headline ?? {
    label: 'Signals Tracked',
    value: fmtCompact(sigTotal),
    tone: 'neutral',
    sub: 'unmapped raw signals',
  };

  // Per-card trends: [0] drives the hero sparkline, [1] the secondary progress bar.
  const statKey = machine.code || machine.machineId || machine._id;
  const { data: cardStats } = useQuery({
    queryKey: ['machine-stats', statKey],
    queryFn: () => machineApi.stats(statKey).then((r) => r.data),
    enabled: !!statKey,
    staleTime: 15000,
    refetchInterval: 20000,
  });
  const trend = cardStats?.metrics?.[0];
  const bar = cardStats?.metrics?.[1];
  const barPct = bar && bar.last != null && bar.min != null && bar.max != null && bar.max > bar.min
    ? Math.max(4, Math.min(100, ((bar.last - bar.min) / (bar.max - bar.min)) * 100))
    : (bar ? 100 : 0);

  return (
    <Link
      to={`/machines/${id}`}
      className="card p-4 flex flex-col transition-all hover:shadow-md hover:border-accent/30 hover:-translate-y-0.5 group"
    >
      {/* Header */}
      <div className="flex items-start justify-between gap-2 mb-3">
        <div className="min-w-0">
          <div className="data font-bold text-sm text-primary group-hover:text-accent transition-colors truncate">
            {String(code).toUpperCase()}
          </div>
          <div className="text-[11px] text-steel mt-0.5 truncate">{subtitle}</div>
        </div>
        <div className="flex flex-col items-end gap-1 shrink-0">
          <StatusPill status={status} />
          <Freshness lastReadingAt={lastSeen} />
        </div>
      </div>

      {/* Mapping strip */}
      {sigTotal > 0 && (
        <div className="flex items-center gap-2 mb-3">
          <span className={`inline-flex items-center gap-1 text-[10px] font-medium px-2 py-0.5 rounded-full ${rawOnly ? 'bg-amber-50 text-amber-700 border border-amber-200' : 'bg-accent/10 text-accent'}`}>
            <span className={`w-1 h-1 rounded-full ${rawOnly ? 'bg-amber-500' : 'bg-accent'}`} />
            {rawOnly ? 'Raw only · needs mapping' : `${namedCount}/${sigTotal} mapped`}
          </span>
          <span className="text-[10px] text-steel/70">{liveCount} live</span>
        </div>
      )}

      {/* Hero metric + inline sparkline */}
      <div className="mb-3 rounded-xl border border-line bg-base px-3.5 py-3 flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="text-[10px] uppercase tracking-wide text-steel">{hero.label}</div>
          <div className="flex items-baseline gap-1">
            <span className="data text-2xl font-bold leading-none" style={{ color: HEADLINE_TONE[hero.tone] }}>{hero.value}</span>
            {hero.unit && <span className="text-sm font-medium text-steel">{hero.unit}</span>}
          </div>
          {hero.sub && <div className="text-[10px] text-steel mt-0.5 truncate">{hero.sub}</div>}
        </div>
        {trend && trend.spark.length > 1 && (
          <div className="w-28 h-12 shrink-0 self-center"><Sparkline data={trend.spark} height={48} color={TEAL} /></div>
        )}
      </div>

      {/* Secondary metric with progress bar */}
      {bar && (
        <div className="mb-3">
          <div className="flex items-center justify-between text-[11px] mb-1">
            <span className="text-steel uppercase tracking-wide truncate" title={prettyKey(paramLabel(bar.key))}>{prettyKey(paramLabel(bar.key))}</span>
            <span className="data text-primary font-semibold shrink-0">{fmtMetric(bar.last)}</span>
          </div>
          <div className="h-1.5 rounded-full bg-line overflow-hidden">
            <div className="h-full rounded-full bg-accent" style={{ width: `${barPct}%` }} />
          </div>
        </div>
      )}

      {/* Key parameters */}
      {cells.length > 0 && (
        <div className="grid grid-cols-3 gap-1.5 mb-3">
          {cells.map(([k, v]) => {
            const breach = breachesThreshold(k, v, thresholds);
            const raw = isRawAddress(k);
            const cellLabel = raw ? paramLabel(k).toUpperCase() : prettyKey(paramLabel(k));
            return (
              <div key={k} className={`overflow-hidden rounded-md px-2 py-1.5 border ${breach ? 'bg-stopped/10 border-stopped/30' : 'bg-base border-line'}`}>
                <div className={`truncate ${raw ? 'data text-[9px] text-steel/70' : 'text-[9px] text-steel uppercase tracking-wide'}`} title={cellLabel}>{cellLabel}</div>
                <div className={`data text-xs font-semibold truncate ${breach ? 'text-stopped' : 'text-primary'}`} title={String(fmtMetric(v))}>{fmtMetric(v)}</div>
              </div>
            );
          })}
        </div>
      )}

      {/* Footer */}
      <div className="mt-auto pt-2.5 border-t border-line flex items-center justify-between text-[10px]">
        <span className="text-steel/70 truncate">{fmtTime(lastSeen)}</span>
        <span className="inline-flex items-center gap-0.5 text-accent/80 font-medium group-hover:text-accent transition-colors">
          View dashboard <ArrowRight size={11} className="transition-transform group-hover:translate-x-0.5" />
        </span>
      </div>
    </Link>
  );
}

function CardSkeleton() {
  return (
    <div className="card p-4 animate-pulse">
      <div className="flex justify-between mb-3">
        <div className="space-y-2"><div className="h-3.5 w-28 bg-line rounded" /><div className="h-2.5 w-20 bg-line/70 rounded" /></div>
        <div className="h-5 w-16 bg-line rounded-full" />
      </div>
      <div className="h-16 bg-line/50 rounded-xl mb-3" />
      <div className="h-1.5 bg-line/50 rounded-full mb-3" />
      <div className="grid grid-cols-3 gap-1.5">
        {Array.from({ length: 6 }).map((_, i) => <div key={i} className="h-9 bg-line/40 rounded-md" />)}
      </div>
    </div>
  );
}
