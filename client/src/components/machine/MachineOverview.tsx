// client/src/components/machine/MachineOverview.tsx
// Rich, image-style machine Overview dashboard. Every value is derived from the
// machine's REAL telemetry contract (GET /machines/:code + /stats + downtime) —
// nothing is fabricated and the database is never written to. The layout adapts to
// what the machine actually streams: machines with zone temperatures get the
// Temperature Overview; everything else gets a Primary Readings / Digital I/O panel.
import { useMemo, useState, type ReactNode } from 'react';
import { useQuery, keepPreviousData } from '@tanstack/react-query';
import type { LucideIcon } from 'lucide-react';
import {
  Cpu, Thermometer, Database,
  Search, BarChart3, ChevronRight, ChevronDown, LineChart, Calendar,
} from 'lucide-react';
import { machineApi, downtimeApi } from '../../api/endpoints';
import TargetPanel from './TargetPanel';
import { StatusPill } from '../ui';
import PressureRing from '../PressureRing';
import Sparkline from '../Sparkline';
import MetricTrendModal, { type DrillEntry } from './MetricTrendModal';
import { fmtNum, fmtMetric, fmtTime, fmtDate, fmtDuration, prettyKey, prettyType } from '../../lib/format';
import { borrowedFrom } from '../../lib/production';
import { namedMetrics, isNumeric, isFault, freshness, type NamedMetric } from '../../lib/metrics';
import { flattenParams } from '../../lib/params';
import { computeHeadline } from '../../lib/headline';
import { useMachineTelemetry } from '../../hooks/useLive';
import RangeFilter, { type RangeValue } from '../RangeFilter';
import { resolveRange, shiftApplies, presetLabel } from '../../store/filters';
import { shiftWindowOn } from '../../lib/settings';
import { useAppConfig } from '../../hooks/useAppConfig';
import { isFurnaceRef } from '../../lib/temperature';
import type { Machine, MachineIO, MachineRegister, MetricStat, DowntimeEvent, MachineActivityRow } from '../../types/api';
import { useMachineName, useMachineTitle } from '../../lib/machineName';

const isZoneTemp = (k: string) => /(^|_)t\d+$/i.test(k);
const isPressure = (k: string) => /press|(^|[_-])bar$/i.test(k);
const isCycle = (k: string) => /cycle/i.test(k);

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));
const fmtClock = (ts?: string | Date | null) => (ts ? new Date(ts).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '—');
const tempTone = (v: number) => (v >= 900 ? '#DC2626' : v >= 600 ? '#D97706' : '#0D9488');

interface Props {
  machine: Machine;
  status?: string;
  lastSeenAt?: string | Date | null;
  onTab?: (tab: string) => void;
}

export default function MachineOverview({ machine, status, lastSeenAt, onTab }: Props): JSX.Element {
  const mName = useMachineName();
  const mTitle = useMachineTitle();
  const id = machine.machineId || machine.id || machine._id;
  const liveTel = useMachineTelemetry(id);

  const { data: stats } = useQuery({
    queryKey: ['machine-stats', id],
    queryFn: () => machineApi.stats(id, { window: 200 }).then((r) => r.data),
    refetchInterval: 10000,
    enabled: !!id,
  });
  const statByKey = useMemo(() => Object.fromEntries((stats?.metrics || []).map((m) => [m.key, m])) as Record<string, MetricStat>, [stats]);

  const { data: downtime } = useQuery({
    queryKey: ['machine-downtime-sum', id],
    queryFn: () => downtimeApi.list({ machineId: id, limit: 100 }).then((r) => r.data),
    enabled: !!id,
  });

  // ── ONE window for the whole page ────────────────────────────────────────
  // This filter used to live inside a single card, so that card answered "what
  // did Shift A make last Tuesday" while every other figure on the page still
  // answered "today". Two different truths on one screen is how a shop floor
  // stops trusting a dashboard. The selection lives here now, and the target,
  // the hourly bars, the runtime split and the piece count all read it.
  const { shifts } = useAppConfig();
  const [range, setRange] = useState<RangeValue>({ preset: 'today', customFrom: '', customTo: '' });
  const [shiftName, setShiftName] = useState('');
  // A shift only narrows a SINGLE day: Today/Yesterday (as on the dashboard),
  // or a custom range covering one WHOLE day. A custom range carrying its own
  // times is already the window that was asked for — substituting the shift's
  // hours for it WIDENS what this control promises to narrow, and with a night
  // shift it walks off the chosen day altogether.
  const isCustom = range.preset === 'custom';
  const wholeDayCustom = range.customFrom.slice(11) === '00:00' && range.customTo.slice(11) === '23:59';
  const customDay = isCustom && wholeDayCustom && range.customFrom.slice(0, 10) && range.customFrom.slice(0, 10) === range.customTo.slice(0, 10)
    ? range.customFrom.slice(0, 10)
    : null;
  const shiftOk = shiftApplies(range.preset) || !!customDay;
  const shift = shiftOk ? shifts.find((s) => s.name === shiftName) || null : null;
  let win = resolveRange(
    { preset: range.preset, shiftName: shiftOk ? shiftName : '', customFrom: range.customFrom, customTo: range.customTo },
    shifts,
  );
  // resolveRange takes a custom range literally, so narrow it to the shift here.
  if (customDay && shift) win = shiftWindowOn(shift, new Date(`${customDay}T00:00:00`));
  // A shift window runs to the shift's SCHEDULED end, so mid-shift it reaches
  // into the future. Readings cannot, so the page would print a range it had no
  // data for and a reading count that covered only part of it. Rounded to the
  // minute: an unrounded now() would change the query key on every render and
  // refetch in a loop.
  if (win && win.to.getTime() > Date.now()) {
    const now = Math.max(Math.floor(Date.now() / 60_000) * 60_000, win.from.getTime() + 60_000);
    win = { from: win.from, to: new Date(now) };
  }
  const winFromISO = win?.from.toISOString();
  const winToISO = win?.to.toISOString();
  // What the window is CALLED. Every figure that has to name its window prints
  // THIS, so no card can invent its own wording and disagree with its neighbour.
  const winLabel = `${isCustom ? (customDay ? fmtDate(`${customDay}T00:00:00`) : 'Custom range') : presetLabel(range.preset)}${shift ? ` · ${shift.name}` : ''}`;

  // Activity for the selected window, from the SHARED engine. The RESOLVED
  // window is the cache key, never the preset: keying on "today" alone survived
  // midnight and then served yesterday's totals under today's label. The key
  // keeps its 'today' NAME because on the default preset it matches the machine
  // list's key, and react-query then serves this page from that warm fetch.
  const { data: dayAct, isFetching: actFetching } = useQuery({
    queryKey: ['machine-activity-today', winFromISO, winToISO],
    queryFn: () => machineApi.activity({ from: winFromISO as string, to: winToISO as string }),
    enabled: !!win,
    placeholderData: keepPreviousData,
    refetchInterval: 60000,
  });
  const codes = [machine.code, machine.machineId, machine.id, machine._id]
    .filter(Boolean).map((c) => String(c).toUpperCase());
  const actRow = (dayAct?.data || []).find((r) => codes.includes(String(r.code).toUpperCase()));

  // A furnace makes heat, not pieces; and a machine with no counter still
  // measures something (lib/headline decides WHICH signal). Both answers stand
  // where the piece count would otherwise go, over exactly this window.
  const furnace = codes.some((c) => isFurnaceRef(c));
  const liveParams = flattenParams(
    Object.keys(machine.currentParameters || {}).length ? machine.currentParameters as Record<string, unknown> : (machine.latestData || {}),
  );
  const headline = !furnace && actRow && actRow.productionKey == null ? computeHeadline(liveParams) : null;
  const avgKey = headline?.key;
  // The stored code VERBATIM, not the upper-cased comparison form: /machines/:code
  // resolves by EXACT match (controllers/machine.controller#findMachine), so an
  // upper-cased ref 404s for any machine whose code is not already upper-case.
  const rawCode = String(machine.code || machine.machineId || machine.id || machine._id || '');
  const { data: avgData } = useQuery({
    queryKey: ['machine-metric-avg', rawCode, winFromISO, winToISO, avgKey],
    queryFn: () => machineApi.metricAverage(rawCode, { from: winFromISO as string, to: winToISO as string, key: avgKey as string }),
    enabled: !!win && !!avgKey && !!rawCode,
    placeholderData: keepPreviousData,
    refetchInterval: 60000,
  });
  const avg = avgKey ? avgData?.data : undefined;

  // Live-merge: a fresh socket reading wins over the polled snapshot's metrics.
  const metrics = useMemo<NamedMetric[]>(
    () => (liveTel?.data ? namedMetrics(liveTel.data) : (machine.metrics || [])),
    [liveTel, machine.metrics],
  );

  const m = useMemo(() => buildModel(machine, metrics, status, lastSeenAt, downtime, actRow), [machine, metrics, status, lastSeenAt, downtime, actRow]);

  // Average-temperature trend (mean of every zone's spark, index by index).
  const tempSpark = useMemo(() => {
    const sparks = m.zones.map((z) => statByKey[z.key]?.spark).filter((s): s is number[] => Array.isArray(s) && s.length > 1);
    if (!sparks.length) return [];
    const len = Math.min(...sparks.map((s) => s.length));
    const out: number[] = [];
    for (let i = 0; i < len; i++) {
      let sum = 0, c = 0;
      sparks.forEach((s) => { const v = Number(s[i]); if (Number.isFinite(v)) { sum += v; c += 1; } });
      if (c) out.push(sum / c);
    }
    return out;
  }, [m.zones, statByKey]);

  // Click a metric tile → open its evaluated trend (real /stats data, key-consistent).
  const [drill, setDrill] = useState<{ title: string; unit?: string; entries: DrillEntry[] } | null>(null);
  const openMetric = (entries: DrillEntry[], title: string, unit?: string) => setDrill({ entries, title, unit });
  const zoneEntries = (): DrillEntry[] => m.zones.map((z, i) => ({ key: z.key, label: `Zone ${i + 1} · ${prettyKey(z.key)}`, stat: statByKey[z.key] }));

  return (
    <div className="max-w-6xl space-y-4">
      {/* Hero header — identity, and the at-a-glance numbers. */}
      <div className="rounded-card bg-slate-900 text-white px-5 py-4 flex flex-wrap items-center justify-between gap-4 shadow-panel">
        <div className="flex items-center gap-3 min-w-0">
          <span className="w-11 h-11 rounded-lg bg-white/10 flex items-center justify-center shrink-0">
            {m.hasTemp ? <Thermometer size={22} /> : <Cpu size={22} />}
          </span>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h2 className="text-lg font-bold truncate" title={mTitle(String(id))}>{mName(String(id))}</h2>
              <StatusPill status={status} />
            </div>
            <div className="text-xs text-white/55 truncate">{String(id).toLowerCase()} · {machine.subtitle || prettyType(machine.type) || 'Machine'}</div>
          </div>
        </div>
        {/* Alarms sat in a Machine Status card that read as empty because every
            other row on it was already elsewhere: the pill and last-seen are in
            this header, its Uptime is the number the Production card calls
            Efficiency, and View Details went where the Specs tab goes. */}
        <div className="flex items-center gap-4 flex-wrap">
          <div className="text-right">
            <div className="text-[10px] uppercase tracking-wider text-white/45">Last Seen</div>
            <div className="text-sm font-medium">{fmtClock(lastSeenAt)}</div>
          </div>
          <div className="text-right">
            <div className="text-[10px] uppercase tracking-wider text-white/45">Alarms</div>
            <div className={`data text-sm font-bold ${m.faultCount ? 'text-red-400' : 'text-white/90'}`}>{fmtNum(m.faultCount)}</div>
          </div>
          <div className="flex items-center gap-2 bg-white/10 rounded-lg px-3 py-2">
            <div className="text-right">
              <div className="text-[10px] uppercase tracking-wider text-white/45">Health</div>
              <div className="text-sm font-bold">{m.health}%</div>
            </div>
            <PressureRing value={m.health} status={m.healthStatus} size={40} stroke={5} />
          </div>
        </div>
      </div>

      {/* The page's ONE window control. It sits above every figure it governs,
          because a filter below its own results reads as a footnote. */}
      <div className="panel px-4 py-3 flex items-center gap-2 flex-wrap">
        <Calendar size={15} className="text-accent shrink-0" />
        <span className="text-[11px] uppercase tracking-wide text-steel">Window</span>
        <select value={shiftOk ? shiftName : ''} onChange={(e) => setShiftName(e.target.value)}
          disabled={!shiftOk}
          title={shiftOk ? 'Narrow the day to one shift' : 'Shifts apply to a single day — Today, Yesterday, or a custom range within one day'}
          className="bg-base border border-line rounded-lg px-2.5 py-1.5 text-sm text-primary outline-none cursor-pointer focus:border-accent disabled:opacity-45 disabled:cursor-not-allowed">
          <option value="">Full day</option>
          {shifts.map((sh) => <option key={sh.name} value={sh.name}>{sh.name} · {sh.start}–{sh.end}</option>)}
        </select>
        <RangeFilter value={range} onChange={setRange} range={win} title="Pick the window for this machine" />
        <span className="ml-auto text-[11px] text-steel/70 truncate">
          {win ? `${fmtTime(win.from)} → ${fmtTime(win.to)}` : 'Pick a start date and an end date'}
          {actFetching && <span className="text-accent"> · updating…</span>}
        </span>
      </div>

      {/* Operator target — what am I making, what's the target, how far am I */}
      {win && <TargetPanel code={String(id)} actRow={actRow} dayFrom={winFromISO as string} dayTo={winToISO as string} label={winLabel} />}

      {/* Equal-height cards (the grid stretches each card in a row to match). */}
      <div className="grid lg:grid-cols-2 gap-4">
        {m.hasTemp && (
          <Panel icon={Thermometer} title="Temperature Overview" right={<span className="text-xs text-steel">°C</span>}>
            <div className="grid grid-cols-2 gap-2">
              {m.zones.slice(0, 8).map((z, i) => (
                <button key={z.key} type="button" title="Click to view trend"
                  onClick={() => openMetric([{ key: z.key, label: `Zone ${i + 1} · ${prettyKey(z.key)}`, stat: statByKey[z.key] }], `Zone ${i + 1} (${prettyKey(z.key)})`, '°C')}
                  className="group relative text-left rounded-lg border border-line bg-base px-3 py-2 hover:border-accent/50 hover:bg-accent/5 transition-colors">
                  <LineChart size={12} className="absolute top-2 right-2 text-accent opacity-0 group-hover:opacity-100 transition-opacity" />
                  <div className="text-[10px] text-steel uppercase tracking-wide truncate">Zone {i + 1} <span className="text-steel/60">({prettyKey(z.key)})</span></div>
                  <div className="data text-lg font-bold" style={{ color: tempTone(z.value) }}>{fmtMetric(z.value)}°C</div>
                </button>
              ))}
            </div>
            {tempSpark.length > 1 && (
              <button type="button" onClick={() => openMetric(zoneEntries(), 'Temperature — All Zones', '°C')}
                className="group mt-3 block w-full text-left rounded-lg hover:bg-accent/5 transition-colors p-1 -m-1">
                <Sparkline data={tempSpark} width={320} height={56} />
                <span className="flex items-center gap-1 text-[10px] text-steel/70 group-hover:text-accent mt-0.5"><LineChart size={11} /> Compare all zones</span>
              </button>
            )}
            {m.temp && (
              <div className="grid grid-cols-3 gap-2 mt-3">
                <MiniStat label="Average Temp" value={`${m.temp.avg}°C`} color="#2563EB" />
                <MiniStat label="Max Temp" value={`${m.temp.max}°C`} color="#DC2626" />
                <MiniStat label="Min Temp" value={`${m.temp.min}°C`} color="#0D9488" />
              </div>
            )}
          </Panel>
        )}

        <Panel icon={BarChart3} title={furnace ? 'Temperature & Runtime' : 'Production & Runtime'}
          className={`${m.hasTemp ? '' : 'lg:col-span-2'} ${actFetching ? 'opacity-60 transition-opacity' : 'transition-opacity'}`}>
          {/* What the window produced — or, for a machine that counts nothing,
              what it measured instead. */}
          <div className="rounded-lg border border-line bg-base px-4 py-3 mb-4">
            <div className="text-[10px] uppercase tracking-wide text-steel">
              {furnace ? 'Avg temperature' : avgKey ? prettyKey(avgKey) : 'Production'} · {winLabel}
            </div>
            {furnace ? (
              <>
                <div className="data text-3xl font-bold text-primary leading-tight">
                  {actRow?.avgTemp != null ? fmtNum(actRow.avgTemp) : '—'} <span className="text-sm font-medium text-steel">°C</span>
                </div>
                <div className="text-[10px] text-steel mt-0.5">
                  {actRow?.avgTemp != null
                    ? `mean of ${actRow.tempZones} work zone${actRow.tempZones === 1 ? '' : 's'} over this window`
                    : 'no temperature signal — the furnace reports no measured zone value'}
                </div>
              </>
            ) : avgKey ? (
              <>
                <div className="data text-3xl font-bold text-primary leading-tight">
                  {avg?.avg != null ? fmtNum(avg.avg) : '—'}
                  {headline?.unit && avg?.avg != null && <span className="text-sm font-medium text-steel"> {headline.unit}</span>}
                </div>
                <div className="text-[10px] text-steel mt-0.5">
                  {avg?.avg != null
                    ? `${prettyKey(avgKey)} · mean of ${fmtNum(avg.samples)} readings${avg.min != null && avg.max != null ? ` · ${fmtNum(avg.min)}–${fmtNum(avg.max)}` : ''}`
                    : `${prettyKey(avgKey)} — nothing reported in this window`}
                </div>
              </>
            ) : (
              <>
                <div className="data text-3xl font-bold text-primary leading-tight">
                  {actRow ? fmtNum(Math.max(actRow.production ?? 0, 0)) : '—'} <span className="text-sm font-medium text-steel">pcs</span>
                </div>
                {(borrowedFrom(actRow) || actRow?.productionKey) && (
                  <div className="text-[10px] text-steel mt-0.5">
                    {borrowedFrom(actRow) ?? prettyKey(actRow?.productionKey as string)}
                  </div>
                )}
              </>
            )}
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 mb-4">
            <MiniStat label="Runtime" value={fmtDuration(m.runtimeMs)} color="#059669" />
            <MiniStat label="Idle" value={fmtDuration(m.idleMs)} color="#D97706" />
            <MiniStat label="Stopped" value={fmtDuration(m.stoppedMs)} color="#DC2626" />
            <MiniStat label="Downtime" value={fmtDuration(m.downMs)} color="#991B1B" />
            <MiniStat label="Efficiency" value={`${m.efficiency}%`} color="#7C3AED" />
          </div>
          <div className="flex items-center gap-5 rounded-lg border border-line bg-base p-4">
            <PressureRing value={m.efficiency} status={m.efficiency >= 80 ? 'running' : m.efficiency >= 50 ? 'idle' : 'stopped'} size={92} stroke={9} label="Efficiency" />
            <div className="flex-1 space-y-2.5">
              <Bar label="Runtime"  value={m.runtimeMs} total={m.runtimeMs + m.downMs} color="#059669" text={fmtDuration(m.runtimeMs)} />
              <Bar label="Downtime" value={m.downMs}    total={m.runtimeMs + m.downMs} color="#DC2626" text={fmtDuration(m.downMs)} />
            </div>
          </div>
          <div className="text-[10px] text-steel/60 mt-3">
            {fmtNum(actRow?.readings || 0)} readings{win ? ` · ${fmtTime(win.from)} → ${fmtTime(win.to)}` : ''}
          </div>
        </Panel>
      </div>

      <AllSignalsPanel
        named={metrics}
        inputs={machine.inputs || []}
        outputs={machine.outputs || []}
        registers={machine.registers || []}
        registerTotal={machine.registerCount || 0}
      />

      {drill && (
        <MetricTrendModal
          machineId={String(id)}
          machineTitle={mName(String(id))}
          title={drill.title}
          unit={drill.unit}
          entries={drill.entries}
          onClose={() => setDrill(null)}
          onOpenHistory={onTab ? () => { setDrill(null); onTab('history'); } : undefined}
        />
      )}
    </div>
  );
}

// ── derive every dashboard value from the real machine contract ────────────────
function buildModel(machine: Machine, metrics: NamedMetric[], status: string | undefined, lastSeenAt: string | Date | null | undefined, downtime: DowntimeEvent[] | undefined, actRow?: MachineActivityRow) {
  // Zero readings are noise (dead sensor / unused register) — hide them everywhere,
  // but never hide a fault: that's information, not noise.
  const numericLive = metrics.filter((x) => x.numeric && (x.fault || Number(x.value) !== 0));
  const namedCount = machine.latest?.namedCount ?? metrics.length;
  const faultCount = machine.latest?.faultCount ?? metrics.filter((x) => x.fault).length;

  const zones = numericLive.filter((x) => !x.fault && isZoneTemp(x.key)).map((x) => ({ key: x.key, value: Number(x.value) }));
  const hasTemp = zones.length > 0;
  const tVals = zones.map((z) => z.value);
  const temp = tVals.length
    ? { avg: Math.round(tVals.reduce((a, b) => a + b, 0) / tVals.length), max: Math.max(...tVals), min: Math.min(...tVals) }
    : null;

  const primary = numericLive.filter((x) => !isZoneTemp(x.key)).slice(0, 6).map((x) => ({ key: x.key, value: x.value, fault: x.fault }));

  const inputs: MachineIO[] = machine.inputs || [];
  const outputs: MachineIO[] = machine.outputs || [];
  const io = { inputs, outputs, activeIn: inputs.filter((i) => i.on).length, activeOut: outputs.filter((o) => o.on).length };
  const hasIO = inputs.length + outputs.length > 0;
  const registers: MachineRegister[] = (machine.registers || []).filter((r) => !(isNumeric(r.value) && Number(r.value) === 0));

  const findVal = (test: (k: string) => boolean): { key: string; value: number } | null => {
    const mm = numericLive.find((x) => !x.fault && test(x.key));
    if (mm) return { key: mm.key, value: Number(mm.value) };
    const rg = registers.find((r) => test(r.key) && isNumeric(r.value));
    return rg ? { key: rg.key, value: Number(rg.value) } : null;
  };
  const pressure = findVal(isPressure);
  const cycles = findVal(isCycle);

  const fr = freshness(lastSeenAt);
  const dataFlowing = fr.state === 'live';
  const dataQuality = namedCount > 0 ? Math.round(((namedCount - faultCount) / namedCount) * 100) : 100;

  // Runtime / downtime / efficiency come from the SHARED activity engine
  // (rolling 24h): runtime = time the machine actually reported minus recorded
  // downtime — never window-minus-spans, which credited silent hours as runtime.
  const openDowntime = (downtime || []).filter((e) => !e.endedAt).length;
  const runtimeMs = actRow?.runningMs ?? 0;
  const idleMs = actRow?.idleMs ?? 0;
  const stoppedMs = actRow?.stoppedMs ?? 0;
  const downMs = actRow ? actRow.idleMs + actRow.stoppedMs : 0;
  const accounted = runtimeMs + downMs;
  const uptimePct = accounted > 0 ? Math.round((runtimeMs / accounted) * 100) : 0;
  const efficiency = machine.oee != null ? Math.round(machine.oee) : uptimePct;

  let health = 100;
  if (!dataFlowing) health -= 30; else if (fr.state !== 'live') health -= 8;
  if (status === 'stopped') health -= 20; else if (status === 'offline') health -= 15; else if (status === 'idle') health -= 8;
  if (namedCount) health -= Math.round((faultCount / namedCount) * 30);
  if (hasTemp && temp && temp.max >= 900) health -= 15;
  health = clamp(health, 0, 100);
  const healthStatus = health >= 80 ? 'running' : health >= 50 ? 'idle' : 'stopped';

  return {
    hasTemp, zones, temp, primary, pressure, cycles,
    io, hasIO, registers,
    namedCount, faultCount, dataQuality,
    health, healthStatus,
    runtimeMs, idleMs, stoppedMs, downMs, uptimePct, efficiency, openDowntime,
  };
}


// ── presentational building blocks ─────────────────────────────────────────────
function Panel({ icon: Icon, title, right, className = '', children }: { icon?: LucideIcon; title: string; right?: ReactNode; className?: string; children: ReactNode }): JSX.Element {
  return (
    <div className={`panel p-5 flex flex-col h-full ${className}`}>
      <div className="flex items-center gap-2 mb-4">
        {Icon && <Icon size={16} className="text-accent" />}
        <h3 className="font-semibold text-sm text-primary flex-1">{title}</h3>
        {right}
      </div>
      {children}
    </div>
  );
}

function MiniStat({ label, value, color }: { label: string; value: ReactNode; color: string }): JSX.Element {
  return (
    <div className="rounded-lg border border-line bg-base px-3 py-2 text-center">
      <div className="text-[10px] text-steel uppercase tracking-wide truncate">{label}</div>
      <div className="data text-base font-bold mt-0.5 truncate" style={{ color }}>{value}</div>
    </div>
  );
}

function Bar({ label, value, total, color, text }: { label: string; value: number; total: number; color: string; text: ReactNode }): JSX.Element {
  const pct = total > 0 ? Math.round((value / total) * 100) : 0;
  return (
    <div>
      <div className="flex items-center justify-between text-[11px] mb-1">
        <span className="text-steel">{label}</span>
        <span className="data font-medium text-primary">{text}</span>
      </div>
      <div className="h-2 rounded-full bg-line overflow-hidden">
        <div className="h-full rounded-full" style={{ width: `${pct}%`, background: color }} />
      </div>
    </div>
  );
}

// Progressive disclosure: collapsed by default, searchable, render-capped.
function AllSignalsPanel({ named, inputs, outputs, registers, registerTotal }: { named: NamedMetric[]; inputs: MachineIO[]; outputs: MachineIO[]; registers: MachineRegister[]; registerTotal: number }): JSX.Element | null {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const RENDER_CAP = 600;

  const all = useMemo(() => [
    ...(named || []).map((x) => ({ key: x.key, value: x.value, kind: 'metric' })),
    ...(inputs || []).map((i) => ({ key: i.key, value: i.on ? 'ON' : 'OFF', kind: 'input' })),
    ...(outputs || []).map((o) => ({ key: o.key, value: o.on ? 'ON' : 'OFF', kind: 'output' })),
    ...(registers || []).map((r) => ({ key: r.key, value: r.value, kind: 'register' })),
  ], [named, inputs, outputs, registers]);

  const filtered = useMemo(() => {
    const base = q ? all.filter((s) => String(s.key).toLowerCase().includes(q.toLowerCase())) : all;
    return base.slice(0, RENDER_CAP);
  }, [all, q]);

  const total = (named?.length || 0) + (inputs?.length || 0) + (outputs?.length || 0) + Math.max(registers?.length || 0, registerTotal || 0);
  if (total === 0) return null;

  return (
    <div className="panel">
      <button onClick={() => setOpen((o) => !o)} className="w-full flex items-center justify-between px-5 py-3.5 text-left">
        <span className="flex items-center gap-2 text-sm font-medium text-primary">
          <Database size={15} className="text-steel" /> All Signals
          <span className="pill bg-line text-steel">{fmtNum(total)}</span>
        </span>
        <span className="flex items-center gap-1.5 text-xs text-steel">
          {open ? 'Hide' : 'View all signals'}{open ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
        </span>
      </button>
      {open && (
        <div className="px-5 pb-5 border-t border-line pt-4">
          <div className="flex items-center gap-2 bg-base border border-line rounded-lg px-3 py-2 mb-3 max-w-xs">
            <Search size={14} className="text-steel" />
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter signals…"
              className="bg-transparent outline-none text-sm flex-1 text-primary placeholder:text-steel/60" />
          </div>
          {all.length > filtered.length && (
            <div className="text-[11px] text-steel/70 mb-2">Showing {fmtNum(filtered.length)} of {fmtNum(all.length)} — type to filter.</div>
          )}
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-1.5 max-h-96 overflow-y-auto">
            {filtered.map((s) => (
              <div key={`${s.kind}:${s.key}`} className="rounded-md bg-base border border-line px-2 py-1.5">
                <div className="data text-[10px] text-steel truncate" title={s.key}>{s.key}</div>
                <div className={`data text-xs font-semibold truncate ${isFault(s.value) ? 'text-stopped' : 'text-primary'}`}>{isFault(s.value) ? 'FAULT' : fmtMetric(s.value)}</div>
              </div>
            ))}
            {filtered.length === 0 && <div className="col-span-full text-center text-steel text-xs py-4">No signals match "{q}"</div>}
          </div>
        </div>
      )}
    </div>
  );
}
