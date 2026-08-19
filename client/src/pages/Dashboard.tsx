// client/src/pages/Dashboard.tsx — fleet ANALYSIS console (aggregate insights, not re-lists)
// Every metric derives from ONE shared filter selection (machine / shift / date
// range, store/filters). "All machines" shows fleet analytics + performance
// rankings; picking a machine scopes every panel to it. Range KPIs (production,
// runtime, downtime, availability) are reconstructed server-side from telemetry
// + downtime spans — never fabricated; OEE stays honest ("needs signals").
import { useState, useMemo, type ReactNode } from 'react';
import { useQuery, keepPreviousData } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import type { LucideIcon } from 'lucide-react';
import {
  ShieldCheck, Radio, Bell, AlertTriangle, CheckCircle2,
  Database, Gauge, Clock, ArrowUpRight,
  Cpu, Play, Pause, CircleSlash, Power,
  Sparkles, Wrench, TrendingUp, Zap,
  Factory, Timer, CalendarClock, Trophy, TrendingDown, RotateCcw,
} from 'lucide-react';
import { dashboardApi, machineApi } from '../api/endpoints';
import PageHeader from '../components/PageHeader';
import AnalyticsModal from '../components/AnalyticsModal';
import { Donut, Legend } from '../components/charts';
import { fmtNum, fmtDuration, fmtTime } from '../lib/format';
import { prettyType } from '../lib/format';
import { useDashboardLive } from '../hooks/useLive';
import { useFilters, resolveRange, shiftApplies, DATE_PRESETS } from '../store/filters';
import { useAppConfig } from '../hooks/useAppConfig';
import type { RankingRow } from '../types/api';

const TEAL = '#0D9488', AMBER = '#D97706', RED = '#DC2626', STEEL = '#64748B', SLATE = '#94A3B8', INDIGO = '#6366F1', VIOLET = '#8B5CF6';

export default function Dashboard() {
  const live = useDashboardLive();
  const { shifts } = useAppConfig();   // shared server-side shift config
  const f = useFilters();

  // Shared filter selection → one concrete window every query below uses.
  const range = resolveRange(f, shifts);
  const fromISO = range?.from.toISOString();
  const toISO = range?.to.toISOString();

  const { data: ov } = useQuery({
    queryKey: ['dashboard', 'overview', f.machineId, fromISO, toISO],
    queryFn: () => dashboardApi.overview({
      machineId: f.machineId || undefined, from: fromISO, to: toISO,
    }).then((r) => r.data),
    refetchInterval: 10000,
    placeholderData: keepPreviousData,
  });

  // Machine selector options — the real machine dataset, not a hard-coded list.
  const { data: machineList } = useQuery({
    queryKey: ['machines', 'selector'],
    queryFn: () => machineApi.list({ limit: 200, sort: 'name' }).then((r) => r.data),
    staleTime: 60_000,
  });

  // Performance rankings — fleet view only (a single machine has no ranking).
  const { data: rankData } = useQuery({
    queryKey: ['dashboard', 'rankings', fromISO, toISO],
    queryFn: () => dashboardApi.rankings({ from: fromISO, to: toISO }).then((r) => r.data),
    enabled: !f.machineId,
    refetchInterval: 60000,
    placeholderData: keepPreviousData,
  });

  const fleet     = ov?.fleet     || { total: 0, running: 0, idle: 0, stopped: 0, offline: 0 };
  const health    = ov?.health    || { healthy: 0, warning: 0, critical: 0, offline: 0, avgScore: 0 };
  const alerts    = ov?.alerts    || { total: 0, critical: 0, warning: 0, info: 0, byCategory: {} as Record<string, number> };
  const signals   = ov?.signals   || { named: 0, io: 0, registers: 0, mapped: 0, total: 0, mappedPct: 0 };
  const reporting = ov?.reporting || { reporting: 0, live: 0, total: 0 };
  const win       = ov?.window;
  const [drill, setDrill] = useState<string | null>(null);

  const selectedMachine = f.machineId
    ? (machineList || []).find((m) => (m.code || m.machineId) === f.machineId)
    : null;
  const scopeLabel = f.machineId
    ? `${String(f.machineId).toUpperCase()}`
    : 'All machines';
  const windowLabel = f.shiftName && shiftApplies(f.preset)
    ? `${f.shiftName} · ${DATE_PRESETS.find((p) => p.value === f.preset)?.label}`
    : DATE_PRESETS.find((p) => p.value === f.preset)?.label || '';

  // Operational status mix (from machine.status) — the at-a-glance fleet state.
  const statusSeg = [
    { key: 'running', label: 'Running', value: fleet.running || 0, color: TEAL },
    { key: 'idle',    label: 'Idle',    value: fleet.idle || 0,    color: AMBER },
    { key: 'stopped', label: 'Stopped', value: fleet.stopped || 0, color: RED },
    { key: 'offline', label: 'Offline', value: fleet.offline || 0, color: SLATE },
  ].filter((s) => s.value > 0);

  // Freshest reading across the selection — "last updated" for the dashboard.
  const lastReading = useMemo(() => {
    const ts = (ov?.machines || []).map((m) => m.lastSeenAt).filter(Boolean).map((t) => new Date(t as string).getTime());
    return ts.length ? Math.max(...ts) : null;
  }, [ov]);
  const lastIsLive = lastReading != null && (Date.now() - lastReading) <= 120_000;

  // Carry each machine's TRUE rank; the bottom list never overlaps the top list
  // (small fleets: whatever isn't in the top 10 — possibly nothing).
  const rankings = ((rankData || []) as RankingRow[]).map((r, i) => ({ ...r, rank: i + 1 }));
  const top10 = rankings.slice(0, 10);
  const bottom10 = rankings.slice(Math.max(10, rankings.length - 10)).reverse();

  return (
    <div>
      <PageHeader
        title="Dashboard" subtitle={`${scopeLabel} · ${windowLabel}`} live={Object.keys(live).length}
        right={(
          <div className="flex items-center gap-2">
            {lastReading && (
              <span className={`inline-flex items-center gap-1 text-[11px] font-bold ring-1 rounded-md px-2 py-0.5 ${lastIsLive ? 'text-running bg-running/10 ring-running/20' : 'text-stopped bg-stopped/10 ring-stopped/20'}`} title="Most recent reading across the selection">
                <Clock size={11} /> {fmtTime(lastReading)}
              </span>
            )}
            {alerts.total > 0 && (
              <Link to="/alerts" className="flex items-center gap-1.5 pill bg-stopped/10 text-stopped hover:bg-stopped/15 transition-colors">
                <Bell size={12} /> {alerts.total} alert{alerts.total > 1 ? 's' : ''}
              </Link>
            )}
          </div>
        )}
      />

      <div className="px-4 sm:px-6 pb-8 space-y-5 pt-5">
        {/* Shared filters — every metric below derives from this one selection */}
        <div className="panel p-3 flex items-center gap-2 flex-wrap">
          <select
            value={f.machineId}
            onChange={(e) => f.set({ machineId: e.target.value })}
            className={`rounded-xl border px-3 py-2 text-sm outline-none cursor-pointer transition-colors hover:border-accent/40 max-w-[240px] ${f.machineId ? 'border-accent/40 bg-accent/5 text-accent font-medium' : 'border-line bg-base text-primary'}`}
            title="Scope the dashboard to one machine"
          >
            <option value="">All Machines</option>
            {(machineList || []).map((m) => {
              const code = m.code || m.machineId || m._id;
              return <option key={code} value={code}>{String(code).toUpperCase()}{m.type ? ` · ${prettyType(m.type)}` : ''}</option>;
            })}
          </select>

          <select
            value={f.preset}
            onChange={(e) => f.set({ preset: e.target.value as typeof f.preset })}
            className="rounded-xl border border-line bg-base px-3 py-2 text-sm text-primary outline-none cursor-pointer hover:border-accent/40 transition-colors"
          >
            {DATE_PRESETS.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
          </select>

          {f.preset === 'custom' && (
            <>
              <input type="datetime-local" value={f.customFrom} onChange={(e) => f.set({ customFrom: e.target.value })}
                className="rounded-xl border border-line bg-base px-3 py-2 text-sm text-primary outline-none focus:border-accent" />
              <span className="text-steel text-xs">→</span>
              <input type="datetime-local" value={f.customTo} onChange={(e) => f.set({ customTo: e.target.value })}
                className="rounded-xl border border-line bg-base px-3 py-2 text-sm text-primary outline-none focus:border-accent" />
            </>
          )}

          <select
            value={shiftApplies(f.preset) ? f.shiftName : ''}
            onChange={(e) => f.set({ shiftName: e.target.value })}
            disabled={!shiftApplies(f.preset)}
            className={`rounded-xl border px-3 py-2 text-sm outline-none cursor-pointer transition-colors hover:border-accent/40 disabled:opacity-45 disabled:cursor-not-allowed ${f.shiftName && shiftApplies(f.preset) ? 'border-accent/40 bg-accent/5 text-accent font-medium' : 'border-line bg-base text-primary'}`}
            title={shiftApplies(f.preset) ? 'Scope to a shift window' : 'Shift filtering applies to Today / Yesterday'}
          >
            <option value="">All Shifts</option>
            {shifts.map((sh) => <option key={sh.name} value={sh.name}>{sh.name} · {sh.start}–{sh.end}</option>)}
          </select>

          {(f.machineId || f.shiftName || f.preset !== 'today') && (
            <button onClick={f.reset} title="Reset filters"
              className="w-9 h-9 flex items-center justify-center rounded-xl border border-line text-steel hover:text-accent hover:border-accent/40 transition-colors shrink-0">
              <RotateCcw size={14} />
            </button>
          )}

          {f.preset === 'custom' && !range && (
            <span className="text-[11px] text-amber-600">Pick a valid start & end to apply the range.</span>
          )}
        </div>

        {/* Operational status — the live state of the selection at a glance */}
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
          <StatusTile label={f.machineId ? 'Machines (selected)' : 'Total Machines'} value={fmtNum(fleet.total || 0)} color={INDIGO} icon={Cpu} tint="rgba(99,102,241,0.06)" />
          <StatusTile label="Running" value={fmtNum(fleet.running || 0)} color={TEAL} icon={Play} tint="rgba(13,148,136,0.07)" />
          <StatusTile label="Idle" value={fmtNum(fleet.idle || 0)} color={AMBER} icon={Pause} tint="rgba(217,119,6,0.06)" />
          <StatusTile label="Stopped" value={fmtNum(fleet.stopped || 0)} color={fleet.stopped ? RED : STEEL} icon={CircleSlash} tint="rgba(220,38,38,0.06)" />
          <StatusTile label="Offline" value={fmtNum(fleet.offline || 0)} color={fleet.offline ? STEEL : TEAL} icon={Power} tint="rgba(100,116,139,0.06)" />
        </div>

        {/* Window KPIs — real reconstructed figures for the selected range */}
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
          <Kpi label="Production" value={win ? `${fmtNum(win.production)} pcs` : '—'}
            sub={win ? `${win.reported} of ${win.machines} reported` : 'No data in range'} color={TEAL} icon={Factory} />
          <Kpi label="Runtime" value={win ? fmtDuration(win.runningMs) : '—'}
            sub={win ? `across ${win.machines} machine${win.machines === 1 ? '' : 's'}` : undefined} color={TEAL} icon={Timer} />
          <Kpi label="Downtime" value={win ? fmtDuration(win.downtimeMs) : '—'}
            sub={win ? `idle ${fmtDuration(win.idleMs)}` : undefined} color={win?.downtimeMs ? RED : STEEL} icon={Clock} />
          <Kpi label="Availability" value={win ? `${win.availabilityPct}%` : '—'}
            sub="running ÷ window" color={win && win.availabilityPct >= 75 ? TEAL : win && win.availabilityPct >= 50 ? AMBER : RED} icon={CalendarClock} />
          <Kpi label="OEE" value="—" sub="needs cycle + quality signals" color={STEEL} icon={Gauge} />
        </div>

        {/* Analytical KPIs */}
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
          <Kpi label="Fleet Health"  value={`${health.avgScore}%`} sub={`${health.critical} critical · ${health.warning} warn`} color={health.avgScore >= 80 ? TEAL : health.avgScore >= 50 ? AMBER : RED} icon={ShieldCheck} />
          <Kpi label="Signal Coverage" value={`${signals.mappedPct}%`} sub={`${fmtNum(signals.mapped)} of ${fmtNum(signals.total)} mapped`} color={INDIGO} icon={Database} />
          <Kpi label="Reporting"     value={`${reporting.reporting}/${reporting.total}`} sub={`${reporting.live} live now`} color={TEAL} icon={Radio} />
          <Kpi label="Active Alerts" value={fmtNum(alerts.total)} sub={`${alerts.critical} crit · ${alerts.warning} warn`} color={alerts.critical ? RED : alerts.warning ? AMBER : TEAL} icon={AlertTriangle} />
          <Kpi label="Downtime events" value={fmtNum(ov?.downtime?.events || 0)} sub={`${fmtDuration(ov?.downtime?.totalMs)} in window`} color={AMBER} icon={Clock} />
        </div>

        {/* Status + health + alerts — each drills into per-machine detail */}
        <div className="grid lg:grid-cols-3 gap-5">
          <Panel title="Machine Status" subtitle={`${fleet.total} machine${fleet.total === 1 ? '' : 's'} · ${fleet.running} running now`} icon={Cpu} onClick={() => setDrill('status')}>
            <div className="flex items-center gap-4">
              <Donut segments={statusSeg} size={128} thickness={16} emptyColor={SLATE}>
                <span className="data text-2xl font-bold text-primary leading-none">{fmtNum(fleet.total || 0)}</span>
                <span className="label mt-1">machine{fleet.total === 1 ? '' : 's'}</span>
              </Donut>
              <div className="flex-1 min-w-0">
                {statusSeg.length === 0
                  ? <div className="text-sm text-steel">No machines in scope.</div>
                  : <Legend rows={statusSeg} total={fleet.total} format={(v) => fmtNum(v)} scroll={false} />}
              </div>
            </div>
          </Panel>

          <Panel title="Health Distribution" subtitle={`Avg score ${health.avgScore}/100`} icon={ShieldCheck} onClick={() => setDrill('health')}>
            <StackBar segments={[
              { label: 'Healthy', value: health.healthy, color: TEAL },
              { label: 'Warning', value: health.warning, color: AMBER },
              { label: 'Critical', value: health.critical, color: RED },
              { label: 'Offline', value: health.offline, color: SLATE },
            ]} unit={fleet.total === 1 ? 'machine' : 'machines'} />
          </Panel>

          <Panel title="Alert Composition" subtitle={`${alerts.total} active in scope`} icon={AlertTriangle} onClick={() => setDrill('alerts')}>
            <CategoryBars data={[
              { label: 'Sensor faults', value: alerts.byCategory.fault || 0, color: RED },
              { label: 'Out of range', value: alerts.byCategory.range || 0, color: RED },
              { label: 'Set/actual drift', value: alerts.byCategory.deviation || 0, color: AMBER },
              { label: 'Stale (running, no data)', value: alerts.byCategory.stale || 0, color: AMBER },
              { label: 'Offline', value: alerts.byCategory.offline || 0, color: SLATE },
            ]} />
          </Panel>
        </div>

        {/* Performance rankings — fleet view only; click a row to select it */}
        {!f.machineId && (
          <div className="grid lg:grid-cols-2 gap-5">
            <RankPanel title="Top performers" icon={Trophy} color={TEAL} rows={top10}
              onPick={(code) => f.set({ machineId: code })} />
            <RankPanel title="Needs attention" icon={TrendingDown} color={RED} rows={bottom10}
              emptyNote="All machines are already listed under Top performers."
              onPick={(code) => f.set({ machineId: code })} />
          </div>
        )}

        {/* Selected-machine shortcut row */}
        {f.machineId && (
          <div className="panel p-4 flex items-center gap-3 flex-wrap">
            <span className="text-sm text-steel">Viewing analytics for</span>
            <span className="data text-sm font-bold text-primary">{scopeLabel}</span>
            {selectedMachine?.type && <span className="pill bg-accent/10 text-accent !text-[10px]">{prettyType(selectedMachine.type)}</span>}
            <div className="ml-auto flex items-center gap-2">
              <Link to={`/machines/${f.machineId}`} className="text-xs text-accent hover:underline inline-flex items-center gap-1">Open machine <ArrowUpRight size={12} /></Link>
              <Link to={`/machines/${f.machineId}?tab=history`} className="text-xs text-accent hover:underline inline-flex items-center gap-1">View history <ArrowUpRight size={12} /></Link>
            </div>
          </div>
        )}

        {/* AI Insights — teaser for the upcoming prediction layer */}
        <div className="panel p-5" style={{ background: 'rgba(99,102,241,0.05)' }}>
          <div className="flex items-start gap-2.5 mb-4">
            <span className="w-9 h-9 rounded-xl flex items-center justify-center shrink-0 text-white" style={{ background: VIOLET }}><Sparkles size={18} /></span>
            <div>
              <div className="flex items-center gap-2">
                <h2 className="font-semibold text-sm text-primary">AI Insights</h2>
                <span className="pill !text-[9px] font-bold tracking-wider" style={{ background: 'rgba(139,92,246,0.12)', color: VIOLET }}>COMING SOON</span>
              </div>
              <p className="text-[11px] text-steel mt-0.5">Predictive maintenance, anomaly detection &amp; OEE forecasting — trained on your live telemetry.</p>
            </div>
          </div>
          <div className="grid sm:grid-cols-2 gap-3">
            <AiTile icon={Wrench} color={AMBER} title="Predictive maintenance" line="Service likely needed on:" value="FURNACE01 · 4 Sep" />
            <AiTile icon={TrendingUp} color={TEAL} title="OEE forecast" line="Projected next-shift OEE:" value="87%" />
            <AiTile icon={AlertTriangle} color={RED} title="Anomaly risk" line="Machines trending abnormal:" value="QUENCHFURN02" />
            <AiTile icon={Zap} color={VIOLET} title="Energy optimization" line="Estimated daily savings:" value="12,400 kWh" />
          </div>
          <div className="text-[10px] text-steel/70 mt-3 flex items-center gap-1"><Gauge size={11} /> Insights unlock once enough history is collected across the fleet.</div>
        </div>
      </div>

      {drill && ov && <AnalyticsModal dimension={drill} ov={ov} onClose={() => setDrill(null)} />}
    </div>
  );
}

// ── building blocks ──────────────────────────────────────────────────────────
// Performance ranking table — availability-based (the only officially derivable
// performance metric; OEE inputs don't exist and are never fabricated).
function RankPanel({ title, icon, color, rows, onPick, emptyNote }: { title: string; icon: LucideIcon; color: string; rows: (RankingRow & { rank: number })[]; onPick: (code: string) => void; emptyNote?: string }): JSX.Element {
  return (
    <Panel title={title} subtitle="availability over the selected window · click to inspect" icon={icon}>
      {rows.length === 0 ? (
        <div className="text-sm text-steel py-6 text-center">{emptyNote || 'No activity in the selected range.'}</div>
      ) : (
        <div className="overflow-x-auto -mx-1">
          <table className="w-full text-sm whitespace-nowrap">
            <thead>
              <tr className="text-steel">
                <th className="text-left label px-2 py-1.5">#</th>
                <th className="text-left label px-2 py-1.5">Machine</th>
                <th className="text-right label px-2 py-1.5">Avail.</th>
                <th className="text-right label px-2 py-1.5">Production</th>
                <th className="text-right label px-2 py-1.5">Runtime</th>
                <th className="text-right label px-2 py-1.5">Downtime</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.code} onClick={() => onPick(r.code)}
                  className="border-t border-line hover:bg-base/60 cursor-pointer">
                  <td className="px-2 py-2 data text-xs text-steel">{r.rank}</td>
                  <td className="px-2 py-2 data text-xs font-semibold text-primary">{String(r.code).toUpperCase()}</td>
                  <td className="px-2 py-2 data text-xs text-right font-semibold" style={{ color: r.availabilityPct >= 75 ? '#0D9488' : r.availabilityPct >= 50 ? '#D97706' : color }}>{r.availabilityPct}%</td>
                  <td className="px-2 py-2 data text-xs text-right">{r.production != null ? fmtNum(r.production) : <span className="text-steel/50">—</span>}</td>
                  <td className="px-2 py-2 data text-xs text-right">{fmtDuration(r.runningMs)}</td>
                  <td className="px-2 py-2 data text-xs text-right">{r.downtimeMs ? fmtDuration(r.downtimeMs) : '0m'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}

// Blurred placeholder values — real predictions land when the AI layer ships.
function AiTile({ icon: Icon, color, title, line, value }: { icon: LucideIcon; color: string; title: string; line: string; value: string }): JSX.Element {
  return (
    <div className="card px-4 py-3">
      <div className="flex items-center gap-2 mb-1">
        <span className="w-6 h-6 rounded-md flex items-center justify-center shrink-0" style={{ background: `${color}18`, color }}><Icon size={13} /></span>
        <span className="text-sm font-semibold text-primary">{title}</span>
      </div>
      <div className="text-xs text-steel">{line} <span className="blur-[3px] select-none font-medium text-primary" aria-hidden>{value}</span></div>
    </div>
  );
}

function Kpi({ label, value, sub, color, icon: Icon }: { label: string; value: ReactNode; sub?: ReactNode; color: string; icon?: LucideIcon }): JSX.Element {
  return (
    <div className="card p-3.5">
      <div className="flex items-center justify-between"><span className="label">{label}</span>{Icon && <Icon size={14} style={{ color }} />}</div>
      <div className="data text-xl font-bold mt-1.5 truncate" style={{ color }}>{value}</div>
      {sub && <div className="text-[10px] text-steel mt-0.5 truncate">{sub}</div>}
    </div>
  );
}

function StatusTile({ label, value, color, icon: Icon, tint }: { label: string; value: ReactNode; color: string; icon?: LucideIcon; tint?: string }): JSX.Element {
  return (
    <div className="card p-3.5" style={{ background: tint }}>
      <div className="flex items-center justify-between"><span className="label">{label}</span>{Icon && <Icon size={15} style={{ color }} />}</div>
      <div className="data text-2xl font-bold mt-1.5" style={{ color }}>{value}</div>
    </div>
  );
}

function Panel({ title, subtitle, icon: Icon, children, onClick }: { title: string; subtitle?: ReactNode; icon?: LucideIcon; children: ReactNode; onClick?: () => void }): JSX.Element {
  const clickable = !!onClick;
  return (
    <div
      onClick={onClick}
      role={clickable ? 'button' : undefined}
      tabIndex={clickable ? 0 : undefined}
      onKeyDown={clickable ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick?.(); } } : undefined}
      className={`panel p-5 ${clickable ? 'cursor-pointer transition-all hover:border-accent/40 hover:shadow-md group focus:outline-none focus:ring-2 focus:ring-accent/30' : ''}`}
    >
      <div className="flex items-start gap-2 mb-4">
        {Icon && <span className="w-7 h-7 rounded-lg bg-accent/10 flex items-center justify-center shrink-0"><Icon size={15} className="text-accent" /></span>}
        <div className="flex-1 min-w-0"><h2 className="font-semibold text-sm text-primary leading-tight">{title}</h2>{subtitle && <p className="text-[11px] text-steel mt-0.5">{subtitle}</p>}</div>
        {clickable && <span className="text-[10px] font-medium text-steel/40 group-hover:text-accent transition-colors inline-flex items-center gap-0.5 shrink-0">Details <ArrowUpRight size={12} /></span>}
      </div>
      {children}
    </div>
  );
}

function StackBar({ segments, unit }: { segments: { label: string; value: number; color: string }[]; unit: string }): JSX.Element {
  const total = segments.reduce((s, x) => s + (x.value || 0), 0);
  if (!total) return <div className="text-sm text-steel py-4 text-center">No data.</div>;
  return (
    <div>
      <div className="flex h-3 rounded-full overflow-hidden bg-line">
        {segments.filter((s) => s.value > 0).map((s) => (
          <div key={s.label} style={{ width: `${(s.value / total) * 100}%`, background: s.color }} title={`${s.label}: ${s.value}`} />
        ))}
      </div>
      <div className="mt-3 space-y-1.5">
        {segments.map((s) => (
          <div key={s.label} className="flex items-center justify-between text-xs">
            <span className="flex items-center gap-2 text-steel"><span className="w-2.5 h-2.5 rounded-sm" style={{ background: s.color }} />{s.label}</span>
            <span className="data text-primary font-medium">{fmtNum(s.value)} <span className="text-steel/60">· {total ? Math.round((s.value / total) * 100) : 0}%</span></span>
          </div>
        ))}
      </div>
      <div className="text-[10px] text-steel/60 mt-2 pt-2 border-t border-line">{fmtNum(total)} {unit} total</div>
    </div>
  );
}

function CategoryBars({ data }: { data: { label: string; value: number; color: string }[] }): JSX.Element {
  const max = Math.max(...data.map((d) => d.value), 1);
  const any = data.some((d) => d.value > 0);
  if (!any) return <div className="text-sm text-running py-4 text-center flex items-center justify-center gap-1.5"><CheckCircle2 size={15} /> No active alerts.</div>;
  return (
    <div className="space-y-2.5">
      {data.map((d) => (
        <div key={d.label}>
          <div className="flex justify-between text-xs mb-1"><span className="text-steel">{d.label}</span><span className="data font-medium" style={{ color: d.value ? d.color : STEEL }}>{d.value}</span></div>
          <div className="h-1.5 bg-line rounded-full overflow-hidden"><div className="h-full rounded-full" style={{ width: `${(d.value / max) * 100}%`, background: d.color }} /></div>
        </div>
      ))}
    </div>
  );
}
