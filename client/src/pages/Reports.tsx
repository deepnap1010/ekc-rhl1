// client/src/pages/Reports.tsx — the same selection and the same numbers as
// the Dashboard, laid out as reports. The filter bar is the shared one
// (machine · shift · window, store/filters), so what you pick on the Dashboard
// is what you see here, and every production / time / downtime figure comes
// from the SAME activity dataset (/machines/activity) the Dashboard and the
// machine cards read — one engine, so a report can never disagree with the
// screen it was printed from. Only Reliability (MTBF/MTTR) fetches anything
// of its own.
import { useMemo, useState, type ReactNode } from 'react';
import { useQuery, keepPreviousData } from '@tanstack/react-query';
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell } from 'recharts';
import {
  Download, FileBarChart, Clock, ShieldCheck, Factory, Activity, Timer, WifiOff,
  Gauge as GaugeIcon, CalendarClock, type LucideIcon,
} from 'lucide-react';
import { reportsApi, machineApi, downtimeApi } from '../api/endpoints';
import { StatCard, Spinner } from '../components/ui';
import { Donut, Gauge, Legend, STATUS_COLORS, BLUE_RAMP } from '../components/charts';
import PageHeader from '../components/PageHeader';
import GlobalFilters, { useGlobalWindow } from '../components/GlobalFilters';
import { fmtNum, fmtDuration, prettyType, prettyKey } from '../lib/format';
import { groupMachines } from '../lib/machineOrder';
import { borrowedFrom } from '../lib/production';
import { sumActivity } from '../lib/metrics';
import { liveStatus } from '../lib/machineStatus';
import TargetsReport from '../components/TargetsReport';
import DiaScheduleReport from '../components/DiaScheduleReport';
import { ScheduleDiaModal } from '../components/ScheduleDia';
import { useAuthStore } from '../store/auth';
import { toast } from '../store/toast';
import type { MachineActivityRow, MetricValue } from '../types/api';
import { useMachineName, useMachineTitle } from '../lib/machineName';

const ACCENT = '#0D9488';
const IDLE   = '#D97706';
const STOPPED = '#DC2626';
const STEEL  = '#64748B';
const SLATE  = '#94A3B8';
const DEEP_RED = '#991B1B';
const PIE_COLORS = [ACCENT, '#6366F1', '#EC4899', '#8B5CF6', '#3B82F6', IDLE];
const TABS = ['overview', 'production', 'targets', 'dia', 'downtime', 'reliability'];

const downOf = (r: MachineActivityRow): number => r.idleMs + r.stoppedMs;   // signal lost is darkness, not downtime (lib/metrics)

export default function Reports() {
  const mName = useMachineName();
  const mTitle = useMachineTitle();
  const [tab, setTab] = useState('overview');
  const [schedOpen, setSchedOpen] = useState(false);
  const can = useAuthStore((st) => st.can);
  const { f, fromISO, toISO, windowLabel } = useGlobalWindow();
  const machineId = f.machineId;
  const mid = machineId || undefined;

  // THE dataset — same query key as the Dashboard, so the two pages share one
  // cache entry and one set of figures for the selected window.
  const { data: actData, isLoading: actLoading } = useQuery({
    queryKey: ['activity', fromISO, toISO],
    queryFn: () => machineApi.activity({ from: fromISO as string, to: toISO as string }),
    enabled: !!fromISO && !!toISO,
    refetchInterval: 30_000,
    placeholderData: keepPreviousData,
  });
  const windowMs = actData?.meta?.windowMs ?? 0;
  const allRows = useMemo<MachineActivityRow[]>(() => actData?.data || [], [actData]);
  const rows = useMemo(
    () => (machineId ? allRows.filter((r) => r.code.toLowerCase() === machineId.toLowerCase()) : allRows),
    [allRows, machineId],
  );
  const t = useMemo(() => sumActivity(rows, windowMs), [rows, windowMs]);

  // Current statuses (the pills), for the status mix — same rule as every pill.
  const { data: machineList } = useQuery({
    queryKey: ['machines', 'selector'],
    queryFn: () => machineApi.list({ limit: 200, sort: 'name' }).then((r) => r.data),
    staleTime: 60_000,
    refetchInterval: 60_000,
  });
  // Downtime EVENTS in the window (durations come from the activity rows above,
  // so they match the Dashboard; the span log only says how many and how many are open).
  const { data: dtSummary } = useQuery({
    queryKey: ['downtime', 'summary', fromISO, toISO, machineId],
    queryFn: () => downtimeApi.summary({ from: fromISO, to: toISO, machineId: mid }).then((r) => r.data),
    enabled: !!fromISO && !!toISO,
    refetchInterval: 60_000,
  });
  const { data: relData, isLoading: relLoading } = useQuery({
    queryKey: ['reports', 'reliability', machineId, fromISO, toISO],
    queryFn: () => reportsApi.reliability({ machineId: mid, from: fromISO, to: toISO }).then((r) => r.data),
    refetchInterval: 60_000,
    enabled: tab === 'reliability' && !!fromISO && !!toISO,
  });

  // Output by FAMILY (cutting, SPG, bottom milling…) — the Dashboard's grouping.
  const outputByGroup = useMemo(() => groupMachines(rows)
    .map((g) => ({ group: g.label, output: g.machines.reduce((n, m) => n + (m.production ?? 0), 0), machines: g.machines.length }))
    .filter((g) => g.output > 0)
    .sort((a, b) => b.output - a.output), [rows]);
  const prodRows = useMemo(() => [...rows].sort((a, b) => (b.production ?? -1) - (a.production ?? -1) || a.code.localeCompare(b.code)), [rows]);
  const downRows = useMemo(() => rows.filter((r) => downOf(r) > 0).sort((a, b) => downOf(b) - downOf(a)), [rows]);

  // The whole review — every sheet, this selection — as one workbook built
  // server-side from the same engines these tabs read.
  const [exporting, setExporting] = useState(false);
  const exportExcel = async (): Promise<void> => {
    if (!fromISO || !toISO) return;
    setExporting(true);
    try {
      const blob = await reportsApi.exportWorkbook({ from: fromISO, to: toISO, machineId: mid, tz: -new Date().getTimezoneOffset(), label: windowLabel });
      const day = (iso: string): string => iso.slice(0, 10);
      saveBlob(blob, `EKC_SmartFactory_${machineId ? `${machineId.replace(/[^A-Za-z0-9]+/g, '_')}_` : ''}${day(fromISO)}_to_${day(toISO)}.xlsx`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not build the workbook');
    } finally {
      setExporting(false);
    }
  };
  const scopeLabel = machineId ? mName(machineId) : 'All machines';

  return (
    <div>
      <PageHeader
        title="Reports"
        subtitle={`${scopeLabel} · ${windowLabel}`}
        right={(
          <button onClick={() => { void exportExcel(); }} disabled={exporting || !fromISO}
            title="Every sheet of this review — summary, machines, targets, downtime events and reasons, production events, reliability — for the selected window"
            className="flex items-center gap-1.5 bg-accent/10 text-accent border border-accent/20 text-sm px-3 py-1.5 rounded-lg hover:bg-accent/20 disabled:opacity-60">
            <Download size={14} /> {exporting ? 'Preparing workbook…' : 'Export Excel'}
          </button>
        )}
      />

      <div className="px-4 sm:px-6 pb-8 space-y-5 pt-5">
        {/* The Dashboard's selection — one bar, both pages. */}
        <GlobalFilters modalSubtitle="Every report on this page uses this window"
          extra={can('production', 'update') && (
            /* Scheduling lives behind this one button, on every page that shows
               what the machines are making. The Dia tab beside it only READS. */
            <button onClick={() => setSchedOpen(true)}
              className="ml-auto inline-flex items-center gap-1.5 rounded-lg border border-accent/30 bg-accent/5 px-2.5 py-1.5 text-xs font-medium text-accent hover:bg-accent/10 transition-colors shrink-0"
              title="Set a dia to switch itself on a machine at a future moment">
              <CalendarClock size={13} /> Schedule Dia
            </button>
          )} />

        <div className="flex gap-1 bg-base rounded-lg p-0.5 border border-line w-fit max-w-full overflow-x-auto">
          {TABS.map((tb) => (
            <button key={tb} onClick={() => setTab(tb)}
              className={`px-3 py-1.5 rounded-md text-xs capitalize transition-colors whitespace-nowrap ${tab === tb ? 'bg-accent/15 text-accent' : 'text-steel hover:bg-white/5'}`}>
              {tb}
            </button>
          ))}
        </div>

        {schedOpen && <ScheduleDiaModal onClose={() => setSchedOpen(false)} />}

        {/* ---- OVERVIEW: the Dashboard's totals, as a report ---- */}
        {tab === 'overview' && (actLoading && !actData ? <Spinner /> : (
          <OverviewReport rows={rows} t={t} windowLabel={windowLabel} machineId={machineId}
            events={dtSummary?.totalEvents || 0} openNow={dtSummary?.openEvents || 0}
            machines={(machineList || []).filter((m) => !machineId || (m.code || m.machineId) === machineId)} />
        ))}

        {/* ---- DIA: what is running, and what switches in next ---- */}
        {tab === 'dia' && <DiaScheduleReport machineId={mid} />}

        {/* ---- TARGETS ---- */}
        {tab === 'targets' && <TargetsReport machineId={mid} from={fromISO} to={toISO} />}

        {/* ---- PRODUCTION ---- */}
        {tab === 'production' && (actLoading && !actData ? <Spinner /> : (
          <div className="space-y-5">
            <div className="grid grid-cols-2 lg:grid-cols-3 gap-3">
              <StatCard label="Total Output" value={fmtNum(t.production)} sub={`pieces made · ${windowLabel}`} accent={ACCENT} icon={FileBarChart} />
              <StatCard label="Counting Machines" value={t.reportedProduction} sub="report a piece counter" accent={STEEL} />
              <StatCard label="Machines" value={t.machines} sub={`${t.reported} sent data in this window`} accent={STEEL} />
            </div>

            <div className="panel p-5">
              <h2 className="font-semibold text-sm mb-4">Output by Machine Group</h2>
              {outputByGroup.length === 0 ? (
                <div className="text-sm text-steel py-10 text-center">No machine reported a piece counter in this window.</div>
              ) : (
                <ResponsiveContainer width="100%" height={220}>
                  <BarChart data={outputByGroup} barSize={28}>
                    <XAxis dataKey="group" tick={{ fill: STEEL, fontSize: 10 }} axisLine={false} tickLine={false} />
                    <YAxis tick={{ fill: STEEL, fontSize: 10 }} axisLine={false} tickLine={false} tickFormatter={(v) => fmtNum(v)} />
                    <Tooltip content={<CustomTooltip />} cursor={{ fill: 'rgba(0,0,0,0.03)' }} />
                    <Bar dataKey="output" radius={[4, 4, 0, 0]}>
                      {outputByGroup.map((_, i) => <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />)}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              )}
            </div>

            <div className="panel overflow-x-auto">
              <div className="px-4 py-3 bg-base"><h2 className="font-semibold text-sm">Machine-Level Production</h2></div>
              <table className="w-full text-sm">
                <thead className="bg-base border-t border-line">
                  <tr className="text-steel">
                    <th className="text-left label px-4 py-2.5">Machine</th>
                    <th className="text-left label px-4 py-2.5">Type</th>
                    <th className="text-left label px-4 py-2.5">Counter</th>
                    <th className="text-left label px-4 py-2.5" title="What the machine mostly did in this window">State</th>
                    <th className="text-right label px-4 py-2.5">Readings</th>
                    <th className="text-right label px-4 py-2.5">Runtime</th>
                    <th className="text-right label px-4 py-2.5">Output</th>
                  </tr>
                </thead>
                <tbody>
                  {prodRows.map((m) => (
                    <tr key={m.code} className="border-t border-line hover:bg-white/5">
                      <td className="px-4 py-2.5 data font-medium text-xs" title={mTitle(m.code)}>{mName(m.code)}</td>
                      <td className="px-4 py-2.5 text-xs text-steel">{prettyType(m.type)}</td>
                      <td className="px-4 py-2.5 text-xs text-steel">{borrowedFrom(m) ?? (m.productionKey ? prettyKey(m.productionKey) : '—')}</td>
                      <td className="px-4 py-2.5"><StatePill status={m.status} /></td>
                      <td className="px-4 py-2.5 data text-xs text-right text-steel">{fmtNum(m.readings)}</td>
                      <td className="px-4 py-2.5 data text-xs text-right">{m.runningMs ? fmtDuration(m.runningMs) : '—'}</td>
                      <td className="px-4 py-2.5 data text-xs text-right">
                        {m.production != null ? fmtNum(m.production) : <span className="text-steel">—</span>}
                      </td>
                    </tr>
                  ))}
                  {prodRows.length === 0 && (
                    <tr><td colSpan={7} className="text-center text-steel py-8">No machines in this window</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        ))}

        {/* ---- DOWNTIME ---- */}
        {tab === 'downtime' && (actLoading && !actData ? <Spinner /> : (
          <div className="space-y-5">
            <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
              <StatCard label="Total Downtime" value={fmtDuration(t.downtimeMs)} sub={`idle + stopped · ${windowLabel}`} accent={DEEP_RED} icon={Clock} />
              <StatCard label="Idle" value={fmtDuration(t.idleMs)} accent={IDLE} />
              <StatCard label="Stopped" value={fmtDuration(t.stoppedMs)} accent={STOPPED} />
              <StatCard label="Signal Lost" value={fmtDuration(t.offlineMs)} sub="not counted as downtime" accent={SLATE} icon={WifiOff} />
              <StatCard label="Events" value={fmtNum(dtSummary?.totalEvents || 0)} sub={`${dtSummary?.openEvents || 0} open now`} accent={STEEL} />
            </div>

            {downRows.length === 0 ? (
              <div className="panel p-10 text-center text-steel">No downtime in this window.</div>
            ) : (
              <div className="grid lg:grid-cols-2 gap-5">
                <div className="panel p-5">
                  <h2 className="font-semibold text-sm mb-4">Top 10 — Downtime by Machine</h2>
                  <ResponsiveContainer width="100%" height={240}>
                    <BarChart data={downRows.slice(0, 10).map((r) => ({ code: mName(r.code), idle: r.idleMs, stopped: r.stoppedMs }))} layout="vertical" barSize={14}>
                      <XAxis type="number" tick={{ fill: STEEL, fontSize: 10 }} axisLine={false} tickLine={false} tickFormatter={(v) => fmtDuration(v)} />
                      <YAxis type="category" dataKey="code" tick={{ fill: STEEL, fontSize: 9 }} axisLine={false} tickLine={false} width={120} />
                      <Tooltip content={<DtTooltip />} cursor={{ fill: 'rgba(0,0,0,0.03)' }} />
                      <Bar dataKey="idle" stackId="d" fill={IDLE} />
                      <Bar dataKey="stopped" stackId="d" fill={STOPPED} radius={[0, 4, 4, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                </div>

                <div className="panel p-5">
                  <h2 className="font-semibold text-sm mb-1">Time by State</h2>
                  <p className="text-[11px] text-steel mb-4">Recorded spans: {fmtNum(dtSummary?.totalEvents || 0)} events in this window</p>
                  <div className="space-y-3">
                    {([
                      ['idle', 'Idle', t.idleMs, IDLE], ['stopped', 'Stopped', t.stoppedMs, STOPPED], ['offline', 'Signal lost', t.offlineMs, SLATE],
                    ] as const).map(([key, label, ms, color]) => {
                      const ev = (dtSummary?.byType || []).find((b) => b.type === key)?.events || 0;
                      const denom = t.idleMs + t.stoppedMs + t.offlineMs || 1;
                      return (
                        <div key={key}>
                          <div className="flex justify-between text-xs mb-1">
                            <span className="text-steel">{label}</span>
                            <span className="data">{fmtDuration(ms)}{ev ? ` · ${ev} event${ev === 1 ? '' : 's'}` : ''}</span>
                          </div>
                          <div className="h-1.5 bg-line rounded-full overflow-hidden">
                            <div className="h-full rounded-full" style={{ width: `${(ms / denom) * 100}%`, background: color }} />
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              </div>
            )}
          </div>
        ))}

        {/* ---- RELIABILITY ---- */}
        {tab === 'reliability' && (
          relLoading ? <Spinner /> : (
            <div className="space-y-5">
              <div className="text-xs text-steel">MTBF / MTTR / availability · {windowLabel}.</div>
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
                          <td className="px-4 py-2.5 data font-medium text-xs" title={mTitle(m.machineId)}>{mName(m.machineId)}</td>
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

// ── Overview: the Dashboard's window totals, as a report ─────────────────────
function OverviewReport({ rows, t, windowLabel, machineId, events, openNow, machines }: {
  rows: MachineActivityRow[]; t: ReturnType<typeof sumActivity>; windowLabel: string; machineId: string;
  events: number; openNow: number; machines: { code?: string; machineId?: string; status?: string; lastReadingAt?: string | null }[];
}) {
  const mName = useMachineName();
  // What the window was spent on — the Dashboard's donut, same five figures.
  const timeSeg = [
    { key: 'running', label: 'Runtime', value: t.runningMs, color: ACCENT },
    { key: 'idle', label: 'Idle', value: t.idleMs, color: IDLE },
    { key: 'stopped', label: 'Stopped', value: t.stoppedMs, color: STOPPED },
    { key: 'offline', label: 'Signal lost', value: t.offlineMs, color: SLATE },
  ].filter((s) => s.value > 0);
  // Where the downtime went, machine by machine (idle + stopped, window-clipped).
  const dtRows = rows.filter((r) => downOf(r) > 0).sort((a, b) => downOf(b) - downOf(a));
  const dtSeg = dtRows.map((r, i) => ({ label: mName(r.code), value: downOf(r), color: BLUE_RAMP[i % BLUE_RAMP.length] || STEEL }));
  // What every machine says RIGHT NOW — the same rule as its pill (10-minute
  // silence = Signal Lost), so this donut and the Machines page agree.
  const now: Record<string, number> = { running: 0, idle: 0, stopped: 0, offline: 0 };
  for (const m of machines) {
    const s = liveStatus({ status: m.status, lastReadingAt: m.lastReadingAt } as Parameters<typeof liveStatus>[0]);
    now[s] = (now[s] || 0) + 1;
  }
  const statusSeg = [
    { key: 'running', label: 'Running' }, { key: 'idle', label: 'Idle' }, { key: 'stopped', label: 'Stopped' }, { key: 'offline', label: 'Signal lost' },
  ].map((s) => ({ label: s.label, value: now[s.key] || 0, color: STATUS_COLORS[s.key] || STEEL })).filter((s) => s.value > 0);
  const total = machines.length;

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <h2 className="font-semibold text-sm text-primary">{machineId ? mName(machineId) : 'Fleet'} · {windowLabel}</h2>
        <span className="text-[11px] text-steel">{t.machines} machine{t.machines === 1 ? '' : 's'} · {t.reported} sent data in this window</span>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
        <Tile label="Production" value={fmtNum(t.production)} sub={`${t.reportedProduction} of ${t.machines} counters reporting`} color={ACCENT} icon={Factory} tint="rgba(13,148,136,0.07)" />
        <Tile label="Availability" value={`${t.availabilityPct}%`} sub="runtime ÷ window" color={t.availabilityPct >= 80 ? ACCENT : t.availabilityPct >= 50 ? IDLE : STOPPED} icon={Activity} />
        <Tile label="Runtime" value={fmtDuration(t.runningMs)} sub="machine reporting, not down" color={ACCENT} icon={Timer} />
        <Tile label="Downtime" value={fmtDuration(t.downtimeMs)} sub={`idle + stopped · ${fmtNum(events)} events · ${openNow} open now`} color={DEEP_RED} icon={Clock} tint="rgba(220,38,38,0.05)" />
        <Tile label="Signal Lost" value={fmtDuration(t.offlineMs)} sub="no data — not counted as downtime" color={STEEL} icon={WifiOff} tint="rgba(100,116,139,0.06)" />
      </div>

      <div className="grid lg:grid-cols-2 gap-5">
        <AnalysisCard title="Output & time split" subtitle={`how ${machineId ? 'the machine' : 'the fleet'} spent ${windowLabel}`} icon={Factory}>
          <div className="grid sm:grid-cols-2 gap-5 items-center">
            <div className="flex justify-center">
              <Donut segments={timeSeg} emptyColor={SLATE}>
                <span className="data text-3xl font-bold text-primary leading-none">{t.availabilityPct}%</span>
                <span className="label mt-1">availability</span>
              </Donut>
            </div>
            <div>
              {timeSeg.length === 0
                ? <div className="text-sm text-steel py-4">Nothing recorded in this window.</div>
                : <Legend rows={timeSeg} total={t.runningMs + t.idleMs + t.stoppedMs + t.offlineMs} format={(v) => fmtDuration(v)} scroll={false} />}
            </div>
          </div>
        </AnalysisCard>

        <AnalysisCard title="Downtime Distribution by Machine" subtitle={`idle + stopped · ${windowLabel}`} icon={Clock}>
          <div className="grid sm:grid-cols-2 gap-5 items-center">
            <div className="flex justify-center">
              <Gauge segments={dtSeg}>
                <span className="label">Total Downtime</span>
                <span className="data text-2xl font-bold text-primary">{fmtDuration(t.downtimeMs)}</span>
                <span className="text-[11px] text-steel mt-0.5">{openNow} open now</span>
              </Gauge>
            </div>
            <div>
              {dtSeg.length === 0
                ? <div className="text-sm text-steel flex items-center gap-1.5 py-4"><ShieldCheck size={15} className="text-running" /> No downtime in this window.</div>
                : <Legend rows={dtSeg} total={t.downtimeMs} format={(v) => fmtDuration(v)} />}
            </div>
          </div>
        </AnalysisCard>
      </div>

      <div className="grid lg:grid-cols-2 gap-5">
        <AnalysisCard title="Machine Status Now" subtitle={`${total} machine${total === 1 ? '' : 's'} · the same word as each machine's pill`} icon={GaugeIcon}>
          <div className="grid sm:grid-cols-2 gap-5 items-center">
            <div className="flex justify-center">
              <Donut segments={statusSeg} emptyColor={SLATE}>
                <span className="label">Machines</span>
                <span className="data text-3xl font-bold text-primary">{fmtNum(total)}</span>
                <span className="text-[11px] text-steel mt-0.5">{now.running || 0} running</span>
              </Donut>
            </div>
            <div>
              {statusSeg.length === 0
                ? <div className="text-sm text-steel py-4">No machines in scope.</div>
                : <Legend rows={statusSeg} total={total} format={(v) => fmtNum(v)} scroll={false} />}
            </div>
          </div>
        </AnalysisCard>

        <div className="panel p-5">
          <h2 className="font-semibold text-sm text-primary mb-3">Where to look next</h2>
          <div className="grid grid-cols-2 gap-3">
            <Mini label="Idle" value={fmtDuration(t.idleMs)} color={IDLE} />
            <Mini label="Stopped" value={fmtDuration(t.stoppedMs)} color={STOPPED} />
            <Mini label="Machines dark now" value={fmtNum(now.offline || 0)} color={now.offline ? STEEL : ACCENT} />
            <Mini label="Open downtime" value={fmtNum(openNow)} color={openNow ? IDLE : ACCENT} />
          </div>
          <p className="text-[11px] text-steel/70 mt-4 pt-3 border-t border-line">Every figure here is the Dashboard's for the same selection. Use the tabs above for the per-machine breakdown, and the Downtime page for the reasons operators gave.</p>
        </div>
      </div>
    </div>
  );
}

function StatePill({ status }: { status: string }): JSX.Element {
  const cls = status === 'running' ? 'bg-accent/10 text-accent' : status === 'idle' ? 'bg-idle/10 text-idle' : status === 'stopped' ? 'bg-stopped/10 text-stopped' : 'bg-white/5 text-steel';
  return <span className={`pill text-[10px] ${cls}`}>{status === 'offline' ? 'signal lost' : status}</span>;
}

// Recharts injects `active`, `payload`, and `label` into a custom <Tooltip content>.
interface ChartTooltipProps {
  active?: boolean;
  payload?: Array<{ value?: MetricValue; name?: string; color?: string }>;
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
      {payload.map((p) => <div key={p.name} style={{ color: p.color }} className="capitalize">{p.name}: {fmtDuration(p.value)}</div>)}
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
      {sub && <div className="text-[11px] text-steel mt-1 truncate" title={sub}>{sub}</div>}
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
      </div>
      {children}
    </div>
  );
}

function saveBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
