// client/src/pages/Dashboard.tsx — fleet ANALYSIS console (aggregate insights, not re-lists)
import { useState, useMemo, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import type { LucideIcon } from 'lucide-react';
import {
  ShieldCheck, Activity, Radio, Bell, AlertTriangle, CheckCircle2,
  Database, Layers, Gauge, Lock, Clock, ArrowUpRight, Users,
  Cpu, Play, Pause, CircleSlash, Power,
} from 'lucide-react';
import { dashboardApi } from '../api/endpoints';
import PageHeader from '../components/PageHeader';
import AnalyticsModal from '../components/AnalyticsModal';
import { Donut, Legend } from '../components/charts';
import { fmtNum, fmtDuration, fmtTime, prettyType } from '../lib/format';
import { useDashboardLive } from '../hooks/useLive';

const TEAL = '#0D9488', AMBER = '#D97706', RED = '#DC2626', STEEL = '#64748B', SLATE = '#94A3B8', INDIGO = '#6366F1', VIOLET = '#8B5CF6';

export default function Dashboard() {
  const live = useDashboardLive();
  const { data: ov } = useQuery({
    queryKey: ['dashboard', 'overview'],
    queryFn: () => dashboardApi.overview().then((r) => r.data),
    refetchInterval: 10000,
  });

  const fleet     = ov?.fleet     || { total: 0, running: 0, idle: 0, stopped: 0, offline: 0 };
  const health    = ov?.health    || { healthy: 0, warning: 0, critical: 0, offline: 0, avgScore: 0 };
  const alerts    = ov?.alerts    || { total: 0, critical: 0, warning: 0, info: 0, byCategory: {} as Record<string, number> };
  const signals   = ov?.signals   || { named: 0, io: 0, registers: 0, mapped: 0, total: 0, mappedPct: 0 };
  const reporting = ov?.reporting || { reporting: 0, live: 0, total: 0 };
  const caps      = ov?.capabilities || { live: [], blocked: [], liveCount: 0, total: 0 };
  const volume    = ov?.volume    || { totalReadings: 0, perDay: [], byType: [] };
  const team      = ov?.team      || { employees: 0, superAdmins: 0, roles: 0, byRole: [] };
  const [drill, setDrill] = useState<string | null>(null);

  // Operational status mix (from machine.status) — the at-a-glance fleet state.
  const statusSeg = [
    { key: 'running', label: 'Running', value: fleet.running || 0, color: TEAL },
    { key: 'idle',    label: 'Idle',    value: fleet.idle || 0,    color: AMBER },
    { key: 'stopped', label: 'Stopped', value: fleet.stopped || 0, color: RED },
    { key: 'offline', label: 'Offline', value: fleet.offline || 0, color: SLATE },
  ].filter((s) => s.value > 0);

  // Freshest reading across the whole fleet — "last updated" for the dashboard.
  const lastReading = useMemo(() => {
    const ts = (ov?.machines || []).map((m) => m.lastSeenAt).filter(Boolean).map((t) => new Date(t as string).getTime());
    return ts.length ? Math.max(...ts) : null;
  }, [ov]);
  const lastIsLive = lastReading != null && (Date.now() - lastReading) <= 120_000;

  return (
    <div>
      <PageHeader
        title="Dashboard" subtitle="Fleet data analysis & insights" live={Object.keys(live).length}
        right={(
          <div className="flex items-center gap-2">
            {lastReading && (
              <span className={`inline-flex items-center gap-1 text-[11px] font-bold ring-1 rounded-md px-2 py-0.5 ${lastIsLive ? 'text-running bg-running/10 ring-running/20' : 'text-stopped bg-stopped/10 ring-stopped/20'}`} title="Most recent reading across the fleet">
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
        {/* Operational status — the live fleet state at a glance */}
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
          <StatusTile label="Total Machines" value={fmtNum(fleet.total || 0)} color={INDIGO} icon={Cpu} tint="rgba(99,102,241,0.06)" />
          <StatusTile label="Running" value={fmtNum(fleet.running || 0)} color={TEAL} icon={Play} tint="rgba(13,148,136,0.07)" />
          <StatusTile label="Idle" value={fmtNum(fleet.idle || 0)} color={AMBER} icon={Pause} tint="rgba(217,119,6,0.06)" />
          <StatusTile label="Stopped" value={fmtNum(fleet.stopped || 0)} color={fleet.stopped ? RED : STEEL} icon={CircleSlash} tint="rgba(220,38,38,0.06)" />
          <StatusTile label="Offline" value={fmtNum(fleet.offline || 0)} color={fleet.offline ? STEEL : TEAL} icon={Power} tint="rgba(100,116,139,0.06)" />
        </div>

        {/* Analytical KPIs */}
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
          <Kpi label="Fleet Health"  value={`${health.avgScore}%`} sub={`${health.critical} critical · ${health.warning} warn`} color={health.avgScore >= 80 ? TEAL : health.avgScore >= 50 ? AMBER : RED} icon={ShieldCheck} />
          <Kpi label="Signal Coverage" value={`${signals.mappedPct}%`} sub={`${fmtNum(signals.mapped)} of ${fmtNum(signals.total)} mapped`} color={INDIGO} icon={Database} />
          <Kpi label="Reporting"     value={`${reporting.reporting}/${reporting.total}`} sub={`${reporting.live} live now`} color={TEAL} icon={Radio} />
          <Kpi label="Capabilities"  value={`${caps.liveCount}/${caps.total}`} sub={`${caps.blocked.length} need signals`} color={VIOLET} icon={Gauge} />
          <Kpi label="Active Alerts" value={fmtNum(alerts.total)} sub={`${alerts.critical} crit · ${alerts.warning} warn`} color={alerts.critical ? RED : alerts.warning ? AMBER : TEAL} icon={AlertTriangle} />
          <Kpi label="Downtime (24h)" value={fmtDuration(ov?.downtime?.totalMs)} sub={`${ov?.downtime?.events || 0} events`} color={AMBER} icon={Clock} />
        </div>

        {/* Status + health + alerts — equal-size cards, each drills into per-machine detail */}
        <div className="grid lg:grid-cols-3 gap-5">
          <Panel title="Machine Status" subtitle={`${fleet.total} machines · ${fleet.running} running now`} icon={Cpu} onClick={() => setDrill('status')}>
            <div className="flex items-center gap-4">
              <Donut segments={statusSeg} size={128} thickness={16} emptyColor={SLATE}>
                <span className="data text-2xl font-bold text-primary leading-none">{fmtNum(fleet.total || 0)}</span>
                <span className="label mt-1">machines</span>
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
            ]} unit="machines" />
          </Panel>

          <Panel title="Alert Composition" subtitle={`${alerts.total} active across the fleet`} icon={AlertTriangle} onClick={() => setDrill('alerts')}>
            <CategoryBars data={[
              { label: 'Sensor faults', value: alerts.byCategory.fault || 0, color: RED },
              { label: 'Out of range', value: alerts.byCategory.range || 0, color: RED },
              { label: 'Set/actual drift', value: alerts.byCategory.deviation || 0, color: AMBER },
              { label: 'Stale (running, no data)', value: alerts.byCategory.stale || 0, color: AMBER },
              { label: 'Offline', value: alerts.byCategory.offline || 0, color: SLATE },
            ]} />
          </Panel>
        </div>

        {/* Signal composition + telemetry volume */}
        <div className="grid lg:grid-cols-2 gap-5">
          <Panel title="Signal Composition" subtitle={`${signals.mappedPct}% mapped · ${fmtNum(signals.registers)} raw registers`} icon={Database} onClick={() => setDrill('signals')}>
            <StackBar segments={[
              { label: 'Named metrics', value: signals.named, color: TEAL },
              { label: 'Digital I/O', value: signals.io, color: INDIGO },
              { label: 'Raw registers', value: signals.registers, color: SLATE },
            ]} unit="signals" />
          </Panel>

          <Panel title="Telemetry Volume by Type" subtitle={`${fmtNum(volume.totalReadings)} total readings`} icon={Activity} onClick={() => setDrill('volume')}>
            <Distribution rows={(volume.byType || []).map((t) => ({ label: prettyType(t.type), value: t.readings }))} total={volume.totalReadings} color={TEAL} unit="readings" />
          </Panel>
        </div>

        {/* Fleet composition — full width (type & class side by side) */}
        <Panel title="Fleet Composition" subtitle={`${fleet.total} machines by type & class`} icon={Layers} onClick={() => setDrill('fleet')}>
          <div className="grid sm:grid-cols-2 gap-x-8 gap-y-5">
            <Distribution title="By Type"  rows={(ov?.composition?.byType || []).map((t) => ({ label: prettyType(t.type), value: t.count }))} total={fleet.total} color={INDIGO} />
            <Distribution title="By Class" rows={(ov?.composition?.byClass || []).map((c) => ({ label: prettyType(c.class), value: c.count, badge: c.alerts }))} total={fleet.total} color={VIOLET} />
          </div>
        </Panel>

        {/* Instrumentation maturity */}
        <Panel title="Monitoring Capabilities" subtitle={`${caps.liveCount} of ${caps.total} instrumented · ${caps.blocked.length} awaiting signals`} icon={Gauge} onClick={() => setDrill('capabilities')}>
          <div className="grid sm:grid-cols-2 gap-x-8 gap-y-4">
            <div>
              <div className="label mb-2 text-running">Live now ({caps.liveCount})</div>
              <div className="space-y-1.5">
                {caps.live.map((c) => (
                  <div key={c} className="flex items-center gap-2 text-sm text-primary"><CheckCircle2 size={14} className="text-running shrink-0" />{c}</div>
                ))}
              </div>
            </div>
            <div>
              <div className="label mb-2 text-steel">Blocked — needs signal ({caps.blocked.length})</div>
              <div className="space-y-1.5">
                {caps.blocked.map((c) => (
                  <div key={c.name} className="flex items-start gap-2 text-sm">
                    <Lock size={13} className="text-steel/50 shrink-0 mt-0.5" />
                    <span><span className="text-steel">{c.name}</span> <span className="text-[11px] text-steel/60">· needs {c.needs}</span></span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </Panel>

        {/* Team & access */}
        <Panel title="Team & Access" subtitle={`${team.employees} employees · ${team.roles} roles · ${team.superAdmins} super admin${team.superAdmins === 1 ? '' : 's'}`} icon={Users} onClick={() => setDrill('team')}>
          <Distribution rows={(team.byRole || []).map((b) => ({ label: b.role, value: b.count }))} total={team.employees} color={VIOLET} unit="employees" />
        </Panel>
      </div>

      {drill && ov && <AnalyticsModal dimension={drill} ov={ov} onClose={() => setDrill(null)} />}
    </div>
  );
}

// ── building blocks ──────────────────────────────────────────────────────────
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

function Distribution({ title, rows, total, color, unit }: { title?: string; rows: { label: string; value: number; badge?: number }[]; total: number; color: string; unit?: string }): JSX.Element {
  const max = Math.max(...rows.map((r) => r.value), 1);
  return (
    <div>
      {title && <div className="label mb-2">{title}</div>}
      <div className="space-y-2.5">
        {rows.length === 0 ? <div className="text-xs text-steel">No data.</div> : rows.map((r) => (
          <div key={r.label}>
            <div className="flex justify-between text-xs mb-1">
              <span className="text-steel flex items-center gap-1.5">{r.label}{(r.badge ?? 0) > 0 && <span className="pill bg-idle/10 text-idle !text-[9px]">{r.badge}</span>}</span>
              <span className="data text-primary font-medium">{fmtNum(r.value)}{total ? <span className="text-steel/60"> · {Math.round((r.value / total) * 100)}%</span> : ''}</span>
            </div>
            <div className="h-1.5 bg-line rounded-full overflow-hidden"><div className="h-full rounded-full" style={{ width: `${(r.value / max) * 100}%`, background: color }} /></div>
          </div>
        ))}
      </div>
      {unit && rows.length > 0 && <div className="text-[10px] text-steel/60 mt-2">{fmtNum(total)} {unit} total</div>}
    </div>
  );
}
