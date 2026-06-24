// client/src/pages/Alerts.tsx — fleet-wide live anomaly feed
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { AlertTriangle, ShieldCheck, Activity, ArrowUpRight } from 'lucide-react';
import { alertsApi } from '../api/endpoints';
import { StatCard, Spinner } from '../components/ui';
import PageHeader from '../components/PageHeader';
import { fmtNum, fmtTime, prettyType } from '../lib/format';
import type { Alert, AlertMachineHealth } from '../types/api';

const RED = '#DC2626', AMBER = '#D97706', STEEL = '#64748B', TEAL = '#0D9488';

const SEV: Record<string, { color: string; bg: string; text: string; label: string }> = {
  fault:    { color: RED,   bg: 'bg-stopped/10', text: 'text-stopped', label: 'Fault' },
  critical: { color: RED,   bg: 'bg-stopped/10', text: 'text-stopped', label: 'Critical' },
  warning:  { color: AMBER, bg: 'bg-idle/10',    text: 'text-idle',    label: 'Warning' },
  info:     { color: STEEL, bg: 'bg-line',       text: 'text-steel',   label: 'Info' },
};
const HEALTH: Record<string, string> = { healthy: TEAL, warning: AMBER, critical: RED, offline: STEEL };
const FILTERS = ['all', 'critical', 'warning', 'info'];

export default function Alerts() {
  const [severity, setSeverity] = useState('all');
  const { data, isLoading } = useQuery({
    queryKey: ['alerts', severity],
    queryFn: () => alertsApi.list({ severity: severity !== 'all' ? severity : undefined }).then((r) => r.data),
    refetchInterval: 15000,
  });

  const alerts = data?.alerts || [];
  const summary = data?.summary;
  const machines = data?.machines || [];

  return (
    <div>
      <PageHeader title="Alerts" subtitle="Live anomaly detection across the fleet" />

      <div className="px-4 sm:px-6 pb-8 space-y-5 pt-5">
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          <StatCard label="Active Alerts" value={fmtNum(summary?.total || 0)} sub="across the fleet" accent={STEEL} icon={AlertTriangle} />
          <StatCard label="Critical" value={summary?.critical || 0} sub="faults + out-of-range" accent={RED} icon={AlertTriangle} />
          <StatCard label="Warning" value={summary?.warning || 0} sub="needs attention" accent={AMBER} />
          <StatCard label="Machines Affected" value={summary?.machinesAffected || 0} sub="of the fleet" accent={STEEL} icon={Activity} />
        </div>

        {/* Per-machine health */}
        <div className="panel p-5">
          <h2 className="font-semibold text-sm text-primary mb-3">Machine Health</h2>
          <div className="grid sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5 gap-3">
            {machines.map((m) => <HealthCard key={m.machineId} m={m} />)}
            {machines.length === 0 && <div className="text-xs text-steel">No machines.</div>}
          </div>
        </div>

        {/* Severity filter */}
        <div className="panel p-3 flex items-center gap-1 flex-wrap">
          <span className="label mr-1">Severity:</span>
          {FILTERS.map((s) => (
            <button key={s} onClick={() => setSeverity(s)}
              className={`px-3 py-1.5 rounded-lg text-xs capitalize transition-colors ${severity === s ? 'bg-accent/10 text-accent font-medium' : 'text-steel hover:bg-line hover:text-primary'}`}>
              {s}
            </button>
          ))}
        </div>

        {/* Alert list */}
        {isLoading ? <Spinner /> : alerts.length === 0 ? (
          <div className="panel p-12 text-center flex flex-col items-center gap-2">
            <ShieldCheck size={28} className="text-running/60" />
            <div className="text-sm text-steel">No {severity !== 'all' ? severity : ''} alerts — the fleet is healthy.</div>
          </div>
        ) : (
          <div className="panel overflow-hidden divide-y divide-line">
            {alerts.map((a, i) => <AlertItem key={`${a.machineId}-${a.key}-${i}`} a={a} />)}
          </div>
        )}
      </div>
    </div>
  );
}

function HealthCard({ m }: { m: AlertMachineHealth }): JSX.Element {
  const color = HEALTH[m.health] || STEEL;
  return (
    <Link to={`/machines/${encodeURIComponent(m.machineId)}`} className="card p-3 hover:border-accent/30 transition-colors block">
      <div className="flex items-center justify-between gap-2">
        <span className="data text-xs font-bold text-primary truncate" title={m.machineId}>{String(m.machineId).toUpperCase()}</span>
        <span className="w-2 h-2 rounded-full shrink-0" style={{ background: color }} />
      </div>
      <div className="flex items-baseline gap-1 mt-1.5">
        <span className="data text-xl font-bold" style={{ color }}>{m.score}</span>
        <span className="text-[10px] text-steel">/100</span>
      </div>
      <div className="text-[10px] text-steel mt-0.5 capitalize">{m.health} · {m.alerts} alert{m.alerts === 1 ? '' : 's'}</div>
    </Link>
  );
}

function AlertItem({ a }: { a: Alert }): JSX.Element {
  const s = SEV[a.severity] || SEV.info;
  const isSignal = a.key && !a.key.startsWith('__');
  return (
    <Link to={`/machines/${encodeURIComponent(a.machineId)}`} className="flex items-center gap-3 px-4 py-3 hover:bg-base/60 transition-colors">
      <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: s.color }} />
      <span className={`pill ${s.bg} ${s.text} !text-[10px] shrink-0 w-16 justify-center`}>{s.label}</span>
      <div className="min-w-0 flex-1">
        <div className="text-sm text-primary truncate">{a.message}</div>
        <div className="text-[11px] text-steel mt-0.5">
          {a.machineName}{a.class ? ` · ${prettyType(a.class)}` : ''}{isSignal ? ` · ${a.key}` : ''}
        </div>
      </div>
      <span className="text-[10px] text-steel shrink-0 hidden sm:block">{fmtTime(a.ts || a.lastSeenAt)}</span>
      <ArrowUpRight size={14} className="text-steel/40 shrink-0" />
    </Link>
  );
}




















