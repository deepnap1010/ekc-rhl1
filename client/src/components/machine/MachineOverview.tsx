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
  Cpu, Thermometer, Activity, Gauge, Database, Clock, Power,
  ArrowRight, Search, BarChart3, Bell, ChevronRight, ChevronDown, LineChart, Calendar,
} from 'lucide-react';
import { machineApi, downtimeApi } from '../../api/endpoints';
import { StatusPill } from '../ui';
import PressureRing from '../PressureRing';
import Sparkline from '../Sparkline';
import MetricTrendModal, { type DrillEntry } from './MetricTrendModal';
import { fmtNum, fmtMetric, fmtTime, fmtDuration, prettyKey, prettyType } from '../../lib/format';
import { namedMetrics, isNumeric, isFault, freshness, type NamedMetric } from '../../lib/metrics';
import { useMachineTelemetry } from '../../hooks/useLive';
import { shiftWindowOn } from '../../lib/settings';
import { useAppConfig } from '../../hooks/useAppConfig';
import { LINKS } from '../../lib/linkedMetrics';
import type { Machine, MachineIO, MachineRegister, MetricStat, DowntimeEvent, MachineActivityRow } from '../../types/api';

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

  // Rolling-24h activity from the SHARED engine — the same source (and the same
  // query key, so react-query shares the fetch) as the machine cards. Runtime is
  // credited only for time the machine actually reported; a silent night with a
  // stale "running" status is no longer 23h of fake runtime / 99% efficiency.
  const dayTo = Math.floor(Date.now() / 60_000) * 60_000;
  const { data: dayAct } = useQuery({
    queryKey: ['machine-activity-24h', dayTo],
    queryFn: () => machineApi.activity({ from: new Date(dayTo - 24 * 3600 * 1000).toISOString(), to: new Date(dayTo).toISOString() }),
    placeholderData: keepPreviousData,
    refetchInterval: 60000,
  });
  const codes = [machine.code, machine.machineId, machine.id, machine._id]
    .filter(Boolean).map((c) => String(c).toUpperCase());
  const actRow = (dayAct?.data || []).find((r) => codes.includes(String(r.code).toUpperCase()));

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
      {/* Hero header — identity + last seen + health score */}
      <div className="rounded-card bg-slate-900 text-white px-5 py-4 flex flex-wrap items-center justify-between gap-4 shadow-panel">
        <div className="flex items-center gap-3 min-w-0">
          <span className="w-11 h-11 rounded-lg bg-white/10 flex items-center justify-center shrink-0">
            {m.hasTemp ? <Thermometer size={22} /> : <Cpu size={22} />}
          </span>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h2 className="text-lg font-bold truncate">{machine.name || id}</h2>
              <StatusPill status={status} />
            </div>
            <div className="text-xs text-white/55 truncate">{String(id).toLowerCase()} · {machine.subtitle || prettyType(machine.type) || 'Machine'}</div>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <div className="text-right">
            <div className="text-[10px] uppercase tracking-wider text-white/45">Last Seen</div>
            <div className="text-sm font-medium">{fmtTime(lastSeenAt)}</div>
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

      {/* Row 1 — equal-height cards (grid stretches each card in the row to match) */}
      <div className="grid lg:grid-cols-3 gap-4">
        <Panel icon={Activity} title="Machine Status">
          <div className="divide-y divide-line">
            <Row label="Status"><StatusPill status={status} /></Row>
            <Row label="Last Seen"><span className="data text-primary">{fmtClock(lastSeenAt)}</span></Row>
            <Row label="Payload Count"><span className="data font-semibold text-primary">{fmtNum(machine.telemetryCount || 0)}</span></Row>
            <Row label="Uptime"><span className="data font-semibold text-running">{m.uptimePct}%</span></Row>
            <Row label="Active Alarms"><span className={`data font-semibold ${m.faultCount ? 'text-stopped' : 'text-running'}`}>{m.faultCount}</span></Row>
            <Row label="Machine Type"><span className="text-primary">{machine.subtitle || prettyType(machine.type) || '—'}</span></Row>
            <Row label="PLC Type"><span className="data text-primary">{m.plcType}</span></Row>
          </div>
          <button onClick={() => onTab?.('specs')} className="mt-auto pt-3 w-full flex items-center justify-center gap-1.5 text-sm text-accent border border-accent/20 bg-accent/5 hover:bg-accent/10 rounded-lg py-2 font-medium transition-colors">
            View Details <ArrowRight size={14} />
          </button>
        </Panel>

        {m.hasTemp ? (
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
        ) : (
          <Panel icon={m.hasIO && !m.primary.length ? Power : Gauge} title={m.primary.length ? 'Primary Readings' : m.hasIO ? 'Digital I/O' : 'Primary Readings'}>
            {m.primary.length ? (
              <div className="grid grid-cols-2 gap-2">
                {m.primary.map((p) => {
                  const st = statByKey[p.key];
                  return (
                    <button key={p.key} type="button" title="Click to view trend"
                      onClick={() => openMetric([{ key: p.key, label: prettyKey(p.key), stat: st }], prettyKey(p.key))}
                      className="group relative min-w-0 overflow-hidden text-left rounded-lg border border-line bg-base px-3 py-2 hover:border-accent/50 hover:bg-accent/5 transition-colors">
                      <LineChart size={12} className="absolute top-2 right-2 text-accent opacity-0 group-hover:opacity-100 transition-opacity" />
                      <div className="text-[10px] text-steel uppercase tracking-wide truncate" title={prettyKey(p.key)}>{prettyKey(p.key)}</div>
                      {/* long values (bit arrays etc.) must clip inside the tile — full value on hover */}
                      <div className={`data text-lg font-bold truncate ${p.fault ? 'text-stopped' : 'text-primary'}`} title={p.fault ? 'FAULT' : String(fmtMetric(p.value))}>{p.fault ? 'FAULT' : fmtMetric(p.value)}</div>
                      {(st?.spark?.length ?? 0) > 1 && !p.fault && <div className="mt-1 -mx-0.5"><Sparkline data={st.spark} width={160} height={24} /></div>}
                    </button>
                  );
                })}
              </div>
            ) : m.hasIO ? (
              <>
                <div className="grid grid-cols-2 gap-2 mb-2">
                  <MiniStat label="Inputs Active" value={`${m.io.activeIn}/${m.io.inputs.length}`} color="#2563EB" />
                  <MiniStat label="Outputs Active" value={`${m.io.activeOut}/${m.io.outputs.length}`} color="#7C3AED" />
                </div>
                <div className="grid grid-cols-2 gap-2">
                  {[...m.io.inputs, ...m.io.outputs].slice(0, 8).map((s) => (
                    <div key={s.key} className="rounded-lg border border-line bg-base px-3 py-2 flex items-center justify-between gap-2">
                      <span className="text-[10px] text-steel uppercase tracking-wide truncate" title={prettyKey(s.key)}>{prettyKey(s.key)}</span>
                      <span className={`data text-xs font-bold shrink-0 ${s.on ? 'text-running' : 'text-steel/70'}`}>{s.on ? 'ON' : 'OFF'}</span>
                    </div>
                  ))}
                </div>
              </>
            ) : m.registers.length ? (
              <div className="grid grid-cols-2 gap-2">
                {m.registers.slice(0, 8).map((r) => (
                  <div key={r.key} className="rounded-lg border border-line bg-base px-3 py-2">
                    <div className="data text-[10px] text-steel uppercase tracking-wide truncate" title={r.key}>{r.key}</div>
                    <div className="data text-lg font-bold text-primary truncate">{fmtMetric(r.value)}</div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="text-sm text-steel py-6 text-center">No parameters in the latest reading.</div>
            )}
          </Panel>
        )}

        <Panel icon={Activity} title="Process Health">
          <div className="flex items-center gap-4">
            <div className="flex-1 space-y-2.5">
              {m.checks.map((c) => (
                <div key={c.label} className="flex items-center justify-between text-sm">
                  <span className="text-steel">{c.label}</span>
                  <span className="flex items-center gap-1.5 font-medium" style={{ color: c.color }}>
                    {c.text} <span className="w-2 h-2 rounded-full" style={{ background: c.color }} />
                  </span>
                </div>
              ))}
            </div>
            <PressureRing value={m.health} status={m.healthStatus} size={92} stroke={8} label="Health" />
          </div>
          <div className="grid grid-cols-2 gap-2 mt-auto pt-4">
            <MiniTile icon={Bell} accent={m.faultCount ? '#DC2626' : '#64748B'} label="Active Alarms" value={fmtNum(m.faultCount)} />
            <MiniTile icon={Clock} accent="#2563EB" label="Last Seen" value={fmtClock(lastSeenAt)} />
          </div>
        </Panel>
      </div>

      {/* Row 2 — equal-height pair */}
      <div className="grid lg:grid-cols-2 gap-4">
        <Panel icon={BarChart3} title="Production & Runtime">
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
            <MiniStat label="Runtime" value={fmtDuration(m.runtimeMs)} color="#059669" />
            <MiniStat label="Downtime" value={fmtDuration(m.downMs)} color="#DC2626" />
            <MiniStat label="Payloads" value={fmtNum(machine.telemetryCount || 0)} color="#2563EB" />
            <MiniStat label="Efficiency" value={`${m.efficiency}%`} color="#7C3AED" />
          </div>
          <div className="flex items-center gap-5 rounded-lg border border-line bg-base p-4">
            <PressureRing value={m.efficiency} status={m.efficiency >= 80 ? 'running' : m.efficiency >= 50 ? 'idle' : 'stopped'} size={92} stroke={9} label="Efficiency" />
            <div className="flex-1 space-y-2.5">
              <Bar label="Runtime"  value={m.runtimeMs} total={m.runtimeMs + m.downMs} color="#059669" text={fmtDuration(m.runtimeMs)} />
              <Bar label="Downtime" value={m.downMs}    total={m.runtimeMs + m.downMs} color="#DC2626" text={fmtDuration(m.downMs)} />
            </div>
          </div>
        </Panel>

        <ShiftProductionPanel machine={machine} />
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
          machineTitle={machine.name || String(id)}
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

// ── shift/date production filter — replaces the old static Key Parameters ──────
// Pick any date + shift (or the full day) and see what THIS machine produced in
// that window, plus its runtime split. Data comes from /machines/activity
// (read-only reconstruction from telemetry + downtime). A machine without its own
// production counter borrows the linked machine's (same pairing as the cards).
function ShiftProductionPanel({ machine }: { machine: Machine }): JSX.Element {
  const { shifts } = useAppConfig();   // shared server-side shift config
  const localDay = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const [day, setDay] = useState(() => localDay(new Date()));
  const [shiftName, setShiftName] = useState('');
  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo] = useState('');
  const isCustom = shiftName === '__custom__';
  const shift = shifts.find((s) => s.name === shiftName) || null;

  // Window is either a custom [from,to] (datetime pickers) or a day ± shift.
  let win: { from: Date; to: Date } | null = null;
  if (isCustom) {
    const f = new Date(customFrom), t = new Date(customTo);
    if (customFrom && customTo && !Number.isNaN(f.getTime()) && !Number.isNaN(t.getTime()) && f < t) win = { from: f, to: t };
  } else {
    const base = new Date(`${day}T00:00:00`);
    if (day && !Number.isNaN(base.getTime())) {
      win = shift ? shiftWindowOn(shift, base) : { from: base, to: new Date(base.getTime() + 24 * 3600 * 1000) };
    }
  }

  const { data, isLoading } = useQuery({
    queryKey: ['machine-shift-prod', day, shiftName, customFrom, customTo],
    queryFn: () => machineApi.activity({ from: win!.from.toISOString(), to: win!.to.toISOString() }),
    enabled: !!win,
    placeholderData: keepPreviousData,
    refetchInterval: 60000,
  });

  const rows = data?.data || [];
  const codes = [machine.code, machine.machineId, machine.id, machine._id].filter(Boolean).map(String);
  const row = rows.find((r) => codes.includes(r.code));
  let production = row?.production ?? null;
  let borrowedFrom: string | null = null;
  if (production == null || production <= 0) {
    const link = LINKS.find((l) => codes.some((c) => c.toUpperCase() === l.target));
    const srcRow = link ? rows.find((r) => String(r.code).toUpperCase() === link.source) : null;
    if (srcRow?.production != null && srcRow.production > 0) { production = srcRow.production; borrowedFrom = srcRow.code; }
  }

  return (
    <Panel icon={Calendar} title="Production by Shift">
      <div className="flex items-center gap-2 flex-wrap mb-4">
        <select value={shiftName} onChange={(e) => setShiftName(e.target.value)}
          className="bg-base border border-line rounded-lg px-2.5 py-1.5 text-sm text-primary outline-none cursor-pointer focus:border-accent">
          <option value="">Full day</option>
          {shifts.map((sh) => <option key={sh.name} value={sh.name}>{sh.name} · {sh.start}–{sh.end}</option>)}
          <option value="__custom__">Custom range…</option>
        </select>
        {isCustom ? (
          <>
            <input type="datetime-local" value={customFrom} onChange={(e) => setCustomFrom(e.target.value)}
              className="bg-base border border-line rounded-lg px-2.5 py-1.5 text-sm text-primary outline-none focus:border-accent" />
            <span className="text-steel text-xs">→</span>
            <input type="datetime-local" value={customTo} onChange={(e) => setCustomTo(e.target.value)}
              className="bg-base border border-line rounded-lg px-2.5 py-1.5 text-sm text-primary outline-none focus:border-accent" />
          </>
        ) : (
          <input type="date" value={day} onChange={(e) => setDay(e.target.value)}
            className="bg-base border border-line rounded-lg px-2.5 py-1.5 text-sm text-primary outline-none focus:border-accent" />
        )}
      </div>
      {!win ? (
        <div className="text-sm text-steel py-6 text-center">{isCustom ? 'Pick a start and end time.' : 'Pick a date to see production.'}</div>
      ) : isLoading && !row ? (
        <div className="text-sm text-steel py-6 text-center">Loading…</div>
      ) : (
        <>
          <div className="rounded-lg border border-line bg-base px-4 py-3 mb-3">
            <div className="text-[10px] uppercase tracking-wide text-steel">Production{isCustom ? ' · Custom' : shift ? ` · ${shift.name}` : ' · Full day'}</div>
            <div className="data text-3xl font-bold text-primary leading-tight">
              {production != null ? fmtNum(Math.max(production, 0)) : '0'} <span className="text-sm font-medium text-steel">pcs</span>
            </div>
            {borrowedFrom
              ? <div className="text-[10px] text-steel mt-0.5">via linked machine {borrowedFrom}</div>
              : row?.productionKey && <div className="text-[10px] text-steel mt-0.5">{prettyKey(row.productionKey)}</div>}
          </div>
          <div className="grid grid-cols-3 gap-2">
            <MiniStat label="Runtime" value={fmtDuration(row?.runningMs || 0)} color="#059669" />
            <MiniStat label="Downtime" value={fmtDuration((row?.stoppedMs || 0) + (row?.offlineMs || 0))} color="#DC2626" />
            <MiniStat label="Idle" value={fmtDuration(row?.idleMs || 0)} color="#D97706" />
          </div>
          <div className="text-[10px] text-steel/60 mt-3">
            {fmtNum(row?.readings || 0)} readings · {fmtTime(win.from)} → {fmtTime(win.to)}
          </div>
        </>
      )}
    </Panel>
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
  const plcConnected = fr.state === 'live' || fr.state === 'recent';
  const dataQuality = namedCount > 0 ? Math.round(((namedCount - faultCount) / namedCount) * 100) : 100;

  // Runtime / downtime / efficiency come from the SHARED activity engine
  // (rolling 24h): runtime = time the machine actually reported minus recorded
  // downtime — never window-minus-spans, which credited silent hours as runtime.
  const openDowntime = (downtime || []).filter((e) => !e.endedAt).length;
  const runtimeMs = actRow?.runningMs ?? 0;
  const downMs = actRow ? actRow.idleMs + actRow.stoppedMs + actRow.offlineMs : 0;
  const accounted = runtimeMs + downMs;
  const uptimePct = accounted > 0 ? Math.round((runtimeMs / accounted) * 100) : 0;
  const efficiency = machine.oee != null ? Math.round(machine.oee) : uptimePct;

  const checks: { label: string; text: string; color: string }[] = [];
  if (hasTemp && temp) {
    const high = temp.max >= 900; const low = temp.min < 50;
    checks.push({ label: 'Temperature', text: high ? 'High' : low ? 'Low' : 'Normal', color: high || low ? '#D97706' : '#059669' });
  }
  if (pressure) checks.push({ label: 'Pressure', text: 'Reporting', color: '#059669' });
  checks.push({ label: 'PLC Connection', text: plcConnected ? 'Connected' : 'Lost', color: plcConnected ? '#059669' : '#DC2626' });
  checks.push({ label: 'Data Flow', text: dataFlowing ? 'Active' : 'Stopped', color: dataFlowing ? '#059669' : '#D97706' });
  checks.push({ label: 'Sensor Health', text: faultCount ? `${faultCount} fault${faultCount > 1 ? 's' : ''}` : 'Good', color: faultCount ? '#DC2626' : '#059669' });

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
    checks, health, healthStatus,
    runtimeMs, downMs, uptimePct, efficiency, openDowntime,
    plcType: plcTypeOf(machine),
  };
}

function plcTypeOf(machine: Machine): string {
  const s = String(machine.machineId || machine.id || '').toLowerCase();
  if (/s7\s*-?\s*1500|s71500/.test(s)) return 'S7-1500';
  if (/s7\s*-?\s*1200|s71200/.test(s)) return 'S7-1200';
  if (/s7\s*-?\s*400|s7400/.test(s)) return 'S7-400';
  if (/s7\s*-?\s*300|s7300/.test(s)) return 'S7-300';
  if (/s7\s*-?\s*200|s7200/.test(s)) return 'S7-200';
  return '—';
}

// ── presentational building blocks ─────────────────────────────────────────────
function Panel({ icon: Icon, title, right, children }: { icon?: LucideIcon; title: string; right?: ReactNode; children: ReactNode }): JSX.Element {
  return (
    <div className="panel p-5 flex flex-col h-full">
      <div className="flex items-center gap-2 mb-4">
        {Icon && <Icon size={16} className="text-accent" />}
        <h3 className="font-semibold text-sm text-primary flex-1">{title}</h3>
        {right}
      </div>
      {children}
    </div>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }): JSX.Element {
  return (
    <div className="flex items-center justify-between py-2 text-sm">
      <span className="text-steel">{label}</span>
      <span className="text-right">{children}</span>
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

function MiniTile({ icon: Icon, accent, label, value }: { icon: LucideIcon; accent: string; label: string; value: ReactNode }): JSX.Element {
  return (
    <div className="rounded-lg border border-line bg-base px-3 py-2.5 flex items-center gap-2.5">
      <span className="w-8 h-8 rounded-lg flex items-center justify-center shrink-0" style={{ background: `${accent}18`, color: accent }}><Icon size={15} /></span>
      <div className="min-w-0">
        <div className="text-[10px] text-steel uppercase tracking-wide truncate">{label}</div>
        <div className="data text-sm font-bold text-primary truncate">{value}</div>
      </div>
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
