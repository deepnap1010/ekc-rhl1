// client/src/components/AnalyticsModal.tsx
// Click-through detail for each dashboard analytics block. Renders the aggregate
// PLUS the per-machine breakdown behind it — turning every chart into a drill-down.
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import {
  Database, ShieldCheck, AlertTriangle, Layers, Activity, Gauge, CheckCircle2, Lock, ArrowUpRight, Users, Cpu,
} from 'lucide-react';
import Modal from './Modal';
import { userApi, rbacApi } from '../api/endpoints';
import { fmtNum, prettyType } from '../lib/format';
import type { DashboardOverview, OvMachine } from '../types/api';

const TEAL = '#0D9488', AMBER = '#D97706', RED = '#DC2626', STEEL = '#64748B', SLATE = '#94A3B8', INDIGO = '#6366F1';
const HEALTH_COLOR: Record<string, string> = { healthy: TEAL, warning: AMBER, critical: RED, offline: SLATE };
const STATUS_COLOR: Record<string, string> = { running: TEAL, idle: AMBER, stopped: RED, offline: SLATE };
const SEV_COLOR: Record<string, string> = { fault: RED, critical: RED, range: RED, warning: AMBER, deviation: AMBER, stale: AMBER, info: STEEL, offline: SLATE, other: SLATE };
const CAT_LABEL: Record<string, string> = { fault: 'Sensor faults', range: 'Out of range', deviation: 'Set/actual drift', stale: 'Stale (running, no data)', offline: 'Offline', other: 'Other' };

const DIM: Record<string, { title: string; icon: LucideIcon }> = {
  status:       { title: 'Machine Status', icon: Cpu },
  signals:      { title: 'Signal Composition', icon: Database },
  health:       { title: 'Health Distribution', icon: ShieldCheck },
  alerts:       { title: 'Alert Composition', icon: AlertTriangle },
  fleet:        { title: 'Fleet Composition', icon: Layers },
  volume:       { title: 'Telemetry Volume', icon: Activity },
  capabilities: { title: 'Monitoring Capabilities', icon: Gauge },
  team:         { title: 'Team & Access', icon: Users },
};

const CAP_DESC: Record<string, string> = {
  'Machine status & uptime': 'Derived from each machine’s status + last-seen freshness.',
  'Downtime & availability': 'From the downtime_reports collection — events and durations.',
  'Anomaly & fault detection': 'From the health engine: sentinel faults, out-of-range, set/actual drift, staleness.',
  'Signal / telemetry coverage': 'From classifying every reading into named metrics, digital I/O, and raw registers.',
};
const CAP_VALUE: Record<string, string> = {
  'Production output': 'Pieces/hour, target vs achieved, shift output.',
  'OEE & performance': 'Availability × Performance × Quality, the headline KPI.',
  'Cycle time': 'Per-piece cycle time, bottleneck detection.',
  'Energy / gas consumption': 'kWh / Nm³ per piece, energy cost tracking.',
  'Tool life & maintenance': 'Tool-change scheduling, predictive maintenance.',
};

export default function AnalyticsModal({ dimension, ov, onClose }: { dimension: string; ov: DashboardOverview; onClose: () => void }): JSX.Element {
  const meta = DIM[dimension] || { title: 'Details', icon: Activity };
  const machines = ov.machines || [];
  return (
    <Modal title={meta.title} subtitle="Detailed analytics · per-machine breakdown" icon={meta.icon} onClose={onClose} maxW="max-w-4xl">
      {dimension === 'status'       && <StatusDetail machines={machines} />}
      {dimension === 'signals'      && <SignalsDetail ov={ov} machines={machines} />}
      {dimension === 'health'       && <HealthDetail ov={ov} machines={machines} />}
      {dimension === 'alerts'       && <AlertsDetail machines={machines} />}
      {dimension === 'fleet'        && <FleetDetail machines={machines} />}
      {dimension === 'volume'       && <VolumeDetail ov={ov} machines={machines} />}
      {dimension === 'capabilities' && <CapabilitiesDetail ov={ov} />}
      {dimension === 'team'         && <TeamDetail />}
    </Modal>
  );
}

// ── Team & Access ────────────────────────────────────────────────────────────
function TeamDetail(): JSX.Element {
  const { data: u } = useQuery({ queryKey: ['users', 'team'], queryFn: () => userApi.list({ limit: 200 }) });
  const { data: roles } = useQuery({ queryKey: ['roles'], queryFn: () => rbacApi.roles().then((r) => r.data) });
  const users = u?.data || [];
  const roleList = roles || [];
  const counts: Record<string, number> = {};
  users.forEach((x) => { const rid = x.role?.id; if (!x.isSuperAdmin && rid) counts[rid] = (counts[rid] || 0) + 1; });

  return (
    <div className="space-y-5">
      <StatRow items={[
        { label: 'Employees', value: users.length },
        { label: 'Super Admins', value: users.filter((x) => x.isSuperAdmin).length, color: TEAL },
        { label: 'Roles', value: roleList.length, color: INDIGO },
        { label: 'Active', value: users.filter((x) => x.active).length, color: TEAL },
      ]} />
      <div>
        <div className="label mb-2">Roles & members</div>
        <Table head={['Role', 'Key', 'Members', 'Modules']}>
          {roleList.map((r) => (
            <tr key={r._id} className="border-t border-line hover:bg-base/60">
              <td className="px-3 py-2 text-xs font-medium text-primary">{r.name}{r.isSystem && <span className="pill bg-line text-steel !text-[9px] ml-1.5">system</span>}</td>
              <Td>{r.key}</Td>
              <Td right>{counts[r._id] || 0}</Td>
              <Td right>{Object.keys(r.permissions || {}).length}</Td>
            </tr>
          ))}
        </Table>
      </div>
      <div>
        <div className="label mb-2">Employees</div>
        <Table head={['Name', 'Email', 'Role', 'Status']}>
          {users.map((x) => (
            <tr key={x.id} className="border-t border-line hover:bg-base/60">
              <td className="px-3 py-2 text-xs font-medium text-primary">{x.name}</td>
              <Td>{x.email}</Td>
              <td className="px-3 py-2"><span className={`pill ${x.isSuperAdmin ? 'bg-accent/10 text-accent' : 'bg-line text-steel'} !text-[10px]`}>{x.isSuperAdmin ? 'Super Admin' : x.role?.name || '— none —'}</span></td>
              <td className="px-3 py-2"><span className={`pill ${x.active ? 'bg-running/10 text-running' : 'bg-line text-steel'} !text-[10px]`}>{x.active ? 'Active' : 'Inactive'}</span></td>
            </tr>
          ))}
        </Table>
      </div>
    </div>
  );
}

// ── shared bits ──────────────────────────────────────────────────────────────
function StatRow({ items }: { items: { label: string; value: ReactNode; color?: string }[] }): JSX.Element {
  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-2">
      {items.map((s) => (
        <div key={s.label} className="rounded-lg border border-line bg-base p-2.5">
          <div className="text-[10px] uppercase tracking-wide text-steel truncate">{s.label}</div>
          <div className="data text-lg font-bold mt-0.5" style={{ color: s.color || '#1E293B' }}>{s.value}</div>
        </div>
      ))}
    </div>
  );
}

function Table({ head, children }: { head: string[]; children: ReactNode }): JSX.Element {
  return (
    <div className="overflow-x-auto rounded-lg border border-line">
      <table className="w-full text-sm whitespace-nowrap">
        <thead className="bg-base"><tr>{head.map((h, i) => <th key={h} className={`label px-3 py-2 ${i === 0 ? 'text-left' : 'text-right'}`}>{h}</th>)}</tr></thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}
function Td({ children, right }: { children: ReactNode; right?: boolean }): JSX.Element {
  return <td className={`px-3 py-2 data text-xs ${right ? 'text-right' : ''}`}>{children}</td>;
}

function MachineLink({ id }: { id: string }): JSX.Element {
  return <Link to={`/machines/${encodeURIComponent(id)}`} className="data text-xs font-semibold text-primary hover:text-accent">{String(id).toUpperCase()}</Link>;
}
function Pctbar({ pct, color = TEAL }: { pct: number; color?: string }): JSX.Element {
  return (
    <span className="inline-flex items-center gap-1.5 justify-end">
      <span className="w-14 h-1.5 bg-line rounded-full overflow-hidden hidden sm:inline-block"><span className="block h-full rounded-full" style={{ width: `${pct}%`, background: color }} /></span>
      <span className="data text-xs w-9 text-right">{pct}%</span>
    </span>
  );
}
function Insight({ children }: { children: ReactNode }): JSX.Element {
  return <div className="text-[12px] text-steel bg-accent/5 border border-accent/15 rounded-lg px-3 py-2.5 leading-snug">💡 {children}</div>;
}
function StatusDot({ status }: { status: string }): JSX.Element {
  return <span className="w-2 h-2 rounded-full inline-block" style={{ background: HEALTH_COLOR[status] || STEEL }} />;
}

// ── Signal Composition ───────────────────────────────────────────────────────
function SignalsDetail({ ov, machines }: { ov: DashboardOverview; machines: OvMachine[] }): JSX.Element {
  const s = ov.signals;
  const rows = machines.map((m) => {
    const total = m.namedCount + m.ioCount + m.registers;
    return { ...m, total, mappedPct: total ? Math.round(((m.namedCount + m.ioCount) / total) * 100) : 0 };
  }).sort((a, b) => b.registers - a.registers);
  const topRaw = rows[0];
  return (
    <div className="space-y-5">
      <StatRow items={[
        { label: 'Total signals', value: fmtNum(s.total) },
        { label: 'Mapped', value: `${s.mappedPct}%`, color: s.mappedPct >= 50 ? TEAL : AMBER },
        { label: 'Named', value: fmtNum(s.named), color: TEAL },
        { label: 'Digital I/O', value: fmtNum(s.io), color: INDIGO },
        { label: 'Raw registers', value: fmtNum(s.registers), color: SLATE },
      ]} />
      <div>
        <div className="label mb-2">Per-machine signal breakdown</div>
        <Table head={['Machine', 'Named', 'I/O', 'Registers', 'Total', 'Mapped']}>
          {rows.map((m) => (
            <tr key={m.machineId} className="border-t border-line hover:bg-base/60">
              <td className="px-3 py-2"><MachineLink id={m.machineId} /></td>
              <Td right>{fmtNum(m.namedCount)}</Td>
              <Td right>{fmtNum(m.ioCount)}</Td>
              <Td right>{fmtNum(m.registers)}</Td>
              <Td right>{fmtNum(m.total)}</Td>
              <td className="px-3 py-2 text-right"><Pctbar pct={m.mappedPct} color={m.mappedPct >= 50 ? TEAL : AMBER} /></td>
            </tr>
          ))}
        </Table>
      </div>
      {topRaw && topRaw.registers > 0 && (
        <Insight>{String(topRaw.machineId).toUpperCase()} carries {fmtNum(topRaw.registers)} unmapped registers ({topRaw.mappedPct}% mapped). Mapping its high-volume registers to named parameters would unlock the most monitoring value per effort.</Insight>
      )}
    </div>
  );
}

// ── Health Distribution ──────────────────────────────────────────────────────
function HealthDetail({ ov, machines }: { ov: DashboardOverview; machines: OvMachine[] }): JSX.Element {
  const h = ov.health;
  const rows = [...machines].sort((a, b) => a.health.score - b.health.score);
  const byClass: Record<string, { sum: number; n: number }> = {};
  machines.forEach((m) => { const c = m.class || 'unclassified'; (byClass[c] = byClass[c] || { sum: 0, n: 0 }); byClass[c].sum += m.health.score; byClass[c].n += 1; });
  return (
    <div className="space-y-5">
      <StatRow items={[
        { label: 'Avg score', value: `${h.avgScore}/100`, color: h.avgScore >= 80 ? TEAL : h.avgScore >= 50 ? AMBER : RED },
        { label: 'Healthy', value: h.healthy || 0, color: TEAL },
        { label: 'Warning', value: h.warning || 0, color: AMBER },
        { label: 'Critical', value: h.critical || 0, color: RED },
        { label: 'Offline', value: h.offline || 0, color: SLATE },
      ]} />
      <div>
        <div className="label mb-2">Machines by health (worst first)</div>
        <Table head={['Machine', 'Score', 'Status', 'Alerts', 'Top issue']}>
          {rows.map((m) => (
            <tr key={m.machineId} className="border-t border-line hover:bg-base/60">
              <td className="px-3 py-2"><MachineLink id={m.machineId} /></td>
              <Td right><span className="data font-semibold" style={{ color: HEALTH_COLOR[m.health.status] }}>{m.health.score}</span></Td>
              <td className="px-3 py-2 text-right"><span className="inline-flex items-center gap-1.5 justify-end capitalize text-xs text-steel"><StatusDot status={m.health.status} />{m.health.status}</span></td>
              <Td right>{m.health.counts.total}</Td>
              <td className="px-3 py-2 text-[11px] text-steel max-w-[220px] truncate" title={m.health.alerts[0]?.message || ''}>{m.health.alerts[0]?.message || '—'}</td>
            </tr>
          ))}
        </Table>
      </div>
      <div>
        <div className="label mb-2">Average score by class</div>
        <div className="grid sm:grid-cols-3 gap-2">
          {Object.entries(byClass).map(([c, v]) => {
            const avg = Math.round(v.sum / v.n);
            return (
              <div key={c} className="rounded-lg border border-line bg-base p-3">
                <div className="text-xs text-steel">{prettyType(c)}</div>
                <div className="data text-lg font-bold" style={{ color: avg >= 80 ? TEAL : avg >= 50 ? AMBER : RED }}>{avg}<span className="text-[10px] text-steel">/100</span></div>
                <div className="text-[10px] text-steel/70">{v.n} machine{v.n > 1 ? 's' : ''}</div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// ── Alert Composition ────────────────────────────────────────────────────────
function AlertsDetail({ machines }: { machines: OvMachine[] }): JSX.Element {
  const all = machines.flatMap((m) => m.health.alerts.map((a) => ({ ...a, machineId: m.machineId })));
  const groups: Record<string, typeof all> = {};
  all.forEach((a) => { (groups[a.category] = groups[a.category] || []).push(a); });
  const order = ['fault', 'range', 'deviation', 'stale', 'offline', 'other'];
  const affected = new Set(all.map((a) => a.machineId)).size;
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="text-sm text-steel">{all.length} active alert{all.length === 1 ? '' : 's'} across {affected} machine{affected === 1 ? '' : 's'}.</div>
        <Link to="/alerts" className="text-xs text-accent hover:underline flex items-center gap-1">Open Alerts page <ArrowUpRight size={13} /></Link>
      </div>
      {all.length === 0 ? <div className="text-sm text-running py-6 text-center">No active alerts — fleet healthy.</div> : order.filter((c) => groups[c]?.length).map((c) => (
        <div key={c}>
          <div className="flex items-center gap-2 mb-1.5">
            <span className="w-2 h-2 rounded-full" style={{ background: SEV_COLOR[c] }} />
            <span className="label">{CAT_LABEL[c] || c}</span>
            <span className="pill bg-line text-steel !text-[10px]">{groups[c].length}</span>
          </div>
          <div className="space-y-1.5">
            {groups[c].map((a, i) => (
              <Link key={i} to={`/machines/${encodeURIComponent(a.machineId)}`} className="flex items-center gap-2.5 rounded-lg border border-line bg-base px-3 py-2 hover:border-accent/30">
                <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: SEV_COLOR[a.severity] || STEEL }} />
                <span className="text-xs text-primary flex-1 min-w-0 truncate">{a.message}</span>
                <span className="data text-[10px] text-steel shrink-0">{String(a.machineId).toUpperCase()}</span>
              </Link>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

// ── Fleet Composition ────────────────────────────────────────────────────────
function FleetDetail({ machines }: { machines: OvMachine[] }): JSX.Element {
  const group = (key: 'type' | 'class') => {
    const g: Record<string, OvMachine[]> = {};
    machines.forEach((m) => { const k = (m[key] as string | null) || 'unclassified'; (g[k] = g[k] || []).push(m); });
    return Object.entries(g).sort((a, b) => b[1].length - a[1].length);
  };
  return (
    <div className="space-y-5">
      <div>
        <div className="label mb-2">By type</div>
        <div className="space-y-2">{group('type').map(([k, ms]) => <GroupRow key={k} label={prettyType(k)} machines={ms} />)}</div>
      </div>
      <div>
        <div className="label mb-2">By class</div>
        <div className="space-y-2">{group('class').map(([k, ms]) => <GroupRow key={k} label={prettyType(k)} machines={ms} />)}</div>
      </div>
    </div>
  );
}
function GroupRow({ label, machines }: { label: string; machines: OvMachine[] }): JSX.Element {
  const alerts = machines.reduce((s, m) => s + m.health.counts.total, 0);
  return (
    <div className="rounded-lg border border-line bg-base p-3">
      <div className="flex items-center justify-between mb-1.5">
        <span className="text-sm font-medium text-primary">{label}</span>
        <span className="flex items-center gap-2 text-xs text-steel">{machines.length} machine{machines.length > 1 ? 's' : ''}{alerts > 0 && <span className="pill bg-idle/10 text-idle !text-[10px]">{alerts} alert{alerts > 1 ? 's' : ''}</span>}</span>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {machines.map((m) => (
          <Link key={m.machineId} to={`/machines/${encodeURIComponent(m.machineId)}`} className="inline-flex items-center gap-1.5 pill bg-surface border border-line text-steel hover:border-accent/40 hover:text-primary !text-[10px]">
            <StatusDot status={m.health.status} />{String(m.machineId).toUpperCase()}
          </Link>
        ))}
      </div>
    </div>
  );
}

// ── Machine Status ───────────────────────────────────────────────────────────
function StatusDetail({ machines }: { machines: OvMachine[] }): JSX.Element {
  const order = ['running', 'idle', 'stopped', 'offline'];
  const g: Record<string, OvMachine[]> = {};
  machines.forEach((m) => { const k = m.status || 'offline'; (g[k] = g[k] || []).push(m); });
  const keys = [...order.filter((k) => (g[k]?.length ?? 0) > 0), ...Object.keys(g).filter((k) => !order.includes(k))];
  return (
    <div className="space-y-5">
      <StatRow items={order.map((k) => ({ label: k.charAt(0).toUpperCase() + k.slice(1), value: (g[k] || []).length, color: STATUS_COLOR[k] }))} />
      {keys.map((k) => {
        const arr = g[k] || [];
        return (
          <div key={k}>
            <div className="flex items-center gap-2 mb-1.5">
              <span className="w-2 h-2 rounded-full" style={{ background: STATUS_COLOR[k] || STEEL }} />
              <span className="label capitalize">{k}</span>
              <span className="pill bg-line text-steel !text-[10px]">{arr.length}</span>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {arr.map((m) => (
                <Link key={m.machineId} to={`/machines/${encodeURIComponent(m.machineId)}`} className="inline-flex items-center gap-1.5 pill bg-surface border border-line text-steel hover:border-accent/40 hover:text-primary !text-[10px]">
                  <span className="w-2 h-2 rounded-full" style={{ background: STATUS_COLOR[k] || STEEL }} />{String(m.machineId).toUpperCase()}
                </Link>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ── Telemetry Volume ─────────────────────────────────────────────────────────
function VolumeDetail({ ov, machines }: { ov: DashboardOverview; machines: OvMachine[] }): JSX.Element {
  const total = ov.volume?.totalReadings || 0;
  const rows = [...machines].sort((a, b) => b.readings - a.readings);
  const perDay = ov.volume?.perDay || [];
  const MONTHS = ['', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const fmtDay = (d: string) => { const [, mm, day] = (d || '').split('-'); return mm ? `${MONTHS[+mm]} ${+day}` : d; };
  return (
    <div className="space-y-5">
      <StatRow items={[
        { label: 'Total readings', value: fmtNum(total) },
        { label: 'Machines', value: machines.length },
        { label: 'Reporting', value: machines.filter((m) => m.readings > 0).length },
        { label: 'Days tracked', value: perDay.length },
      ]} />
      <div>
        <div className="label mb-2">Readings by machine</div>
        <Table head={['Machine', 'Type', 'Readings', 'Share']}>
          {rows.map((m) => (
            <tr key={m.machineId} className="border-t border-line hover:bg-base/60">
              <td className="px-3 py-2"><MachineLink id={m.machineId} /></td>
              <Td>{m.type && m.type !== 'UNKNOWN' ? prettyType(m.type) : '—'}</Td>
              <Td right>{fmtNum(m.readings)}</Td>
              <td className="px-3 py-2 text-right"><Pctbar pct={total ? Math.round((m.readings / total) * 100) : 0} color={INDIGO} /></td>
            </tr>
          ))}
        </Table>
      </div>
      {perDay.length > 0 && (
        <div>
          <div className="label mb-2">Throughput by day</div>
          <div className="space-y-1.5">
            {perDay.map((d) => {
              const max = Math.max(...perDay.map((x) => x.readings), 1);
              return (
                <div key={d.day} className="flex items-center gap-2 text-xs">
                  <span className="text-steel w-14 shrink-0">{fmtDay(d.day)}</span>
                  <div className="flex-1 h-3.5 bg-line rounded overflow-hidden"><div className="h-full bg-accent/70 rounded" style={{ width: `${(d.readings / max) * 100}%` }} /></div>
                  <span className="data text-primary w-12 text-right">{fmtNum(d.readings)}</span>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Monitoring Capabilities ──────────────────────────────────────────────────
function CapabilitiesDetail({ ov }: { ov: DashboardOverview }): JSX.Element {
  const caps = ov.capabilities;
  return (
    <div className="space-y-5">
      <Insight>{caps.liveCount} of {caps.total} monitoring capabilities are live today. The remaining {caps.blocked.length} unlock automatically the moment the listed signals start streaming — no rework needed.</Insight>
      <div>
        <div className="label mb-2 text-running">Live now ({caps.live.length})</div>
        <div className="space-y-2">
          {caps.live.map((c) => (
            <div key={c} className="flex items-start gap-2.5 rounded-lg border border-running/20 bg-running/5 px-3 py-2.5">
              <CheckCircle2 size={15} className="text-running shrink-0 mt-0.5" />
              <div><div className="text-sm font-medium text-primary">{c}</div><div className="text-[11px] text-steel mt-0.5">{CAP_DESC[c] || ''}</div></div>
            </div>
          ))}
        </div>
      </div>
      <div>
        <div className="label mb-2">Blocked — needs signal ({caps.blocked.length})</div>
        <div className="space-y-2">
          {caps.blocked.map((c) => (
            <div key={c.name} className="flex items-start gap-2.5 rounded-lg border border-dashed border-line bg-base px-3 py-2.5">
              <Lock size={14} className="text-steel/50 shrink-0 mt-0.5" />
              <div className="min-w-0">
                <div className="text-sm font-medium text-steel">{c.name}</div>
                <div className="text-[11px] text-steel/80 mt-0.5">Needs: <span className="text-primary">{c.needs}</span></div>
                {CAP_VALUE[c.name] && <div className="text-[11px] text-steel/60 mt-0.5">Unlocks: {CAP_VALUE[c.name]}</div>}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
