// client/src/pages/Dashboard.tsx — fleet ANALYSIS console (aggregate insights, not re-lists)
// ONE filter selection (machine / shift / date window, store/filters) drives the
// whole page. Reading order: filters → machine GROUPS (each family's own totals
// and machines) → the fleet roll-up those groups sum to → rankings. Every figure
// is reconstructed server-side from telemetry + downtime spans by the shared
// activity engine (/machines/activity) — one dataset, so a group's totals and the
// fleet roll-up can never disagree. OEE stays absent: its inputs don't exist in
// the data and are never fabricated.
import { useState, useMemo, type ReactNode } from 'react';
import { useQuery, keepPreviousData } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import type { LucideIcon } from 'lucide-react';
import {
  Bell, AlertTriangle, CheckCircle2,
  Gauge, Clock, ArrowUpRight, CalendarRange,
  Boxes,
  Sparkles, Wrench, TrendingUp, Zap,
  Factory, Trophy, TrendingDown, RotateCcw,
} from 'lucide-react';
import { dashboardApi, machineApi } from '../api/endpoints';
import PageHeader from '../components/PageHeader';
import AnalyticsModal from '../components/AnalyticsModal';
import { CustomRangeModal } from '../components/RangeFilter';
import MachineGroups from '../components/MachineGroups';
import ProductionVsTarget from '../components/ProductionVsTarget';
import { Donut, Legend } from '../components/charts';
import { fmtNum, fmtDuration, fmtTime, fmtRangeLabel } from '../lib/format';
import { prettyType } from '../lib/format';
import { sumActivity } from '../lib/metrics';
import { flattenParams } from '../lib/params';
import { computeHeadline } from '../lib/headline';
import { useDashboardLive } from '../hooks/useLive';
import { useFilters, resolveRange, shiftApplies, presetLabel, DATE_PRESETS } from '../store/filters';
import { useAppConfig } from '../hooks/useAppConfig';
import type { MachineActivityRow } from '../types/api';

const TEAL = '#0D9488', AMBER = '#D97706', RED = '#DC2626', STEEL = '#64748B', SLATE = '#94A3B8', VIOLET = '#8B5CF6', DEEP_RED = '#991B1B';

export default function Dashboard() {
  const live = useDashboardLive();
  const { shifts } = useAppConfig();   // shared server-side shift config
  const f = useFilters();

  // Shared filter selection → one concrete window every query below uses.
  const range = resolveRange(f, shifts);
  const fromISO = range?.from.toISOString();
  const toISO = range?.to.toISOString();
  // THE dataset: what every machine did in the window. Drives the output/time
  // chart, the groups and the rankings — one fetch, one truth.
  const { data: actData, isFetching: actLoading } = useQuery({
    queryKey: ['activity', fromISO, toISO],
    queryFn: () => machineApi.activity({ from: fromISO as string, to: toISO as string }),
    enabled: !!fromISO && !!toISO,
    refetchInterval: 15000,
    placeholderData: keepPreviousData,
  });

  // The window comes back WITH the rows (the server clips `to` to now), so every
  // ratio divides by exactly the window its numerator was measured over. Deriving
  // the length from the filter instead would, for the seconds a new window is
  // loading, divide freshly-selected windows into the previous window's rows —
  // availability then reads 0% or several thousand percent.
  const windowMs = actData?.meta?.windowMs ?? 0;
  const stale = !!actData?.meta && actData.meta.from !== fromISO;   // previous window still on screen

  // Alerts + the per-machine health detail behind the alert chart. Deliberately
  // WITHOUT the date window: an alert is a live condition, and passing a month /
  // year window would make this endpoint re-scan that whole range every poll for
  // figures this page now reads from the activity dataset above.
  const { data: ov } = useQuery({
    queryKey: ['dashboard', 'overview', f.machineId],
    queryFn: () => dashboardApi.overview({ machineId: f.machineId || undefined }).then((r) => r.data),
    refetchInterval: 30000,
    placeholderData: keepPreviousData,
  });

  // Machine selector options — the real machine dataset, not a hard-coded list.
  const { data: machineList } = useQuery({
    queryKey: ['machines', 'selector'],
    queryFn: () => machineApi.list({ limit: 200, sort: 'name' }).then((r) => r.data),
    staleTime: 60_000,
  });

  const allRows = useMemo<MachineActivityRow[]>(() => actData?.data || [], [actData]);
  // A machine selection scopes the whole page (header, chart, groups) to it.
  const rows = useMemo(
    () => (f.machineId ? allRows.filter((r) => r.code.toLowerCase() === f.machineId.toLowerCase()) : allRows),
    [allRows, f.machineId],
  );
  const t = useMemo(() => sumActivity(rows, windowMs), [rows, windowMs]);

  const alerts = ov?.alerts || { total: 0, critical: 0, warning: 0, info: 0, byCategory: {} as Record<string, number> };
  // Which signal each machine would headline — the same judgement the machine
  // cards make, made once here so a group can show an average where there is no
  // piece counter. Keyed by CODE, uppercased.
  const signals = useMemo(() => {
    const out: Record<string, { key: string; label: string; unit?: string }> = {};
    for (const m of machineList || []) {
      const code = String(m.code || m.machineId || m._id).toUpperCase();
      const cp = m.currentParameters || {};
      const h = computeHeadline(flattenParams(Object.keys(cp).length ? cp : (m.latestData || {})));
      if (h?.key) out[code] = { key: h.key, label: h.label, unit: h.unit };
    }
    return out;
  }, [machineList]);

  const [drill, setDrill] = useState<string | null>(null);
  // Bumping this remounts the group panels, which is how a reset also clears the
  // per-group window overrides — they are local to each panel by design.
  const [resetTick, setResetTick] = useState(0);
  const atDefaults = !f.machineId && !f.shiftName && f.preset === 'today';
  const [pickRange, setPickRange] = useState(false);

  const selectedMachine = f.machineId
    ? (machineList || []).find((m) => (m.code || m.machineId) === f.machineId)
    : null;
  const scopeLabel = f.machineId ? String(f.machineId).toUpperCase() : 'All machines';
  const windowLabel = f.preset === 'custom' && range
    ? fmtRangeLabel(range.from, range.to)
    : f.shiftName && shiftApplies(f.preset)
      ? `${f.shiftName} · ${presetLabel(f.preset)}`
      : presetLabel(f.preset);

  // Freshest reading across the selection — "last updated" for the dashboard.
  const lastReading = useMemo(() => {
    const ts = rows.map((r) => r.lastSeen).filter(Boolean).map((x) => new Date(x as string).getTime());
    return ts.length ? Math.max(...ts) : null;
  }, [rows]);
  const lastIsLive = lastReading != null && (Date.now() - lastReading) <= 120_000;

  // How the window was actually spent — the ONE place these five figures live.
  const timeSeg = [
    { key: 'running', label: 'Runtime', value: t.runningMs, color: TEAL },
    { key: 'idle', label: 'Idle', value: t.idleMs, color: AMBER },
    { key: 'stopped', label: 'Stopped', value: t.stoppedMs, color: RED },
    { key: 'offline', label: 'Signal lost', value: t.offlineMs, color: SLATE },
  ].filter((s) => s.value > 0);
  const observedMs = t.runningMs + t.downtimeMs;

  // Performance rankings — availability over the window (the only officially
  // derivable performance metric), computed from the SAME rows as everything else.
  const rankings = useMemo(() => allRows
    .map((r) => ({
      code: r.code,
      production: r.production,
      runningMs: r.runningMs,
      downtimeMs: r.idleMs + r.stoppedMs + r.offlineMs,
      availabilityPct: windowMs ? Math.round((r.runningMs / windowMs) * 100) : 0,
    }))
    .sort((a, b) => (b.availabilityPct - a.availabilityPct)
      || ((b.production ?? -1) - (a.production ?? -1))
      || a.code.localeCompare(b.code))
    .map((r, i) => ({ ...r, rank: i + 1 })), [allRows, windowMs]);
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
        {/* Shared filters — every figure on the page derives from this selection */}
        <div className="panel p-3 space-y-2.5">
          <div className="flex items-center gap-2 flex-wrap">
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
              value={shiftApplies(f.preset) ? f.shiftName : ''}
              onChange={(e) => f.set({ shiftName: e.target.value })}
              disabled={!shiftApplies(f.preset)}
              className={`rounded-xl border px-3 py-2 text-sm outline-none cursor-pointer transition-colors hover:border-accent/40 disabled:opacity-45 disabled:cursor-not-allowed ${f.shiftName && shiftApplies(f.preset) ? 'border-accent/40 bg-accent/5 text-accent font-medium' : 'border-line bg-base text-primary'}`}
              title={shiftApplies(f.preset) ? 'Scope to a shift window' : 'Shift filtering applies to Today / Yesterday'}
            >
              <option value="">All Shifts</option>
              {shifts.map((sh) => <option key={sh.name} value={sh.name}>{sh.name} · {sh.start}–{sh.end}</option>)}
            </select>

            <span className="ml-auto text-[11px] text-steel">
              {range ? `${fmtTime(range.from)} → ${fmtTime(range.to)}` : 'Pick a valid start & end to apply the range.'}
            </span>
          </div>

          {/* Date window — buttons, with the custom picker behind a popup */}
          <div className="flex items-center gap-1.5 flex-wrap">
            {DATE_PRESETS.map((p) => (
              <PresetButton key={p.value} active={f.preset === p.value} onClick={() => f.set({ preset: p.value })}>
                {p.label}
              </PresetButton>
            ))}
            <PresetButton active={f.preset === 'custom'} onClick={() => setPickRange(true)}>
              <CalendarRange size={13} /> {f.preset === 'custom' && range ? windowLabel : 'Custom…'}
            </PresetButton>
            {/* Always present, never a surprise: a control that appears only once
                you've changed something is a control nobody knows exists. */}
            <button
              onClick={() => { f.reset(); setResetTick((n) => n + 1); }}
              disabled={atDefaults}
              title={atDefaults ? 'Filters are already at their defaults' : 'Back to All Machines · All Shifts · Today, and clear every group’s own window'}
              className="inline-flex items-center gap-1.5 rounded-lg border border-line px-2.5 py-1.5 text-xs font-medium text-steel hover:text-accent hover:border-accent/40 transition-colors shrink-0 disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:text-steel disabled:hover:border-line"
            >
              <RotateCcw size={13} /> Reset
            </button>
          </div>
        </div>

        {/* ── By group ────────────────────────────────────────────────────── */}
        <SectionHead icon={Boxes} title={f.machineId ? scopeLabel : 'Machine groups'}
          sub={`${t.machines} machine${t.machines === 1 ? '' : 's'} · ${t.reported} reported data · ${windowLabel}${stale ? ' · updating…' : ''}`} />
        {/* Production vs Target — the teammate-built board on this app's
            assignment engine: group cards → machines → full operator board,
            with its own window filter (per hour / per shift / today…). */}
        <ProductionVsTarget rows={rows} windowMs={windowMs} windowLabel={windowLabel}
          from={fromISO} to={toISO} />

        <MachineGroups key={resetTick} rows={rows} windowMs={windowMs} windowLabel={windowLabel}
          from={fromISO} to={toISO} signals={signals} loading={actLoading} />

        {/* ── Fleet totals for the same window, under the groups they sum ── */}
        <div className="grid lg:grid-cols-2 gap-5">
          {/* Output & time split — production, runtime, idle, stopped, downtime */}
          <Panel title="Output & time split" subtitle={`how the fleet spent ${windowLabel}`} icon={Factory}>
            <div className="flex items-center gap-5 flex-wrap">
              <Donut segments={timeSeg} size={148} thickness={18} emptyColor={SLATE}>
                <span className="data text-2xl font-bold text-primary leading-none">{t.availabilityPct}%</span>
                <span className="label mt-1">availability</span>
              </Donut>
              <div className="flex-1 min-w-[210px] space-y-3">
                <div className="rounded-xl border border-line bg-base px-3.5 py-2.5 flex items-end justify-between gap-3">
                  <div className="min-w-0">
                    <div className="label">Production</div>
                    <div className="data text-2xl font-bold leading-none mt-0.5" style={{ color: t.production ? TEAL : STEEL }}>
                      {fmtNum(t.production)}<span className="text-sm font-medium text-steel"> pcs</span>
                    </div>
                  </div>
                  <div className="text-[10px] text-steel text-right shrink-0">
                    {t.reportedProduction} of {t.machines}<br />counters reporting
                  </div>
                </div>
                {observedMs === 0 ? (
                  <div className="text-sm text-steel py-2">No activity reconstructed for this window.</div>
                ) : (
                  <Legend rows={timeSeg} total={observedMs} format={(v) => fmtDuration(v)} scroll={false} />
                )}
                <div className="flex items-center justify-between text-xs pt-2 border-t border-line">
                  <span className="text-steel">Downtime <span className="text-steel/60">(idle + stopped)</span></span>
                  <span className="data font-bold" style={{ color: t.downtimeMs ? DEEP_RED : STEEL }}>{fmtDuration(t.downtimeMs)}</span>
                </div>
              </div>
            </div>
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
        {!f.machineId && rankings.length > 0 && (
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

      {pickRange && (
        <CustomRangeModal
          from={f.customFrom} to={f.customTo}
          subtitle="Every figure on the dashboard uses this window"
          onClose={() => setPickRange(false)}
          onApply={(customFrom, customTo) => { f.set({ preset: 'custom', customFrom, customTo }); setPickRange(false); }}
        />
      )}
      {drill && ov && <AnalyticsModal dimension={drill} ov={ov} onClose={() => setDrill(null)} />}
    </div>
  );
}

// ── building blocks ──────────────────────────────────────────────────────────
function PresetButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: ReactNode }): JSX.Element {
  return (
    <button onClick={onClick}
      className={`inline-flex items-center gap-1 rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors ${
        active ? 'border-accent bg-accent text-white' : 'border-line bg-base text-steel hover:text-accent hover:border-accent/40'
      }`}
    >
      {children}
    </button>
  );
}

function SectionHead({ icon: Icon, title, sub }: { icon: LucideIcon; title: string; sub?: string }): JSX.Element {
  return (
    <div className="flex items-center gap-2.5 pt-1">
      <span className="w-8 h-8 rounded-xl bg-accent/10 flex items-center justify-center shrink-0"><Icon size={16} className="text-accent" /></span>
      <div className="min-w-0">
        <h2 className="font-semibold text-primary text-[15px] leading-tight truncate">{title}</h2>
        {sub && <p className="text-[11px] text-steel truncate">{sub}</p>}
      </div>
    </div>
  );
}

interface RankRow { code: string; rank: number; availabilityPct: number; production: number | null; runningMs: number; downtimeMs: number }

// Performance ranking table — availability-based (the only officially derivable
// performance metric; OEE inputs don't exist and are never fabricated).
function RankPanel({ title, icon, color, rows, onPick, emptyNote }: { title: string; icon: LucideIcon; color: string; rows: RankRow[]; onPick: (code: string) => void; emptyNote?: string }): JSX.Element {
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
                  <td className="px-2 py-2 data text-xs text-right font-semibold" style={{ color: r.availabilityPct >= 75 ? TEAL : r.availabilityPct >= 50 ? AMBER : color }}>{r.availabilityPct}%</td>
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
