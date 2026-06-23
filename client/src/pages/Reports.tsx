// client/src/pages/Reports.tsx
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell,
  PieChart, Pie,
} from 'recharts';
import {
  Download, FileBarChart, AlertTriangle, Clock, ShieldCheck, Play, CircleSlash, Power,
  Gauge as GaugeIcon, type LucideIcon,
} from 'lucide-react';
import { reportsApi } from '../api/endpoints';
import { StatCard, Spinner } from '../components/ui';
import { Donut, Gauge, Legend, ERROR_COLORS, STATUS_COLORS, BLUE_RAMP, PALETTE } from '../components/charts';
import PageHeader from '../components/PageHeader';
import { fmtNum, fmtDuration, prettyType } from '../lib/format';
import type { MetricValue } from '../types/api';
import type { ReactNode } from 'react';

const ACCENT = '#0D9488';
const IDLE   = '#D97706';
const STOPPED = '#DC2626';
const STEEL  = '#64748B';
const SLATE  = '#94A3B8';
const PIE_COLORS = [ACCENT, '#6366F1', '#EC4899', '#8B5CF6', '#3B82F6', IDLE];

export default function Reports() {
  const [tab, setTab] = useState('overview');

  const { data: prodData, isLoading: prodLoading } = useQuery({
    queryKey: ['reports', 'production'],
    queryFn: () => reportsApi.production().then((r) => r.data),
    refetchInterval: 60000,
  });
  const { data: dtData, isLoading: dtLoading } = useQuery({
    queryKey: ['reports', 'downtime'],
    queryFn: () => reportsApi.downtime().then((r) => r.data),
    refetchInterval: 60000,
  });
  const { data: plantData } = useQuery({
    queryKey: ['reports', 'plants'],
    queryFn: () => reportsApi.plants().then((r) => r.data),
    refetchInterval: 60000,
  });
  const { data: fleetData, isLoading: fleetLoading } = useQuery({
    queryKey: ['reports', 'fleet'],
    queryFn: () => reportsApi.fleet().then((r) => r.data),
    refetchInterval: 60000,
  });
  const { data: relData, isLoading: relLoading } = useQuery({
    queryKey: ['reports', 'reliability'],
    queryFn: () => reportsApi.reliability().then((r) => r.data),
    refetchInterval: 60000,
  });

  const totalOutput = (prodData?.byType || []).reduce((s, r) => s + r.output, 0);
  const avgEff = prodData?.byType?.length
    ? Math.round(prodData.byType.reduce((s, r) => s + r.efficiency, 0) / prodData.byType.length)
    : 0;

  const exportProdCsv = () => {
    if (!prodData?.machines?.length) return;
    const header = 'Machine,Type,Plant,Status,Output,OEE (%),Capacity';
    const rows = prodData.machines.map((m) => [m.code, m.type, m.plant, m.status, m.output, m.efficiency, m.capacity].join(','));
    download([header, ...rows].join('\n'), 'production_report.csv');
  };

  return (
    <div>
      <PageHeader
        title="Reports"
        subtitle="Production, OEE & downtime summary"
        right={
          <button onClick={exportProdCsv} className="flex items-center gap-1.5 bg-accent/10 text-accent border border-accent/20 text-sm px-3 py-1.5 rounded-lg hover:bg-accent/20">
            <Download size={14} /> Export CSV
          </button>
        }
      />

      <div className="px-4 sm:px-6 pb-8 space-y-5">
        {/* Tab switcher */}
        <div className="panel p-3 flex items-center justify-end">
          <div className="flex gap-1 bg-base rounded-lg p-0.5 border border-line">
            {['overview', 'production', 'downtime', 'plants', 'fleet', 'reliability'].map((t) => (
              <button
                key={t}
                onClick={() => setTab(t)}
                className={`px-3 py-1.5 rounded-md text-xs capitalize transition-colors ${tab === t ? 'bg-accent/15 text-accent' : 'text-steel hover:bg-white/5'}`}
              >
                {t}
              </button>
            ))}
          </div>
        </div>

        {/* ---- OVERVIEW ---- */}
        {tab === 'overview' && <OverviewReport />}

        {/* ---- PRODUCTION ---- */}
        {tab === 'production' && (
          prodLoading ? <Spinner /> : (
            <div className="space-y-5">
              <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
                <StatCard label="Total Output" value={fmtNum(totalOutput)} sub="Combined production" accent={ACCENT} icon={FileBarChart} />
                <StatCard label="Avg OEE" value={`${avgEff}%`} sub="Across types" accent={avgEff > 60 ? ACCENT : IDLE} />
                <StatCard label="Machine Types" value={prodData?.byType?.length || 0} sub="Active types" accent={STEEL} />
                <StatCard label="Machines" value={prodData?.machines?.length || 0} sub="Reporting" accent={STEEL} />
              </div>

              <div className="grid lg:grid-cols-2 gap-5">
                <div className="panel p-5">
                  <h2 className="font-semibold text-sm mb-4">Output by Machine Type</h2>
                  <ResponsiveContainer width="100%" height={220}>
                    <BarChart data={prodData?.byType || []} barSize={24}>
                      <XAxis dataKey="type" tickFormatter={prettyType} tick={{ fill: STEEL, fontSize: 10 }} axisLine={false} tickLine={false} />
                      <YAxis tick={{ fill: STEEL, fontSize: 10 }} axisLine={false} tickLine={false} tickFormatter={(v) => fmtNum(v)} />
                      <Tooltip content={<CustomTooltip />} cursor={{ fill: 'rgba(0,0,0,0.03)' }} />
                      <Bar dataKey="output" radius={[4, 4, 0, 0]}>
                        {(prodData?.byType || []).map((_, i) => <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />)}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                </div>

                <div className="panel p-5">
                  <h2 className="font-semibold text-sm mb-4">OEE by Type</h2>
                  <ResponsiveContainer width="100%" height={220}>
                    <PieChart>
                      <Pie data={prodData?.byType || []} dataKey="efficiency" nameKey="type" cx="50%" cy="50%" outerRadius={80}
                        label={({ type, efficiency }) => `${prettyType(type)}: ${efficiency}%`} labelLine={{ stroke: STEEL }}>
                        {(prodData?.byType || []).map((_, i) => <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />)}
                      </Pie>
                      <Tooltip formatter={(v) => [`${v}%`, 'OEE']} />
                    </PieChart>
                  </ResponsiveContainer>
                </div>
              </div>

              <div className="panel overflow-x-auto">
                <div className="px-4 py-3 bg-base"><h2 className="font-semibold text-sm">Machine-Level Production</h2></div>
                <table className="w-full text-sm">
                  <thead className="bg-base border-t border-line">
                    <tr className="text-steel">
                      <th className="text-left label px-4 py-2.5">Machine</th>
                      <th className="text-left label px-4 py-2.5">Type</th>
                      <th className="text-left label px-4 py-2.5">Plant</th>
                      <th className="text-left label px-4 py-2.5">Status</th>
                      <th className="text-right label px-4 py-2.5">Output</th>
                      <th className="text-right label px-4 py-2.5">OEE %</th>
                      <th className="text-right label px-4 py-2.5">Capacity</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(prodData?.machines || []).map((m) => (
                      <tr key={m.code} className="border-t border-line hover:bg-white/5">
                        <td className="px-4 py-2.5 data font-medium text-xs">{(m.code || '').toUpperCase()}</td>
                        <td className="px-4 py-2.5 text-xs text-steel">{prettyType(m.type)}</td>
                        <td className="px-4 py-2.5 text-xs text-steel">{m.plant}</td>
                        <td className="px-4 py-2.5">
                          <span className={`pill text-[10px] ${
                            m.status === 'running' ? 'bg-accent/10 text-accent' :
                            m.status === 'idle' ? 'bg-idle/10 text-idle' :
                            m.status === 'stopped' ? 'bg-stopped/10 text-stopped' : 'bg-white/5 text-steel'
                          }`}>{m.status}</span>
                        </td>
                        <td className="px-4 py-2.5 data text-xs text-right">{fmtNum(m.output)}</td>
                        <td className="px-4 py-2.5 data text-xs text-right" style={{ color: m.efficiency > 60 ? ACCENT : IDLE }}>{m.efficiency}%</td>
                        <td className="px-4 py-2.5 data text-xs text-right text-steel">{fmtNum(m.capacity)}</td>
                      </tr>
                    ))}
                    {(prodData?.machines || []).length === 0 && (
                      <tr><td colSpan={7} className="text-center text-steel py-8">No machines reporting yet</td></tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          )
        )}

        {/* ---- DOWNTIME ---- */}
        {tab === 'downtime' && (
          dtLoading ? <Spinner /> : (
            <div className="space-y-5">
              <div className="grid grid-cols-2 lg:grid-cols-3 gap-3">
                <StatCard label="Total Events" value={fmtNum(dtData?.totals?.totalEvents || 0)} accent={STEEL} />
                <StatCard label="Total Downtime" value={fmtDuration(dtData?.totals?.totalMs || 0)} accent={IDLE} />
                <StatCard label="Unique Machines" value={dtData?.byMachine?.length || 0} sub="With downtime" accent={STEEL} />
              </div>

              {(dtData?.byMachine || []).length === 0 ? (
                <div className="panel p-10 text-center text-steel">No downtime recorded yet.</div>
              ) : (
                <div className="grid lg:grid-cols-2 gap-5">
                  <div className="panel p-5">
                    <h2 className="font-semibold text-sm mb-4">Top 10 — Downtime by Machine</h2>
                    <ResponsiveContainer width="100%" height={240}>
                      <BarChart data={(dtData?.byMachine || []).slice(0, 10)} layout="vertical" barSize={14}>
                        <XAxis type="number" tick={{ fill: STEEL, fontSize: 10 }} axisLine={false} tickLine={false} tickFormatter={(v) => fmtDuration(v)} />
                        <YAxis type="category" dataKey="_id" tick={{ fill: STEEL, fontSize: 9 }} axisLine={false} tickLine={false} width={120} />
                        <Tooltip content={<DtTooltip />} cursor={{ fill: 'rgba(0,0,0,0.03)' }} />
                        <Bar dataKey="totalMs" fill={IDLE} radius={[0, 4, 4, 0]} />
                      </BarChart>
                    </ResponsiveContainer>
                  </div>

                  <div className="panel p-5">
                    <h2 className="font-semibold text-sm mb-4">Events by Type</h2>
                    <div className="space-y-3 mt-6">
                      {(dtData?.byType || []).map((t) => (
                        <div key={t._id}>
                          <div className="flex justify-between text-xs mb-1">
                            <span className="text-steel capitalize">{t._id}</span>
                            <span className="data">{t.events} events · {fmtDuration(t.totalMs)}</span>
                          </div>
                          <div className="h-1.5 bg-line rounded-full overflow-hidden">
                            <div className="h-full rounded-full" style={{
                              width: `${dtData?.totals?.totalEvents ? (t.events / dtData.totals.totalEvents) * 100 : 0}%`,
                              background: t._id === 'stopped' ? STOPPED : IDLE,
                            }} />
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              )}
            </div>
          )
        )}

        {/* ---- PLANTS ---- */}
        {tab === 'plants' && (
          <div className="space-y-5">
            {(plantData || []).length === 0 ? (
              <div className="panel p-10 text-center text-steel">No plant data yet.</div>
            ) : (
              <div className="grid md:grid-cols-3 gap-4">
                {(plantData || []).map((p) => (
                  <div key={p.plant} className="panel p-5">
                    <div className="flex items-center justify-between mb-3">
                      <h3 className="font-semibold">{p.plant}</h3>
                      <span className="label">{p.total} machines</span>
                    </div>
                    <div className="space-y-2">
                      <PlantRow label="Running" value={p.running} total={p.total} color={ACCENT} />
                      <PlantRow label="Idle" value={p.idle} total={p.total} color={IDLE} />
                      <PlantRow label="Stopped" value={p.stopped} total={p.total} color={STOPPED} />
                      <PlantRow label="Offline" value={p.offline} total={p.total} color={STEEL} />
                    </div>
                    <div className="mt-4 pt-3 border-t border-line grid grid-cols-2 gap-2 text-center">
                      <div>
                        <div className="data text-lg font-bold text-accent">{fmtNum(p.totalOutput)}</div>
                        <div className="label">Output</div>
                      </div>
                      <div>
                        <div className="data text-lg font-bold" style={{ color: p.avgEfficiency > 60 ? ACCENT : IDLE }}>{p.avgEfficiency}%</div>
                        <div className="label">Avg OEE</div>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
        {/* ---- FLEET ---- */}
        {tab === 'fleet' && (
          fleetLoading ? <Spinner /> : (
            <div className="space-y-5">
              <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
                <StatCard label="Machines" value={fleetData?.totals?.machines || 0} sub="In fleet" accent={STEEL} icon={FileBarChart} />
                <StatCard label="Signals" value={fmtNum(fleetData?.totals?.signals || 0)} sub="Named + I/O" accent={ACCENT} />
                <StatCard label="Raw Registers" value={fmtNum(fleetData?.totals?.registers || 0)} sub="Unmapped" accent={STEEL} />
                <StatCard label="Faults" value={fleetData?.totals?.faults || 0} sub="Sentinel readings" accent={STOPPED} />
              </div>

              {(fleetData?.byClass?.length ?? 0) > 0 && (
                <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-3">
                  {(fleetData?.byClass || []).map((c) => (
                    <div key={c.class} className="panel p-4">
                      <div className="text-sm font-medium text-primary">{prettyType(c.class)}</div>
                      <div className="data text-2xl font-bold mt-1" style={{ color: c.avgScore >= 80 ? ACCENT : c.avgScore >= 50 ? IDLE : STOPPED }}>{c.avgScore}<span className="text-xs text-steel">/100</span></div>
                      <div className="text-[11px] text-steel mt-0.5">{c.machines} machine{c.machines > 1 ? 's' : ''} · {c.faults} fault{c.faults === 1 ? '' : 's'}</div>
                    </div>
                  ))}
                </div>
              )}

              <div className="panel overflow-x-auto">
                <div className="px-4 py-3 bg-base"><h2 className="font-semibold text-sm">Per-Machine Fleet Report</h2></div>
                <table className="w-full text-sm">
                  <thead className="bg-base border-t border-line">
                    <tr className="text-steel">
                      <th className="text-left label px-4 py-2.5">Machine</th>
                      <th className="text-left label px-4 py-2.5">Class</th>
                      <th className="text-left label px-4 py-2.5">Health</th>
                      <th className="text-right label px-4 py-2.5">Signals</th>
                      <th className="text-right label px-4 py-2.5">Registers</th>
                      <th className="text-right label px-4 py-2.5">Faults</th>
                      <th className="text-right label px-4 py-2.5">Downtime</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(fleetData?.machines || []).map((m) => (
                      <tr key={m.machineId} className="border-t border-line hover:bg-base/60">
                        <td className="px-4 py-2.5 data font-medium text-xs">{m.machineId.toUpperCase()}</td>
                        <td className="px-4 py-2.5 text-xs text-steel">{m.class ? prettyType(m.class) : '—'}</td>
                        <td className="px-4 py-2.5">
                          <span className="data text-xs font-semibold" style={{ color: m.health === 'critical' ? STOPPED : m.health === 'warning' ? IDLE : m.health === 'healthy' ? ACCENT : STEEL }}>{m.score}</span>
                          <span className="text-[10px] text-steel capitalize ml-1">{m.health}</span>
                        </td>
                        <td className="px-4 py-2.5 data text-xs text-right">{fmtNum(m.namedCount + m.ioCount)}</td>
                        <td className="px-4 py-2.5 data text-xs text-right text-steel">{fmtNum(m.registers)}</td>
                        <td className="px-4 py-2.5 data text-xs text-right" style={{ color: m.faultCount ? STOPPED : STEEL }}>{m.faultCount}</td>
                        <td className="px-4 py-2.5 data text-xs text-right text-idle">{m.downtimeMs ? fmtDuration(m.downtimeMs) : '—'}</td>
                      </tr>
                    ))}
                    {(fleetData?.machines || []).length === 0 && <tr><td colSpan={7} className="text-center text-steel py-8">No machines.</td></tr>}
                  </tbody>
                </table>
              </div>
            </div>
          )
        )}

        {/* ---- RELIABILITY ---- */}
        {tab === 'reliability' && (
          relLoading ? <Spinner /> : (
            <div className="space-y-5">
              <div className="text-xs text-steel">MTBF / MTTR / availability over the last {relData?.windowDays || 30} days.</div>
              {(relData?.machines || []).length === 0 ? (
                <div className="panel p-10 text-center text-steel">No downtime in the window — nothing to compute.</div>
              ) : (
                <div className="panel overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead className="bg-base">
                      <tr className="text-steel">
                        <th className="text-left label px-4 py-2.5">Machine</th>
                        <th className="text-right label px-4 py-2.5">Availability</th>
                        <th className="text-right label px-4 py-2.5">MTBF</th>
                        <th className="text-right label px-4 py-2.5">MTTR</th>
                        <th className="text-right label px-4 py-2.5">Events</th>
                        <th className="text-right label px-4 py-2.5">Downtime</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(relData?.machines || []).map((m) => (
                        <tr key={m.machineId} className="border-t border-line hover:bg-base/60">
                          <td className="px-4 py-2.5 data font-medium text-xs">{m.machineId.toUpperCase()}</td>
                          <td className="px-4 py-2.5 data text-xs text-right" style={{ color: m.availability >= 95 ? ACCENT : m.availability >= 80 ? IDLE : STOPPED }}>{m.availability}%</td>
                          <td className="px-4 py-2.5 data text-xs text-right">{fmtDuration(m.mtbfMs)}</td>
                          <td className="px-4 py-2.5 data text-xs text-right text-idle">{fmtDuration(m.mttrMs)}</td>
                          <td className="px-4 py-2.5 data text-xs text-right">{m.events}</td>
                          <td className="px-4 py-2.5 data text-xs text-right text-steel">{fmtDuration(m.downtimeMs)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )
        )}
      </div>
    </div>
  );
}

interface PlantRowProps {
  label: string;
  value: number;
  total: number;
  color: string;
}

function PlantRow({ label, value, total, color }: PlantRowProps) {
  const pct = total ? (value / total) * 100 : 0;
  return (
    <div>
      <div className="flex justify-between text-xs mb-0.5">
        <span className="text-steel">{label}</span>
        <span className="data" style={{ color }}>{value}</span>
      </div>
      <div className="h-1 bg-line rounded-full overflow-hidden">
        <div className="h-full rounded-full" style={{ width: `${pct}%`, background: color }} />
      </div>
    </div>
  );
}

// Recharts injects `active`, `payload`, and `label` into a custom <Tooltip content>.
interface ChartTooltipProps {
  active?: boolean;
  payload?: Array<{ value?: MetricValue }>;
  label?: string;
}

function CustomTooltip({ active, payload, label }: ChartTooltipProps) {
  if (!active || !payload?.length) return null;
  return (
    <div className="bg-surface border border-line rounded-lg px-3 py-2 text-xs shadow-lg">
      <div className="text-steel mb-1">{prettyType(label)}</div>
      <div className="data font-semibold text-primary">Output: {fmtNum(payload[0]?.value)}</div>
    </div>
  );
}

function DtTooltip({ active, payload, label }: ChartTooltipProps) {
  if (!active || !payload?.length) return null;
  return (
    <div className="bg-surface border border-line rounded-lg px-3 py-2 text-xs shadow-lg">
      <div className="data text-steel mb-1">{label}</div>
      <div style={{ color: IDLE }}>Downtime: {fmtDuration(payload[0]?.value)}</div>
    </div>
  );
}

// ── Overview: live downtime & error analysis console (real health + downtime) ─
const OV_WINDOWS: [number, string][] = [[7, '7d'], [30, '30d'], [90, '90d']];

function OverviewReport() {
  const [days, setDays] = useState(30);
  const { data, isLoading } = useQuery({
    queryKey: ['reports', 'overview', days],
    queryFn: () => reportsApi.overview({ days }).then((r) => r.data),
    refetchInterval: 30000,
  });
  if (isLoading) return <Spinner />;

  const k = data?.kpis;
  const statusMix = data?.statusMix || [];
  const errorsByStatus = data?.errorsByStatus || [];
  const downtimeByMachine = data?.downtimeByMachine || [];
  const windowDays = data?.windowDays || days;

  const errSeg = errorsByStatus.map((e, i) => ({ label: e.label, value: e.count, color: ERROR_COLORS[e.key] || PALETTE[i % PALETTE.length] || STEEL }));
  const statusSeg = statusMix.map((s) => ({ label: s.label, value: s.count, color: STATUS_COLORS[s.key] || STEEL }));
  const dtTotal = downtimeByMachine.reduce((s, m) => s + m.totalMs, 0);
  const dtSeg = downtimeByMachine.map((m, i) => ({ label: m.machineId.toUpperCase(), value: m.totalMs, color: BLUE_RAMP[i % BLUE_RAMP.length] || STEEL }));

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <h2 className="font-semibold text-sm text-primary">Downtime &amp; Error Analysis</h2>
        <div className="panel p-1 inline-flex gap-0.5">
          {OV_WINDOWS.map(([d, label]) => (
            <button key={d} onClick={() => setDays(d)} className={`px-3 py-1 rounded-md text-xs transition-colors ${days === d ? 'bg-accent/10 text-accent font-medium' : 'text-steel hover:text-primary'}`}>{label}</button>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
        <Tile label="Running Machines" value={fmtNum(k?.running || 0)} sub="currently running" color={ACCENT} icon={Play} tint="rgba(13,148,136,0.07)" />
        <Tile label="Stopped Machines" value={fmtNum(k?.stopped || 0)} sub="currently stopped" color={STOPPED} icon={CircleSlash} tint="rgba(220,38,38,0.06)" />
        <Tile label="Offline Machines" value={fmtNum(k?.offline || 0)} sub="not reporting" color={STEEL} icon={Power} tint="rgba(100,116,139,0.06)" />
        <Tile label="Total Errors" value={fmtNum(k?.errors || 0)} sub={`${k?.faults || 0} sensor fault${k?.faults === 1 ? '' : 's'}`} color={k?.errors ? STOPPED : ACCENT} icon={AlertTriangle} tint="rgba(220,38,38,0.06)" />
        <Tile label={`Downtime (${windowDays}d)`} value={fmtDuration(k?.downtimeMs || 0)} sub={`${k?.downtimeEvents || 0} events`} color={IDLE} icon={Clock} tint="rgba(217,119,6,0.06)" />
      </div>

      <div className="grid lg:grid-cols-2 gap-5">
        <AnalysisCard title="Error Distribution by Status" subtitle="Live anomalies, classified by the health engine" icon={AlertTriangle}>
          <div className="grid sm:grid-cols-2 gap-5 items-center">
            <div className="flex justify-center">
              <Donut segments={errSeg} emptyColor={ACCENT}>
                <span className="label">Total Errors</span>
                <span className="data text-3xl font-bold" style={{ color: k?.errors ? STOPPED : ACCENT }}>{fmtNum(k?.errors || 0)}</span>
                <span className="text-[11px] text-steel mt-0.5">{k?.criticalMachines || 0} critical · {k?.warningMachines || 0} warn</span>
              </Donut>
            </div>
            <div>
              {errSeg.length === 0
                ? <div className="text-sm text-running flex items-center gap-1.5 py-4"><ShieldCheck size={15} /> Fleet clear — no active errors.</div>
                : <Legend rows={errSeg} total={k?.errors} format={(v) => fmtNum(v)} />}
            </div>
          </div>
        </AnalysisCard>

        <AnalysisCard title="Downtime Distribution by Machine" subtitle={`Recorded downtime over the last ${windowDays} days`} icon={Clock}>
          <div className="grid sm:grid-cols-2 gap-5 items-center">
            <div className="flex justify-center">
              <Gauge segments={dtSeg}>
                <span className="label">Total Downtime</span>
                <span className="data text-2xl font-bold text-primary">{fmtDuration(dtTotal)}</span>
                <span className="text-[11px] text-steel mt-0.5">{k?.openDowntime || 0} open now</span>
              </Gauge>
            </div>
            <div>
              {dtSeg.length === 0
                ? <div className="text-sm text-steel flex items-center gap-1.5 py-4"><ShieldCheck size={15} className="text-running" /> No downtime in this window.</div>
                : <Legend rows={dtSeg} total={dtTotal} format={(v) => fmtDuration(v)} />}
            </div>
          </div>
        </AnalysisCard>
      </div>

      <div className="grid lg:grid-cols-2 gap-5">
        <AnalysisCard title="Machine Status Mix" subtitle={`${k?.machines || 0} machines · avg health ${k?.avgHealth || 0}`} icon={GaugeIcon}>
          <div className="grid sm:grid-cols-2 gap-5 items-center">
            <div className="flex justify-center">
              <Donut segments={statusSeg} emptyColor={SLATE}>
                <span className="label">Machines</span>
                <span className="data text-3xl font-bold text-primary">{fmtNum(k?.machines || 0)}</span>
                <span className="text-[11px] text-steel mt-0.5">{k?.running || 0} running</span>
              </Donut>
            </div>
            <div>
              {statusSeg.length === 0
                ? <div className="text-sm text-steel py-4">No machines in scope.</div>
                : <Legend rows={statusSeg} total={k?.machines} format={(v) => fmtNum(v)} scroll={false} />}
            </div>
          </div>
        </AnalysisCard>

        <div className="panel p-5">
          <h2 className="font-semibold text-sm text-primary mb-3">Fleet Snapshot</h2>
          <div className="grid grid-cols-2 gap-3">
            <Mini label="Avg Health" value={`${k?.avgHealth || 0}`} color={(k?.avgHealth || 0) >= 80 ? ACCENT : (k?.avgHealth || 0) >= 50 ? IDLE : STOPPED} />
            <Mini label="Sensor Faults" value={fmtNum(k?.faults || 0)} color={k?.faults ? STOPPED : ACCENT} />
            <Mini label="Critical Machines" value={fmtNum(k?.criticalMachines || 0)} color={k?.criticalMachines ? STOPPED : ACCENT} />
            <Mini label="Open Downtime" value={fmtNum(k?.openDowntime || 0)} color={k?.openDowntime ? IDLE : ACCENT} />
          </div>
          <p className="text-[11px] text-steel/70 mt-4 pt-3 border-t border-line">Errors are live anomalies from the health engine; downtime is from recorded idle/stopped/offline spans. Use the tabs above for the full per-machine breakdown.</p>
        </div>
      </div>
    </div>
  );
}

function Tile({ label, value, sub, color, icon: Icon, tint }: { label: string; value: ReactNode; sub?: string; color: string; icon?: LucideIcon; tint?: string }) {
  return (
    <div className="card p-4" style={{ background: tint }}>
      <div className="flex items-start justify-between">
        <span className="label">{label}</span>
        {Icon && <Icon size={15} style={{ color }} />}
      </div>
      <div className="data text-2xl font-bold mt-2" style={{ color }}>{value}</div>
      {sub && <div className="text-[11px] text-steel mt-1 truncate">{sub}</div>}
    </div>
  );
}

function Mini({ label, value, color }: { label: string; value: ReactNode; color: string }) {
  return (
    <div className="rounded-lg border border-line bg-base p-3">
      <div className="label">{label}</div>
      <div className="data text-xl font-bold mt-1" style={{ color }}>{value}</div>
    </div>
  );
}

function AnalysisCard({ title, subtitle, icon: Icon, children }: { title: string; subtitle?: string; icon?: LucideIcon; children: ReactNode }) {
  return (
    <div className="panel p-5">
      <div className="flex items-start justify-between gap-3 mb-4">
        <div className="flex items-start gap-2 min-w-0">
          {Icon && <span className="w-7 h-7 rounded-lg bg-accent/10 flex items-center justify-center shrink-0"><Icon size={15} className="text-accent" /></span>}
          <div className="min-w-0"><h2 className="font-semibold text-sm text-primary leading-tight">{title}</h2>{subtitle && <p className="text-[11px] text-steel mt-0.5">{subtitle}</p>}</div>
        </div>
        <LiveTag />
      </div>
      {children}
    </div>
  );
}

function LiveTag() {
  return <span className="inline-flex items-center gap-1.5 pill bg-running/10 text-running !text-[10px] font-semibold"><span className="w-1.5 h-1.5 rounded-full bg-running live-dot" /> LIVE</span>;
}

function download(content: string, filename: string) {
  const blob = new Blob([content], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
