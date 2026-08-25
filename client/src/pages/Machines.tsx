// client/src/pages/Machines.tsx
import { useEffect, useReducer, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useQuery, keepPreviousData } from '@tanstack/react-query';
import { Search, Filter, Layers, Activity, Pause, Square, ArrowRight, Calendar, X, Pencil, Eye, type LucideIcon } from 'lucide-react';
import { machineApi } from '../api/endpoints';
import { StatusPill, TimeStat } from '../components/ui';
import Sparkline from '../components/Sparkline';
import Freshness from '../components/Freshness';
import PageHeader from '../components/PageHeader';
import { fmtCompact, fmtNum, fmtDuration, prettyKey, prettyType, fmtTime, isNumeric } from '../lib/format';
import { paramLabel, isRawAddress, flattenParams } from '../lib/params';
import { productionValue, borrowedFrom } from '../lib/production';
import { isFurnaceRef, temperatureNow } from '../lib/temperature';
import { processCompare } from '../lib/machineOrder';
import { statusCounts, effectiveStatus, isStale } from '../lib/machineStatus';
import { computeHeadline, type Headline } from '../lib/headline';
import { useDashboardLive } from '../hooks/useLive';
import { useAppConfig } from '../hooks/useAppConfig';
import { todayWindow } from '../store/filters';
import { useMachineConfig, machineKey, getConfig, saveConfig } from '../lib/machineConfig';
import ParametersModal from '../components/machine/MachineParameters';
import type { Machine, MachineTick, MachineActivityRow } from '../types/api';

const TEAL = '#0D9488';
const AMBER = '#D97706';
const RED = '#DC2626';
const HEADLINE_TONE: Record<string, string> = { good: TEAL, warn: AMBER, bad: RED, neutral: '#1E293B' };
const STATUS_OPTIONS = [
  { value: 'all', label: 'All Statuses' },
  { value: 'running', label: 'Running' },
  { value: 'idle', label: 'Idle' },
  { value: 'stopped', label: 'Stopped' },
  { value: 'network', label: 'Signal Lost' },
  { value: 'offline', label: 'Offline' },
];

const SORT_OPTIONS = [
  { value: 'process', label: 'Sort: Process order' },
  { value: 'name', label: 'Sort: Name (fixed order)' },
  { value: 'status', label: 'Sort: Status (running first)' },
  { value: 'production', label: 'Sort: Production ↓' },
  { value: 'efficiency', label: 'Sort: Efficiency ↑' },
];

// Numeric values whose (non-raw) key matches — same matching idea as headline.ts:
// separators normalized to spaces so \b patterns work on keys like "part_count".
function metricVals(params: Record<string, unknown>, re: RegExp): number[] {
  const out: number[] = [];
  for (const [k, v] of Object.entries(params)) {
    if (isRawAddress(k)) continue;
    const n = Number(v);
    if (Number.isFinite(n) && re.test(paramLabel(k).toLowerCase().replace(/[._/\-]+/g, ' '))) out.push(n);
  }
  return out;
}

// Card ordering: running+live → running → idle+live → idle → stopped → offline
// (within each status, machines with fresh data come first).
const STATUS_RANK: Record<string, number> = { running: 0, idle: 1, stopped: 2, network: 3, offline: 4 };
const rank = (status: string, live: boolean) => (STATUS_RANK[status] ?? 3) * 2 + (live ? 0 : 1);

function tallyActivity(rows: MachineActivityRow[]) {
  const c = { total: rows.length, running: 0, idle: 0, stopped: 0, offline: 0 };
  for (const r of rows) {
    if (r.status === 'running') c.running += 1;
    else if (r.status === 'idle') c.idle += 1;
    else if (r.status === 'stopped') c.stopped += 1;
    else c.offline += 1;
  }
  return c;
}

export default function Machines() {
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('all');
  const [sortBy, setSortBy] = useState('process');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  // Parameters open as a modal RIGHT HERE — no navigation to the machine page.
  const [paramsFor, setParamsFor] = useState<Machine | null>(null);
  const live = useDashboardLive();
  const rangeActive = !!from && !!to && new Date(from) < new Date(to);

  const { data, isLoading } = useQuery({
    queryKey: ['machines', search],
    queryFn: () => machineApi.list({ search, limit: 100 }),
    refetchInterval: 10000,
  });

  // Historical range view — read-only reconstruction from telemetry + downtime.
  const { data: actData, isLoading: actLoading } = useQuery({
    queryKey: ['machine-activity', from, to],
    queryFn: () => machineApi.activity({ from: new Date(from).toISOString(), to: new Date(to).toISOString() }),
    enabled: rangeActive,
  });

  // TODAY's activity per machine — one window drives the whole card:
  // uptime/idle/stopped/downtime tiles AND the "today +N pcs" production line.
  // The window is the PRODUCTION day (todayWindow: 07:00 -> 07:00, the boundary
  // the PLC itself stamps into SHIFT_DATE), the same one the machine Overview
  // and the Full-day filter use, so a card and the page it opens can never
  // disagree. `to` is minute-rounded for stable query keys.
  const { shifts: cfgShifts } = useAppConfig();
  const day = todayWindow(cfgShifts);
  const dayFromISO = day.from.toISOString();
  const dayToISO = day.to.toISOString();
  const { data: dayAct } = useQuery({
    queryKey: ['machine-activity-today', dayFromISO, dayToISO],
    queryFn: () => machineApi.activity({ from: dayFromISO, to: dayToISO }),
    placeholderData: keepPreviousData,
    refetchInterval: 60000,
  });
  const actBy = new Map((dayAct?.data || []).map((r) => [r.code, r]));

  const allMachines = data?.data || [];

  // Staleness is a function of wall-clock time; re-render every 30s so machines that
  // stop reporting actually lose their "live" rank even when no data/tick arrives.
  const [, tick] = useReducer((x: number) => x + 1, 0);
  useEffect(() => {
    const t = setInterval(tick, 30_000);
    return () => clearInterval(t);
  }, []);

  // Filter, sort, and the card's pill all read the same tick-aware status.
  const displayStatus = (m: Machine) =>
    effectiveStatus({ status: live[m.code || m._id]?.status || m.status, lastReadingAt: m.lastReadingAt });
  const machineRank = (m: Machine) =>
    rank(displayStatus(m), !isStale(live[m.code || m._id]?.lastReadingAt || m.lastReadingAt));

  // Sort comparators. Machines missing the metric sink to the bottom in both directions.
  const paramsOf = (m: Machine) => {
    const cp = live[m.code || m._id]?.currentParameters || m.currentParameters || {};
    // currentParameters arrives raw/nested from ingest + socket — flatten so
    // dotted signals (named.*, active.*) are actually seen.
    return flattenParams(Object.keys(cp).length ? cp : m.latestData || {});
  };
  // ONE most-specific counter via the shared picker — never a sum (cycle +
  // workpiece is not production), matching the card headline exactly.
  const productionOf = (m: Machine) => {
    const v = productionValue(paramsOf(m));
    return v != null ? v : (typeof m.totalOutput === 'number' ? m.totalOutput : -1);
  };
  const efficiencyOf = (m: Machine) => {
    const v = metricVals(paramsOf(m), /efficiency|oee/);
    return v.length ? v[0] : (typeof m.oee === 'number' ? m.oee : Number.POSITIVE_INFINITY);
  };
  const SORTS: Record<string, (a: Machine, b: Machine) => number> = {
    // Production-flow order: cutting → SPG (numeric) → furnaces → the rest.
    process: (a, b) => processCompare(a, b),
    status: (a, b) => machineRank(a) - machineRank(b),
    name: (a, b) => String(a.code || a.machineId || a.name || '').localeCompare(String(b.code || b.machineId || b.name || '')),
    production: (a, b) => productionOf(b) - productionOf(a), // ↓ highest first
    efficiency: (a, b) => efficiencyOf(a) - efficiencyOf(b), // ↑ lowest first
  };
  const machines = (status === 'all' ? allMachines : allMachines.filter((m) => displayStatus(m) === status))
    .slice()
    .sort(SORTS[sortBy] || SORTS.status);



  const q = search.trim().toLowerCase();
  // Only machines that actually EXISTED in the range (sent data or had recorded
  // spans) — a machine registered later must not pad the table with dashes.
  const rawRangeRows = actData?.data || [];
  const activeRangeRows = rawRangeRows.filter((r) => r.live || r.runningMs + r.idleMs + r.stoppedMs + r.offlineMs > 0);
  const inactiveInRange = rawRangeRows.length - activeRangeRows.length;
  const activityRows = activeRangeRows
    .filter((r) => status === 'all' || r.status === status)
    .filter((r) => !q || r.code.toLowerCase().includes(q) || r.name.toLowerCase().includes(q) || (r.type || '').toLowerCase().includes(q))
    .slice()
    .sort(sortBy === 'name'
      ? (a, b) => a.code.localeCompare(b.code)
      : sortBy === 'production'
        ? (a, b) => (b.production ?? -1) - (a.production ?? -1)
        : (a, b) => rank(a.status, a.live) - rank(b.status, b.live));

  // While the range reconstruction is in flight, keep the live counts up instead of
  // flashing a zero-machine factory.
  const counts = rangeActive && actData ? tallyActivity(activeRangeRows) : statusCounts(allMachines);

  return (
    <div>
      <PageHeader
        title="Machines"
        subtitle={rangeActive ? `${counts.total} machines · ${fmtTime(from)} → ${fmtTime(to)}` : `${counts.total} registered`}
        live={Object.keys(live).length}
      />

      {paramsFor && (
        <ParametersModal
          machine={paramsFor}
          code={String(paramsFor.code || paramsFor.machineId || paramsFor._id)}
          onClose={() => setParamsFor(null)}
        />
      )}

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
          <select
            value={status}
            onChange={(e) => setStatus(e.target.value)}
            className={`rounded-xl border px-3 py-2.5 text-sm outline-none cursor-pointer transition-colors hover:border-accent/40 ${
              status !== 'all' ? 'border-accent/40 bg-accent/5 text-accent font-medium' : 'border-line bg-base text-primary'
            }`}
            title="Filter by status"
          >
            {STATUS_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
          <select
            value={sortBy}
            onChange={(e) => setSortBy(e.target.value)}
            className="rounded-xl border border-line bg-base px-3 py-2.5 text-sm text-primary outline-none cursor-pointer transition-colors hover:border-accent/40"
            title="Sort machines"
          >
            {SORT_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
          {/* Date/time range — switches the page to a historical "who was running when" view */}
          <div className={`flex items-center gap-1.5 rounded-xl border px-2.5 py-1.5 ${rangeActive ? 'border-accent/40 bg-accent/5' : 'border-line bg-base'}`}>
            <Calendar size={14} className={rangeActive ? 'text-accent' : 'text-steel'} />
            <input
              type="datetime-local"
              value={from}
              max={to || undefined}
              onChange={(e) => setFrom(e.target.value)}
              className="bg-transparent outline-none text-xs text-primary"
              title="From"
            />
            <span className="text-steel text-xs">→</span>
            <input
              type="datetime-local"
              value={to}
              min={from || undefined}
              onChange={(e) => setTo(e.target.value)}
              className="bg-transparent outline-none text-xs text-primary"
              title="To"
            />
            {(from || to) && (
              <button onClick={() => { setFrom(''); setTo(''); }} title="Clear range" className="text-steel hover:text-accent transition-colors">
                <X size={13} />
              </button>
            )}
          </div>
          <button
            onClick={() => { setSearch(''); setStatus('all'); setSortBy('process'); setFrom(''); setTo(''); }}
            title="Reset filters"
            className="w-10 h-10 flex items-center justify-center rounded-xl border border-line text-steel hover:text-accent hover:border-accent/40 transition-colors shrink-0"
          >
            <Filter size={16} />
          </button>
        </div>

        {rangeActive ? (
          actLoading ? (
            <div className="panel p-12 text-center text-sm text-steel">Reconstructing machine states for the selected range…</div>
          ) : activityRows.length === 0 ? (
            <div className="panel p-12 text-center">
              <Layers size={28} className="text-steel/40 mx-auto mb-3" />
              <div className="text-sm text-steel">No machines match the current filter in this range.</div>
            </div>
          ) : (
            <>
            <div className="panel overflow-x-auto">
              <table className="w-full text-sm min-w-[860px]">
                <thead>
                  <tr className="text-left text-[10px] uppercase tracking-wide text-steel border-b border-line">
                    <th className="px-4 py-3">Machine</th>
                    <th className="px-4 py-3">State in range</th>
                    <th className="px-4 py-3">Data</th>
                    <th className="px-4 py-3">Production</th>
                    <th className="px-4 py-3">Running</th>
                    <th className="px-4 py-3">Idle</th>
                    <th className="px-4 py-3">Stopped</th>
                    <th className="px-4 py-3">Offline</th>
                    <th className="px-4 py-3" />
                  </tr>
                </thead>
                <tbody>
                  {activityRows.map((r) => (
                    <tr key={r.code} className="border-b border-line/60 last:border-0 hover:bg-base/60 transition-colors">
                      <td className="px-4 py-3">
                        <Link to={`/machines/${r.code}`} className="data font-bold text-xs text-primary hover:text-accent transition-colors">
                          {r.code.toUpperCase()}
                        </Link>
                        {r.name.toUpperCase() !== r.code.toUpperCase() && (
                          <div className="text-[10px] text-steel truncate max-w-[180px]">{r.name}</div>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2">
                          <StatusPill status={r.status} />
                          {r.live && (
                            <span className="inline-flex items-center gap-1 text-[10px] text-accent font-medium">
                              <span className="w-1.5 h-1.5 rounded-full bg-accent" /> Live data
                            </span>
                          )}
                        </div>
                      </td>
                      <td className="px-4 py-3 text-xs">
                        {r.readings > 0 ? (
                          <>
                            <span className="data font-semibold text-primary">{fmtCompact(r.readings)}</span>
                            <span className="text-steel"> readings</span>
                            <div className="text-[10px] text-steel/80">{fmtTime(r.firstSeen)} → {fmtTime(r.lastSeen)}</div>
                          </>
                        ) : (
                          <span className="text-steel">No data</span>
                        )}
                      </td>
                      {/* Production made WITHIN the range = counter delta (first→last reading) */}
                      <td className="px-4 py-3 text-xs">
                        {r.production != null ? (
                          <>
                            <span className="data font-semibold text-running">{fmtNum(r.production)}</span>
                            <span className="text-steel"> pcs</span>
                            {(borrowedFrom(r) || r.productionKey) && (
                              <div className="text-[10px] text-steel/80 truncate max-w-[120px]">
                                {borrowedFrom(r) ?? prettyKey(r.productionKey as string)}
                              </div>
                            )}
                          </>
                        ) : (
                          <span className="text-steel">—</span>
                        )}
                      </td>
                      {/* fmtDuration rounds to whole minutes — below 30s it would print a confusing "0m" */}
                      <td className="px-4 py-3 data text-xs text-primary">{r.runningMs >= 30_000 ? fmtDuration(r.runningMs) : '—'}</td>
                      <td className="px-4 py-3 data text-xs text-primary">{r.idleMs >= 30_000 ? fmtDuration(r.idleMs) : '—'}</td>
                      <td className="px-4 py-3 data text-xs text-primary">{r.stoppedMs >= 30_000 ? fmtDuration(r.stoppedMs) : '—'}</td>
                      <td className="px-4 py-3 data text-xs text-primary">{r.offlineMs >= 30_000 ? fmtDuration(r.offlineMs) : '—'}</td>
                      <td className="px-4 py-3 text-right">
                        <Link
                          to={`/machines/${r.code}?tab=history`}
                          className="text-[10px] text-accent/80 hover:text-accent font-medium inline-flex items-center gap-0.5 transition-colors"
                        >
                          History <ArrowRight size={11} />
                        </Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {inactiveInRange > 0 && (
              <div className="text-[11px] text-steel px-1">
                {inactiveInRange} machine{inactiveInRange === 1 ? '' : 's'} had no data or activity in this range and {inactiveInRange === 1 ? 'is' : 'are'} hidden.
              </div>
            )}
            </>
          )
        ) : isLoading ? (
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
            {machines.map((m) => {
              const ref = m.code || m.machineId || '';
              return (
                <MachineCard key={m.code || m._id} machine={m} liveTick={live[m.code || m._id]}
                  activity={actBy.get(ref)}
                  onParams={() => setParamsFor(m)} />
              );
            })}
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
  activity?: MachineActivityRow;        // rolling 24h uptime/downtime/idle
  onParams: () => void;                 // open the parameters modal IN PLACE
}

function MachineCard({ machine, liveTick, activity, onParams }: MachineCardProps) {
  const nav       = useNavigate();
  const cp        = liveTick?.currentParameters || machine.currentParameters || {};
  // Flatten — raw/nested socket payloads must not reach the card unflattened.
  const own       = flattenParams(Object.keys(cp).length ? cp : (machine.latestData || {}));
  const params    = own;
  const status    = effectiveStatus({ status: liveTick?.status || machine.status, lastReadingAt: liveTick?.lastReadingAt || machine.lastReadingAt });
  const lastSeen  = liveTick?.lastReadingAt || machine.lastReadingAt;
  const id        = machine.code || machine._id;
  const code      = machine.code || machine.machineId || machine.name || '—';
  const nameLabel = machine.name || machine.machineName;
  const showName  = !!nameLabel && String(nameLabel).toUpperCase() !== String(code).toUpperCase();
  const typeLabel = machine.type || machine.machineType;
  const prettyT   = typeLabel && typeLabel !== 'UNKNOWN' ? prettyType(typeLabel) : null;

  // Custom (user-editable) display name — local presentation layer, same store the
  // Configure tab uses. The machine-sent code stays visible in small font below,
  // since that identity can't be changed from here.
  const mkey = machineKey(machine);
  const cfg = useMachineConfig(mkey);
  const customName = (cfg.displayName || '').trim();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const startEdit = (e: React.MouseEvent) => {
    e.preventDefault(); e.stopPropagation();
    setDraft(customName); setEditing(true);
  };
  const commitEdit = () => {
    const name = draft.trim();
    saveConfig(mkey, { ...getConfig(mkey), displayName: name || undefined });
    setEditing(false);
  };

  const title = customName || String(code).toUpperCase();
  // Only real values — no "UNKNOWN · —" placeholder; the line appears once data arrives.
  const subtitle  = [
    customName ? String(code).toUpperCase() : (showName ? nameLabel : null),
    prettyT,
  ].filter(Boolean).join(' · ');

  // Signal-mapping awareness — honest "what's live vs what still needs mapping".
  const sigEntries = Object.entries(params).filter(([k]) => k.toLowerCase() !== 'status');
  const sigTotal   = sigEntries.length;
  const rawCount   = sigEntries.filter(([k]) => isRawAddress(k)).length;
  const namedCount = sigTotal - rawCount;
  const liveCount  = sigEntries.filter(([, v]) => (isNumeric(v) && Number(v) !== 0) || (typeof v === 'string' && v.trim() !== '')).length;
  const rawOnly    = sigTotal > 0 && namedCount === 0;

  // A furnace makes heat, not pieces: its live work-zone temperature IS the
  // headline, and it must win over computeHeadline's generic rules — those skip
  // T1…T4 as S7 timer addresses, which is right everywhere EXCEPT a furnace.
  // `params` is the live socket reading, so this number moves with the furnace.
  //
  // A furnace ALWAYS shows Temperature, even with nothing to show. Falling back
  // to the generic "Signals Tracked · 356 unmapped raw signals" answers a
  // question nobody asked and hides the one that matters: this furnace is not
  // reporting a temperature. "—" says that; a signal count does not.
  const furnace = isFurnaceRef(code);
  const liveTemp = furnace ? temperatureNow(params, code) : null;
  const headline: Headline | null = furnace
    ? {
      label: 'Temperature',
      value: liveTemp != null ? fmtNum(liveTemp) : '—',
      unit: liveTemp != null ? '°C' : undefined,
      sub: liveTemp != null ? undefined : 'no temperature signal from the PLC',
      tone: 'neutral',
    }
    : computeHeadline(params);
  const hero: Headline = headline ?? {
    label: 'Signals Tracked',
    value: fmtCompact(sigTotal),
    tone: 'neutral',
    sub: 'unmapped raw signals',
  };

  // What a supervisor walks up to the board for is TODAY, not the lifetime
  // counter: "made 19 today" is the shift's answer, "the counter reads 25" is
  // trivia — and on a machine whose counter resets each shift, the big number
  // was the reset value anyway. So today's pieces are the headline and the raw
  // counter drops to the sub-line. Furnaces keep their live temperature: heat
  // now is the thing you act on, and their day-average already sits below it.
  const madeToday = furnace ? null : activity?.production ?? null;
  const counterNow = furnace ? null : productionValue(params);
  const dayHero: Headline | null = madeToday == null ? null : {
    label: 'Production · Today',
    value: fmtNum(madeToday),
    unit: 'pcs',
    tone: madeToday > 0 ? 'good' : 'neutral',
    // A borrowed count says so instead of quoting a counter this machine
    // doesn't have.
    sub: borrowedFrom(activity) ?? (counterNow != null ? `counter reads ${fmtNum(counterNow)}` : undefined),
  };
  const show = dayHero ?? hero;

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

  return (
    <Link
      to={`/machines/${id}`}
      className="card p-4 flex flex-col transition-all hover:shadow-md hover:border-accent/30 hover:-translate-y-0.5 group"
    >
      {/* Header */}
      <div className="flex items-start justify-between gap-2 mb-3">
        <div className="min-w-0">
          {editing ? (
            <input
              autoFocus
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onClick={(e) => { e.preventDefault(); e.stopPropagation(); }}
              onBlur={commitEdit}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commitEdit();
                if (e.key === 'Escape') setEditing(false);
              }}
              placeholder={String(code).toUpperCase()}
              className="data font-bold text-sm text-primary bg-base border border-accent/40 rounded px-1.5 py-0.5 outline-none w-full max-w-[180px]"
            />
          ) : (
            <div className="flex items-center gap-1.5 min-w-0">
              <div className="data font-bold text-sm text-primary group-hover:text-accent transition-colors truncate" title={customName ? `Custom name · machine sends "${String(code).toUpperCase()}"` : undefined}>
                {title}
              </div>
              <button onClick={startEdit} title="Set custom name" className="shrink-0 text-steel/40 hover:text-accent transition-colors opacity-0 group-hover:opacity-100">
                <Pencil size={12} />
              </button>
            </div>
          )}
          {subtitle && <div className="text-[11px] text-steel mt-0.5 truncate">{subtitle}</div>}
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
          <div className="text-[10px] uppercase tracking-wide text-steel">{show.label}</div>
          <div className="flex items-baseline gap-1">
            <span className="data text-2xl font-bold leading-none" style={{ color: HEADLINE_TONE[show.tone] }}>{show.value}</span>
            {show.unit && <span className="text-sm font-medium text-steel">{show.unit}</span>}
          </div>
          {show.sub && <div className="text-[10px] text-steel mt-0.5 truncate">{show.sub}</div>}
          {/* On a furnace the day-average sits under the live reading. */}
          {furnace && activity?.avgTemp != null && (
            <div className="text-[10px] mt-1">
              <span className="text-steel">today avg </span>
              <span className="data font-bold text-idle">{fmtNum(activity.avgTemp)}</span>
              <span className="text-steel"> °C</span>
            </div>
          )}
        </div>
        {trend && trend.spark.length > 1 && (
          <div className="w-28 h-12 shrink-0 self-center"><Sparkline data={trend.spark} height={48} color={TEAL} /></div>
        )}
      </div>

      {/* TODAY's breakdown: uptime, idle, stopped, and the downtime TOTAL
          (idle + stopped + signal-lost). */}
      <div className="mt-auto grid grid-cols-4 gap-1.5">
        <TimeStat label="Uptime" ms={activity?.runningMs} color={TEAL} />
        <TimeStat label="Idle" ms={activity?.idleMs} color={AMBER} />
        <TimeStat label="Stopped" ms={activity?.stoppedMs} color={RED} />
        <TimeStat label="Downtime" ms={activity ? activity.idleMs + activity.stoppedMs : undefined} color="#991B1B" />
      </div>

      {/* Footer — the card is a summary; deep views live behind these links */}
      <div className="mt-2.5 pt-2.5 border-t border-line flex items-center justify-between gap-2 text-[10px]">
        <span className="text-steel/70 truncate">{fmtTime(lastSeen)}</span>
        <span className="flex items-center gap-3 shrink-0">
          <span
            role="link" tabIndex={0}
            onClick={(e) => { e.preventDefault(); e.stopPropagation(); nav(`/machines/${id}?tab=history`); }}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); nav(`/machines/${id}?tab=history`); } }}
            className="inline-flex items-center gap-0.5 text-accent/80 font-medium group-hover:text-accent transition-colors cursor-pointer"
          >
            View History <ArrowRight size={11} className="transition-transform group-hover:translate-x-0.5" />
          </span>
          <span
            role="button" tabIndex={0}
            onClick={(e) => { e.preventDefault(); e.stopPropagation(); onParams(); }}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); onParams(); } }}
            className="inline-flex items-center gap-1 px-2 py-1 rounded-md border border-line text-steel hover:text-accent hover:border-accent/40 font-medium transition-colors cursor-pointer"
            title="View parameters (opens here)"
          >
            <Eye size={11} /> Parameters
          </span>
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
