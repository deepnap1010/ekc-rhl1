// client/src/components/ProductionVsTarget.tsx
// The production-vs-target board (teammate-built UI, running on this app's
// assignment engine). Two shapes, one dataset:
//
//  ADMIN — one card per production GROUP (Cutting, SPG…): target attainment,
//  dia(s) being made, produced vs target bar, and one status dot per machine
//  (green running · yellow idle · red stopped · grey no signal). Clicking a
//  group opens its machines — each with its attainment donut, produced/target,
//  and its OWN runtime / idle / stopped / downtime split. Clicking a machine
//  opens the full operator-style board.
//
//  OPERATOR (a user with assigned machines) — a rich per-machine board: the big
//  "X of Y produced" donut, dia + stage + rate strip, inline hour-by-hour bars
//  with the target/hr line, performance & availability, and the machine's own
//  downtime split. The server scopes the data, so operators only ever see
//  their machines.
//
// Rates come from each machine's CURRENT assignment snapshot (frozen at
// assignment time — see server/models/MachineAssignment), targets are the
// DIA's rate over the whole measured window net of planned breaks, and the
// hourly bars ride the same confirmed-counter-step engine as every report.
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useQueries, keepPreviousData } from '@tanstack/react-query';
import { Target, Ruler, ArrowUpRight, ArrowLeft, CheckCircle2, AlertTriangle, Boxes, Flame } from 'lucide-react';
import { Donut } from './charts';
import { StatusPill, TimeStat } from './ui';
import { machineApi, productionApi } from '../api/endpoints';
import { useAppConfig } from '../hooks/useAppConfig';
import { useAuthStore } from '../store/auth';
import { windowNetMs, targetUnits, fmtTarget, fmtProcessing, hourlyRate, secToMinPerPc } from '../lib/targets';
import { processCompare, groupMachines } from '../lib/machineOrder';
import { useMachineName, useMachineTitle } from '../lib/machineName';
import { resolveRange, shiftDayOn } from '../store/filters';
import { fmtNum, fmtDuration } from '../lib/format';
import type { MachineActivityRow, MachineAssignment } from '../types/api';

const TEAL = '#0D9488', AMBER = '#D97706', RED = '#DC2626', SLATE = '#94A3B8', TRACK = '#E2E8F0';

interface Props {
  rows: MachineActivityRow[];
  windowMs: number;      // elapsed window (server clips `to` to now)
  windowLabel: string;
  from?: string;
  to?: string;
}

interface TargetRow {
  row: MachineActivityRow;
  stage: string;         // the assignment's stage name
  dia: string;           // targets exist only for machines with a dia assigned
  processingSec: number; // FROZEN on the assignment snapshot
  target: number;        // exact — display rounds (fmtTarget)
  actual: number;
  diff: number;          // actual - target: negative = behind
}

interface GroupTargets { key: string; label: string; targets: TargetRow[] }

// Attainment (actual/target) drives every color on the board:
// below 50% red · 50–90% orange · above 90% green.
const attainColor = (pct: number): string => (pct > 0.9 ? TEAL : pct >= 0.5 ? AMBER : RED);
const dotColor = (status: string): string =>
  status === 'running' ? TEAL : status === 'idle' ? AMBER : status === 'stopped' ? RED : SLATE;

// The panel's own window filter — independent of the page filter, present on
// admin and operator boards alike.
type WinMode = '' | 'hour' | 'shift' | 'today' | 'yesterday';
const hourLabel = (h: number): string => `${String(h % 24).padStart(2, '0')}:00`;

export default function ProductionVsTarget({ rows, windowMs, windowLabel, from, to }: Props): JSX.Element | null {
  const { shifts, breaks } = useAppConfig();
  const mName = useMachineName();
  const mTitle = useMachineTitle();
  const user = useAuthStore((st) => st.user);
  const can = useAuthStore((st) => st.can);
  const isOperator = (user?.assignedMachines?.length ?? 0) > 0;

  const { data: asgRows } = useQuery({
    queryKey: ['assignments', 'current'],
    queryFn: () => productionApi.currentAssignments().then((r) => r.data),
    enabled: can('production', 'view'),
    refetchInterval: 60_000,
    placeholderData: keepPreviousData,
    retry: false,
  });
  const asgBy = useMemo(() => {
    const m = new Map<string, MachineAssignment>();
    (asgRows || []).forEach((r) => m.set(r.machineRef.toUpperCase(), r));
    return m;
  }, [asgRows]);

  // The modal follows the LIVE row: only the code is stored, and the current
  // TargetRow is looked up each render — so its figures keep moving with the
  // board instead of freezing at open-time.
  const [openForCode, setOpenForCode] = useState<string | null>(null);
  const [openGroup, setOpenGroup] = useState<string | null>(null);

  // ── Window filter: page window (default) · per hour · per shift · today · yesterday
  const [mode, setMode] = useState<WinMode>('');
  const [shiftName, setShiftName] = useState('');
  const nowHour = new Date().getHours();
  const [hFrom, setHFrom] = useState(nowHour);      // per-hour: from which hour…
  const [hTo, setHTo] = useState(nowHour + 1);      // …to which hour (today)

  // "Today" must keep counting: without a clock input the memo below would
  // freeze the window at selection time and the 30s poll would re-read the
  // same stale range forever. A minute-stamp recomputes it (and rolls the
  // per-hour slice over midnight) while keeping query keys minute-stable.
  const [minuteStamp, setMinuteStamp] = useState(() => Math.floor(Date.now() / 60_000));
  useEffect(() => {
    const t = setInterval(() => setMinuteStamp(Math.floor(Date.now() / 60_000)), 30_000);
    return () => clearInterval(t);
  }, []);

  const ownRange = useMemo(() => {
    void minuteStamp;   // clock input — see above
    if (!mode) return null;
    if (mode === 'today' || mode === 'yesterday') {
      return resolveRange({ preset: mode, shiftName: '', customFrom: '', customTo: '' }, shifts);
    }
    if (mode === 'shift') {
      if (!shiftName) return null;
      return resolveRange({ preset: 'today', shiftName, customFrom: '', customTo: '' }, shifts);
    }
    // Per hour — a chosen slice of today; 24 means midnight at the end of it.
    if (hTo <= hFrom) return null;
    const base = new Date(); base.setHours(0, 0, 0, 0);
    return { from: new Date(base.getTime() + hFrom * 3600_000), to: new Date(base.getTime() + hTo * 3600_000) };
  }, [mode, shiftName, hFrom, hTo, shifts, minuteStamp]);

  const fromISO = ownRange?.from.toISOString();
  const toISO = ownRange?.to.toISOString();
  const { data: ownData, isFetching: ownFetching } = useQuery({
    // Same key shape as the page's activity query — matching windows share one response.
    queryKey: ['activity', fromISO, toISO],
    queryFn: () => machineApi.activity({ from: fromISO as string, to: toISO as string }),
    enabled: !!mode && !!fromISO && !!toISO,
    refetchInterval: 30_000,
    placeholderData: keepPreviousData,
  });
  // Only trust a response that covers THIS override's window (same guard as the groups).
  const own = mode && ownData?.meta?.from === fromISO ? ownData : undefined;
  const members = useMemo(() => new Set(rows.map((r) => r.code)), [rows]);
  const effRows = own ? own.data.filter((r) => members.has(r.code)) : rows;
  const effWindowMs = own ? Math.max(own.meta?.windowMs ?? 0, 0) : windowMs;
  const effFrom = own ? fromISO : from;
  const effTo = own ? toISO : to;
  const effLabel = mode === 'hour' ? `${hourLabel(hFrom)} → ${hourLabel(hTo)} · Today`
    : mode === 'shift' ? (shiftName ? `${shiftName} · Today` : 'Pick a shift')
    : mode === 'today' ? 'Today'
    : mode === 'yesterday' ? 'Yesterday'
    : windowLabel;

  // The measured stretch of the window, net of planned breaks — targets divide
  // this by each assignment's frozen processing time.
  const netMs = useMemo(() => {
    if (effFrom && effTo) return windowNetMs(new Date(effFrom).getTime(), new Date(effTo).getTime(), breaks);
    return effWindowMs;
  }, [effFrom, effTo, effWindowMs, breaks]);

  const targets = useMemo<TargetRow[]>(() => {
    const out: TargetRow[] = [];
    for (const row of [...effRows].sort(processCompare)) {
      if (row.production == null) continue;                       // no counter, nothing to compare
      // Dia FIRST: the dia is the product, so a machine has no rate or target
      // until it's set up with one. Assigning a dia is what activates it here.
      const a = asgBy.get(row.code.toUpperCase());
      if (!a) continue;
      const target = targetUnits(a.snapshot.processingSec, netMs);
      if (target <= 0) continue;
      const actual = row.production;
      out.push({
        row, dia: a.snapshot.diaName, stage: a.snapshot.stageName,
        processingSec: a.snapshot.processingSec, target, actual, diff: actual - target,
      });
    }
    return out;
  }, [effRows, asgBy, netMs]);

  // A dia-assigned machine that is NOT on the board must say WHY — silent
  // exclusion reads as a bug.
  const excluded = useMemo(() => {
    const included = new Set(targets.map((t) => t.row.code));
    const out: { code: string; reason: string }[] = [];
    for (const row of effRows) {
      if (!asgBy.get(row.code.toUpperCase()) || included.has(row.code)) continue;
      if (row.production == null && row.avgTemp == null) out.push({ code: row.code, reason: 'no production counter' });
    }
    return out;
  }, [effRows, targets, asgBy]);

  // Furnaces: no counter — heat IS their output, so the board still owes them a
  // card. Any machine reporting a measured temperature and no pieces gets a
  // heat card in the same grid, dia or not.
  const heatGroups = useMemo(() => {
    const rows = effRows.filter((r) => r.production == null && r.avgTemp != null);
    return groupMachines(rows).map((g) => ({ key: `heat:${g.key}`, label: g.label, rows: g.machines }));
  }, [effRows]);

  // Machines bucketed into their production groups — the admin board's cards.
  const groups = useMemo<GroupTargets[]>(() => {
    const byRow = new Map(targets.map((t) => [t.row, t]));
    return groupMachines(targets.map((t) => t.row))
      .map((g) => ({ key: g.key, label: g.label, targets: g.machines.map((m) => byRow.get(m) as TargetRow) }));
  }, [targets]);
  // An operator with several machines in ONE family reads them as a line, not
  // as a row of unrelated boards — so that family gets a group card, opening to
  // the same drill-down an admin sees. A family holding only ONE of their
  // machines has nothing to summarise, so it stays the full board it already
  // was. Both rules are per family, so a mixed assignment gets both shapes.
  const grouped = useMemo(() => groups.filter((g) => g.targets.length > 1), [groups]);
  const lone = useMemo(() => groups.filter((g) => g.targets.length === 1).map((g) => g.targets[0]), [groups]);

  const open = openGroup ? groups.find((g) => g.key === openGroup) ?? null : null;
  // A group that vanished from the data (window change, refetch) must not
  // silently re-open the drill-down the moment it reappears.
  useEffect(() => {
    if (openGroup && !groups.some((g) => g.key === openGroup) && !heatGroups.some((g) => g.key === openGroup)) setOpenGroup(null);
  }, [openGroup, groups, heatGroups]);
  const openFor = openForCode ? targets.find((t) => t.row.code === openForCode) ?? null : null;

  if (!can('production', 'view')) return null;
  const hasDia = rows.some((r) => asgBy.get(r.code.toUpperCase()));
  if (!hasDia) {
    if (!(asgRows || []).length && !rows.length) return null;
    return (
      <div className="panel p-4 flex items-center gap-3 flex-wrap">
        <span className="w-8 h-8 rounded-lg bg-accent/10 flex items-center justify-center shrink-0"><Ruler size={15} className="text-accent" /></span>
        <div className="text-sm text-steel">
          Assign a dia to a machine to start tracking its target — the dia defines the product, so targets begin there.
        </div>
        <Link to="/settings?section=diastages" className="ml-auto text-xs text-accent hover:underline inline-flex items-center gap-1">
          Settings → Dia &amp; Stages <ArrowUpRight size={12} />
        </Link>
      </div>
    );
  }

  const totalActual = targets.reduce((n, t) => n + t.actual, 0);
  const totalTarget = targets.reduce((n, t) => n + t.target, 0);
  // Today/Yesterday windows frame the hourly bars midnight-to-midnight; every
  // other window shows its last 8 hours.
  const barsFullDay = effLabel === 'Today' || effLabel === 'Yesterday';
  const selCls = (active: boolean) =>
    `rounded-lg border px-2.5 py-1.5 text-xs outline-none cursor-pointer transition-colors hover:border-accent/40 ${
      active ? 'border-accent/40 bg-accent/5 text-accent font-medium' : 'border-line bg-base text-steel'
    }`;

  return (
    <div className="panel p-4">
      <div className="flex items-start gap-2.5 mb-3.5 flex-wrap">
        <span className="w-8 h-8 rounded-xl bg-accent/10 flex items-center justify-center shrink-0"><Target size={16} className="text-accent" /></span>
        <div className="min-w-0">
          <h2 className="font-semibold text-sm text-primary">Production vs Target</h2>
          <p className="text-[11px] text-steel">
            {effLabel}{mode && !own ? ' · loading…' : mode && ownFetching ? ' · updating…' : ''} · dia-assigned machines · targets from each assignment's rate
          </p>
        </div>

        {/* The window this board measures — independent of the page filter */}
        <div className="ml-auto flex items-center gap-1.5 flex-wrap">
          <select value={mode} onChange={(e) => setMode(e.target.value as WinMode)}
            className={selCls(!!mode)} title="Measure targets over this window">
            <option value="">Page window · {windowLabel}</option>
            <option value="hour">Per hour…</option>
            <option value="shift">Per shift…</option>
            <option value="today">Today</option>
            <option value="yesterday">Yesterday</option>
          </select>
          {mode === 'shift' && (
            <select value={shiftName} onChange={(e) => setShiftName(e.target.value)} className={selCls(!!shiftName)} title="Which shift (today)">
              <option value="">Pick a shift…</option>
              {shifts.map((sh) => <option key={sh.name} value={sh.name}>{sh.name} · {sh.start}–{sh.end}</option>)}
            </select>
          )}
          {mode === 'hour' && (
            <span className="inline-flex items-center gap-1">
              <select value={hFrom} onChange={(e) => { const v = Number(e.target.value); setHFrom(v); if (hTo <= v) setHTo(v + 1); }}
                className={selCls(true)} title="From (today)">
                {Array.from({ length: 24 }, (_, h) => <option key={h} value={h}>{hourLabel(h)}</option>)}
              </select>
              <span className="text-steel text-xs">→</span>
              <select value={hTo} onChange={(e) => setHTo(Number(e.target.value))} className={selCls(true)} title="To (today)">
                {Array.from({ length: 24 - hFrom }, (_, i) => hFrom + 1 + i).map((h) => (
                  <option key={h} value={h}>{hourLabel(h)}</option>
                ))}
              </select>
            </span>
          )}
          {!(mode === 'shift' && !shiftName) && targets.length > 0 && (
            <span className={`pill font-bold ${totalActual >= totalTarget ? 'bg-running/10 text-running' : 'bg-stopped/10 text-stopped'}`}>
              {fmtNum(totalActual)} / {fmtTarget(totalTarget)} pcs
            </span>
          )}
        </div>
      </div>

      {/* Shift mode with no shift picked must not show page-window figures
          under a shift label — ask for the shift instead. */}
      {mode === 'shift' && !shiftName ? (
        <div className="text-sm text-steel py-6 text-center">Pick a shift to measure against.</div>
      ) : targets.length === 0 ? (
        <div className="text-sm text-steel py-6 text-center">No production counted for {effLabel}.</div>
      ) : open && openFor ? (
        /* ── One MACHINE opened — the full board. Same for either role. ── */
        <div>
          <button onClick={() => setOpenForCode(null)}
            className="mb-3 inline-flex items-center gap-1.5 text-xs font-medium text-steel hover:text-accent transition-colors">
            <ArrowLeft size={13} /> {open.label}
          </button>
          <OperatorMachineBoard t={openFor} windowMs={netMs} from={effFrom} to={effTo} fullDay={barsFullDay} />
        </div>
      ) : openGroup?.startsWith('heat:') && heatGroups.some((g) => g.key === openGroup) ? (
        /* ── ADMIN, a HEAT group opened — its furnaces, temperature first ── */
        <div>
          <button onClick={() => setOpenGroup(null)}
            className="mb-3 inline-flex items-center gap-1.5 text-xs font-medium text-steel hover:text-accent transition-colors">
            <ArrowLeft size={13} /> All groups
          </button>
          <div className="grid sm:grid-cols-2 xl:grid-cols-3 gap-3">
            {heatGroups.find((g) => g.key === openGroup)!.rows.map((r) => (
              <FurnaceMachineCard key={r.code} r={r} windowLabel={effLabel} />
            ))}
          </div>
        </div>
      ) : open ? (
        /* ── One group opened — its machines, each with its own split ── */
        <div>
          <button onClick={() => { setOpenGroup(null); setOpenForCode(null); }}
            className="mb-3 inline-flex items-center gap-1.5 text-xs font-medium text-steel hover:text-accent transition-colors">
            <ArrowLeft size={13} /> All groups
          </button>
          {/* Line-dashboard shape: the group's summary holds the LEFT column
              (like a line header) and the machines fill a grid on the RIGHT
              that simply grows row by row as machines are added. */}
          <div className="grid lg:grid-cols-[260px_1fr] gap-4">
            <GroupSummary g={open} windowMs={effWindowMs} />
            <div className="grid sm:grid-cols-2 2xl:grid-cols-3 gap-3 content-start">
              {open.targets.map((t) => (
                <MachineTargetCard key={t.row.code} t={t} onOpen={() => setOpenForCode(t.row.code)} />
              ))}
            </div>
          </div>
        </div>
      ) : isOperator ? (
        /* ── OPERATOR — families they hold more than one of become group cards;
            a family holding just one of their machines stays a full board. ── */
        <div className="space-y-4">
          {(grouped.length > 0 || heatGroups.length > 0) && (
            <div className="grid sm:grid-cols-2 xl:grid-cols-3 gap-3">
              {grouped.map((g) => (
                <GroupCard key={g.key} g={g} onOpen={() => setOpenGroup(g.key)} />
              ))}
              {heatGroups.map((g) => (
                <HeatGroupCard key={g.key} g={g} onOpen={() => setOpenGroup(g.key)} />
              ))}
            </div>
          )}
          {lone.length > 0 && (
            <div className={`grid gap-4 ${lone.length > 1 ? 'xl:grid-cols-2' : ''}`}>
              {lone.map((t) => (
                <OperatorMachineBoard key={t.row.code} t={t} windowMs={netMs} from={effFrom} to={effTo} fullDay={barsFullDay} />
              ))}
            </div>
          )}
        </div>
      ) : (
        /* ── ADMIN — one card per group ── */
        <div className="grid sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4 gap-3">
          {groups.map((g) => (
            <GroupCard key={g.key} g={g} onOpen={() => setOpenGroup(g.key)} />
          ))}
          {heatGroups.map((g) => (
            <HeatGroupCard key={g.key} g={g} onOpen={() => setOpenGroup(g.key)} />
          ))}
        </div>
      )}

      {/* Dia-assigned machines that can't be measured yet, and exactly why —
          so "why is my machine missing" answers itself. */}
      {excluded.length > 0 && !(mode === 'shift' && !shiftName) && (
        <div className="mt-3.5 pt-3 border-t border-line text-[11px] text-steel">
          <span className="font-medium text-primary">Dia set, but not on the board yet: </span>
          <Link to="/settings?section=diastages" className="text-accent hover:underline inline-flex items-center gap-0.5 float-right">
            Settings → Dia &amp; Stages <ArrowUpRight size={11} />
          </Link>
          {excluded.map((e) => <span key={e.code}><span className="data font-medium text-primary" title={mTitle(e.code)}>{mName(e.code)}</span> — {e.reason}. </span>)}
        </div>
      )}
    </div>
  );
}

// Thin produced-vs-target progress bar, colored by attainment.
function Bar({ actual, target }: { actual: number; target: number }): JSX.Element {
  const pct = target ? Math.min((actual / target) * 100, 100) : 0;
  return (
    <div className="h-1.5 bg-line rounded-full overflow-hidden">
      <div className="h-full rounded-full transition-all" style={{ width: `${pct}%`, background: attainColor(actual / (target || 1)) }} />
    </div>
  );
}

// One dot per machine — the group's health at a glance.
function StatusDots({ rows }: { rows: MachineActivityRow[] }): JSX.Element {
  const mName = useMachineName();
  return (
    <div className="flex items-center gap-1.5 flex-wrap">
      {rows.map((r) => (
        <span key={r.code} className="w-2.5 h-2.5 rounded-full shrink-0"
          style={{ background: dotColor(r.status) }}
          title={`${mName(r.code)} · ${r.status}`} />
      ))}
    </div>
  );
}

// ── Furnace cards: heat where the others show pieces ─────────────────────────
const HEAT = '#D97706';
type HeatGroup = { key: string; label: string; rows: MachineActivityRow[] };

function HeatGroupCard({ g, onOpen }: { g: HeatGroup; onOpen: () => void }): JSX.Element {
  const temps = g.rows.filter((r) => r.avgTemp != null);
  const avg = temps.length ? temps.reduce((n, r) => n + (r.avgTemp as number), 0) / temps.length : null;
  const zones = g.rows.reduce((n, r) => n + (r.tempZones || 0), 0);
  return (
    <button onClick={onOpen} className="card p-4 flex flex-col text-left transition-all hover:shadow-md hover:border-accent/30 hover:-translate-y-0.5 group">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="font-semibold text-sm text-primary truncate group-hover:text-accent transition-colors">{g.label}</div>
          <div className="flex items-center gap-1 mt-0.5 text-[10px] text-steel truncate">
            <Flame size={10} className="shrink-0" style={{ color: HEAT }} />
            <span>heat is the output — no piece counter</span>
          </div>
        </div>
        <div className="text-right shrink-0">
          <span className="data text-2xl font-bold leading-none" style={{ color: HEAT }}>
            {avg != null ? fmtNum(Math.round(avg)) : '—'}<span className="text-sm">°C</span>
          </span>
          <div className="label mt-0.5">avg temp</div>
        </div>
      </div>

      <div className="mt-3 flex items-end justify-between gap-2">
        <div>
          <div className="data text-xl font-bold leading-none text-primary">{g.rows.length}</div>
          <div className="label mt-0.5">Machine{g.rows.length === 1 ? '' : 's'}</div>
        </div>
        <div className="text-right">
          <div className="data text-xl font-bold leading-none text-steel">{zones}</div>
          <div className="label mt-0.5">Heat zone{zones === 1 ? '' : 's'}</div>
        </div>
      </div>
      <div className="mt-2 h-1.5 rounded-full overflow-hidden bg-base">
        <div className="h-full rounded-full" style={{ width: avg != null ? '100%' : '0%', background: `linear-gradient(90deg, ${HEAT}55, ${HEAT})` }} />
      </div>

      <div className="mt-3 space-y-1.5">
        <AttentionLine rows={g.rows} />
        <StatusDots rows={g.rows} />
      </div>
    </button>
  );
}

function FurnaceMachineCard({ r, windowLabel }: { r: MachineActivityRow; windowLabel: string }): JSX.Element {
  const mName = useMachineName();
  const mTitle = useMachineTitle();
  return (
    <Link to={`/machines/${encodeURIComponent(r.code)}`}
      className="card p-4 block transition-all hover:shadow-md hover:border-accent/30 group">
      <div className="flex items-center gap-2">
        <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: dotColor(r.status) }} />
        <span className="data font-bold text-sm text-primary truncate group-hover:text-accent transition-colors" title={mTitle(r.code)}>{mName(r.code)}</span>
        <span className="ml-auto shrink-0"><StatusPill status={r.status} /></span>
      </div>

      <div className="mt-3">
        <div className="label inline-flex items-center gap-1"><Flame size={10} style={{ color: HEAT }} /> Temperature · {windowLabel}</div>
        <div className="mt-1">
          <span className="data text-3xl font-bold leading-none" style={{ color: HEAT }}>
            {r.avgTemp != null ? fmtNum(Math.round(r.avgTemp)) : '—'}
          </span>
          <span className="text-sm text-steel"> °C avg{r.tempZones ? ` · over ${r.tempZones} zone${r.tempZones === 1 ? '' : 's'}` : ''}</span>
        </div>
      </div>

      <div className="mt-3 grid grid-cols-4 gap-1.5">
        <TimeStat label="Uptime" ms={r.runningMs} color={TEAL} />
        <TimeStat label="Idle" ms={r.idleMs} color={AMBER} />
        <TimeStat label="Stopped" ms={r.stoppedMs} color={RED} />
        <TimeStat label="Offline" ms={r.offlineMs} color={SLATE} />
      </div>
    </Link>
  );
}

// "All machines are working fine" — or exactly which ones aren't.
function AttentionLine({ rows }: { rows: MachineActivityRow[] }): JSX.Element {
  const mName = useMachineName();
  const bad = rows.filter((r) => r.status === 'stopped' || r.status === 'offline');
  if (!bad.length) {
    return (
      <span className="inline-flex items-center gap-1 text-[10px] text-running font-medium">
        <CheckCircle2 size={11} /> All machines are working fine
      </span>
    );
  }
  return (
    <span className="flex items-start gap-1 text-[10px] text-stopped font-medium min-w-0" title={bad.map((r) => mName(r.code)).join(', ')}>
      <AlertTriangle size={11} className="shrink-0 mt-px" />
      <span className="min-w-0 break-words">
        {bad.map((r) => mName(r.code)).join(', ')} need{bad.length === 1 ? 's' : ''} attention
      </span>
    </span>
  );
}

// ── ADMIN · one production group ─────────────────────────────────────────────
function GroupCard({ g, onOpen }: { g: GroupTargets; onOpen: () => void }): JSX.Element {
  const actual = g.targets.reduce((n, t) => n + t.actual, 0);
  const target = g.targets.reduce((n, t) => n + t.target, 0);
  const pct = target ? actual / target : 0;
  const dias = [...new Set(g.targets.map((t) => t.dia))];
  return (
    <button onClick={onOpen} className="card p-4 flex flex-col text-left transition-all hover:shadow-md hover:border-accent/30 hover:-translate-y-0.5 group">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="font-semibold text-sm text-primary truncate group-hover:text-accent transition-colors">{g.label}</div>
          <div className="flex items-center gap-1 mt-0.5 text-[10px] text-steel truncate">
            <Ruler size={10} className="shrink-0" />
            <span className="data font-medium text-primary truncate" title={dias.join(', ')}>
              {dias.length === 1 ? dias[0] : `${dias.length} dias`}
            </span>
          </div>
        </div>
        <div className="text-right shrink-0">
          <span className="data text-2xl font-bold leading-none" style={{ color: attainColor(pct) }}>{Math.round(pct * 100)}<span className="text-sm">%</span></span>
          <div className="label mt-0.5">of target</div>
        </div>
      </div>

      <div className="mt-3 flex items-end justify-between gap-2">
        <div>
          <div className="data text-xl font-bold leading-none text-primary">{fmtNum(actual)}</div>
          <div className="label mt-0.5">Part produced</div>
        </div>
        <div className="text-right">
          <div className="data text-xl font-bold leading-none text-steel">{fmtTarget(target)}</div>
          <div className="label mt-0.5">Target</div>
        </div>
      </div>
      <div className="mt-2"><Bar actual={actual} target={target} /></div>

      <div className="mt-3 space-y-1.5">
        <AttentionLine rows={g.targets.map((t) => t.row)} />
        <StatusDots rows={g.targets.map((t) => t.row)} />
      </div>
    </button>
  );
}

// The opened group's own summary, beside its machines.
function GroupSummary({ g, windowMs }: { g: GroupTargets; windowMs: number }): JSX.Element {
  const actual = g.targets.reduce((n, t) => n + t.actual, 0);
  const target = g.targets.reduce((n, t) => n + t.target, 0);
  const pct = target ? actual / target : 0;
  const run = g.targets.reduce((n, t) => n + t.row.runningMs, 0);
  const idle = g.targets.reduce((n, t) => n + t.row.idleMs, 0);
  const stop = g.targets.reduce((n, t) => n + t.row.stoppedMs, 0);
  const avail = windowMs > 0 ? Math.round((run / (windowMs * g.targets.length)) * 100) : 0;
  return (
    // Deliberately NOT the machine-card look: accent left rail + tinted ground
    // so the eye reads "this is the group's summary", not a sixth machine.
    <div className="rounded-2xl border border-accent/30 border-l-4 border-l-accent bg-accent/5 p-4 h-full flex flex-col">
      <div className="text-[9px] uppercase tracking-widest text-accent font-bold mb-1.5">Group summary</div>
      <div className="flex items-center gap-2 mb-2">
        <span className="w-7 h-7 rounded-lg bg-accent/15 flex items-center justify-center shrink-0"><Boxes size={14} className="text-accent" /></span>
        <div className="font-semibold text-sm text-primary truncate">{g.label}</div>
      </div>
      <div className="data text-3xl font-bold leading-none" style={{ color: attainColor(pct) }}>{Math.round(pct * 100)}<span className="text-base">%</span></div>
      <div className="label mt-0.5 mb-3">of target · {avail}% availability</div>
      <div className="flex items-end justify-between gap-2">
        <div><div className="data text-lg font-bold leading-none text-primary">{fmtNum(actual)}</div><div className="label mt-0.5">Produced</div></div>
        <div className="text-right"><div className="data text-lg font-bold leading-none text-steel">{fmtTarget(target)}</div><div className="label mt-0.5">Target</div></div>
      </div>
      <div className="mt-2 mb-3"><Bar actual={actual} target={target} /></div>
      <div className="grid grid-cols-3 gap-1.5 mb-3">
        <TimeStat label="Runtime" ms={run} color={TEAL} />
        <TimeStat label="Idle" ms={idle} color={AMBER} />
        <TimeStat label="Stopped" ms={stop} color={RED} />
      </div>
      <div className="space-y-1.5">
        <AttentionLine rows={g.targets.map((t) => t.row)} />
        <StatusDots rows={g.targets.map((t) => t.row)} />
      </div>
      <GroupWeekChart g={g} />
    </div>
  );
}

// The group's LAST 7 DAYS as day bars — % of target per production day, the
// line-dashboard's "month wise" chart at week scale. Each bar reads from the
// same activity engine (one cached query per day; finished days never
// refetch), and each day's target is the same net-window model as everything
// else: the day's span at each machine's frozen rate, breaks excluded.
function GroupWeekChart({ g }: { g: GroupTargets }): JSX.Element {
  const { shifts, breaks } = useAppConfig();
  const nowMin = Math.floor(Date.now() / 60_000) * 60_000;
  const days = useMemo(() => {
    // PRODUCTION days (07:00 → 07:00 with this plant's shifts), anchored the
    // same way the Today/Yesterday filters are — so a bar and the Yesterday
    // filter always quote the same pieces.
    const anchor = new Date(); anchor.setHours(0, 0, 0, 0);
    if (nowMin < shiftDayOn(shifts, anchor).from.getTime()) anchor.setDate(anchor.getDate() - 1);
    return Array.from({ length: 7 }, (_, i) => {
      const d = new Date(anchor); d.setDate(d.getDate() - (6 - i));
      const win = shiftDayOn(shifts, d);
      const from = win.from.getTime();
      const to = Math.min(win.to.getTime(), nowMin);
      return {
        from, to,
        fromISO: new Date(from).toISOString(), toISO: new Date(to).toISOString(),
        label: win.from.toLocaleDateString(undefined, { weekday: 'short' }),
        date: win.from.toLocaleDateString(undefined, { day: 'numeric', month: 'short' }),
      };
    });
  }, [nowMin, shifts]);

  const codes = useMemo(() => new Set(g.targets.map((t) => t.row.code)), [g]);
  const rates = useMemo(() => new Map(g.targets.map((t) => [t.row.code, t.processingSec])), [g]);
  const results = useQueries({
    queries: days.map((d) => ({
      queryKey: ['activity', d.fromISO, d.toISO],
      queryFn: () => machineApi.activity({ from: d.fromISO, to: d.toISO }),
      // A finished day never changes; only today keeps moving.
      staleTime: d.to < nowMin ? 30 * 60_000 : 60_000,
    })),
  });

  const bars = days.map((d, i) => {
    const res = results[i].data;
    const netMs = windowNetMs(d.from, d.to, breaks);
    let actual = 0, target = 0;
    for (const row of res?.data ?? []) {
      if (!codes.has(row.code) || row.production == null) continue;
      const sec = rates.get(row.code);
      if (!sec) continue;
      actual += row.production;
      target += targetUnits(sec, netMs);
    }
    return { ...d, actual, target, pct: target > 0 ? actual / target : null };
  });
  const anyData = bars.some((b) => b.pct != null);

  return (
    <div className="mt-3 pt-3 border-t border-line flex-1 flex flex-col min-h-[120px]">
      <div className="label mb-2">This week · % of target</div>
      {!anyData ? (
        <div className="text-[10px] text-steel flex-1">Reading the week's history…</div>
      ) : (
        <div className="flex items-end gap-1.5 flex-1" style={{ minHeight: 80 }}>
          {bars.map((b) => {
            const pct = b.pct ?? 0;
            // Cap the scale at 120% so an over-target day doesn't flatten the rest.
            const h = (Math.min(pct, 1.2) / 1.2) * 100;
            return (
              <div key={b.from} className="flex-1 h-full flex flex-col items-center justify-end group/bar cursor-default"
                title={`${b.label} ${b.date} · ${fmtNum(b.actual)} / ${fmtTarget(b.target)} pcs${b.pct != null ? ` · ${Math.round(pct * 100)}%` : ' · no data'}`}>
                {b.pct != null && (
                  <span className="data text-[9px] font-bold mb-0.5 opacity-70 group-hover/bar:opacity-100 transition-opacity" style={{ color: attainColor(pct) }}>
                    {Math.round(pct * 100)}
                  </span>
                )}
                <div className="w-full rounded-t transition-all group-hover/bar:brightness-110"
                  style={{ height: `${b.pct != null ? Math.max(h, 3) : 0}%`, background: b.pct != null ? attainColor(pct) : TRACK }} />
              </div>
            );
          })}
        </div>
      )}
      <div className="flex gap-1.5 mt-1 border-t border-line pt-1">
        {bars.map((b) => (
          <div key={b.from} className="flex-1 text-center text-[9px] text-steel">{b.label}</div>
        ))}
      </div>
    </div>
  );
}

// One machine inside an opened group — donut, produced/target, own time split.
function MachineTargetCard({ t, onOpen }: { t: TargetRow; onOpen: () => void }): JSX.Element {
  const mName = useMachineName();
  const mTitle = useMachineTitle();
  const pct = t.target ? t.actual / t.target : 0;
  const color = attainColor(pct);
  const rate = hourlyRate(t.processingSec);
  return (
    <button onClick={onOpen} className="card p-3.5 w-full flex flex-col text-left transition-all hover:shadow-md hover:border-accent/30 group" title="Open this machine's board">
      <div className="flex items-center gap-3">
        <Donut size={76} thickness={8} emptyColor={TRACK}
          segments={[
            { label: 'Produced', value: Math.min(t.actual, t.target), color },
            { label: 'Remaining', value: Math.max(t.target - t.actual, 0), color: TRACK },
          ]}>
          <span className="data text-sm font-bold leading-none" style={{ color }}>{Math.round(pct * 100)}%</span>
        </Donut>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="data font-bold text-xs text-primary truncate group-hover:text-accent transition-colors" title={mTitle(t.row.code)}>{mName(t.row.code)}</span>
            <StatusPill status={t.row.status} />
          </div>
          <div className="flex items-center gap-1 mt-1 text-[10px] text-steel truncate">
            <Ruler size={10} className="shrink-0" /><span className="data font-medium text-primary">{t.dia}</span>
          </div>
          <div className="text-[10px] text-steel mt-0.5 truncate">
            {t.stage} · {secToMinPerPc(t.processingSec)} min/pc · {fmtTarget(rate)}/hr
          </div>
          <div className="flex items-baseline gap-1 mt-1">
            <span className="data text-base font-bold leading-none" style={{ color }}>{fmtNum(t.actual)}</span>
            <span className="text-xs font-semibold text-primary/80">/ {fmtTarget(t.target)} pcs · {t.diff >= -0.5 && t.diff < 0.5 ? 'on target' : t.diff >= 0 ? `${fmtTarget(t.diff)} ahead` : `${fmtTarget(-t.diff)} behind`}</span>
          </div>
        </div>
      </div>
      <div className="mt-2.5"><Bar actual={t.actual} target={t.target} /></div>
      {/* This machine's OWN split of the window */}
      <div className="grid grid-cols-4 gap-1.5 mt-2.5">
        <TimeStat label="Runtime" ms={t.row.runningMs} color={TEAL} />
        <TimeStat label="Idle" ms={t.row.idleMs} color={AMBER} />
        <TimeStat label="Stopped" ms={t.row.stoppedMs} color={RED} />
        <TimeStat label="Downtime" ms={t.row.idleMs + t.row.stoppedMs} color="#991B1B" />
      </div>
    </button>
  );
}

// ── OPERATOR · one assigned machine, everything on one board ─────────────────
function OperatorMachineBoard({ t, windowMs, from, to, fullDay }: { t: TargetRow; windowMs: number; from?: string; to?: string; fullDay?: boolean }): JSX.Element {
  const mName = useMachineName();
  const mTitle = useMachineTitle();
  const pct = t.target ? t.actual / t.target : 0;
  const color = attainColor(pct);
  const rate = hourlyRate(t.processingSec);
  const availPct = windowMs > 0 ? Math.round((t.row.runningMs / windowMs) * 100) : 0;
  const madePerHr = windowMs > 0 ? Math.round((t.actual / (windowMs / 3600_000)) * 10) / 10 : 0;
  return (
    <div className="card p-4">
      {/* Header strip — machine · dia · stage · rate, like the operator screen's part strip */}
      <div className="flex items-center gap-2.5 flex-wrap pb-3 border-b border-line">
        <span className="data font-bold text-sm text-primary" title={mTitle(t.row.code)}>{mName(t.row.code)}</span>
        <StatusPill status={t.row.status} />
        <span className="inline-flex items-center gap-1 pill bg-accent/10 text-accent data !text-[10px]"><Ruler size={10} /> {t.dia}</span>
        <span className="text-[11px] text-steel ml-auto">{t.stage} · {fmtProcessing(t.processingSec)}/pc · target {fmtTarget(rate)}/hr</span>
      </div>

      <div className="flex items-center gap-5 mt-3.5 flex-wrap">
        {/* The big "X of Y produced" ring */}
        <Donut size={150} thickness={16} emptyColor={TRACK}
          segments={[
            { label: 'Produced', value: Math.min(t.actual, t.target), color },
            { label: 'Remaining', value: Math.max(t.target - t.actual, 0), color: TRACK },
          ]}>
          <span className="data text-3xl font-bold leading-none text-primary">{fmtNum(t.actual)}</span>
          <span className="text-[10px] text-steel mt-1 leading-tight">of {fmtTarget(t.target)}<br />part produced</span>
        </Donut>

        <div className="flex-1 min-w-[200px] space-y-2.5">
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-2">
            <Stat label="Performance" value={`${Math.round(pct * 100)}%`} color={color} sub="of target" />
            <Stat label="Availability" value={`${availPct}%`} color={availPct >= 75 ? TEAL : availPct >= 50 ? AMBER : RED} sub="runtime share" />
            <Stat label="Actual rate" value={`${madePerHr}/hr`} color={madePerHr >= rate ? TEAL : AMBER} sub={`target ${fmtTarget(rate)}/hr`} />
            <Stat label={t.diff >= 0 ? 'Ahead' : 'Behind'} value={fmtTarget(Math.abs(t.diff))} color={t.diff >= 0 ? TEAL : RED} sub="pcs vs target" />
          </div>
          <Bar actual={t.actual} target={t.target} />
        </div>
      </div>

      {/* Hour-by-hour, inline — the operator watches this live */}
      {from && to && (
        <div className="mt-4">
          <div className="label mb-1.5">Hourly production</div>
          <HourlyBars code={t.row.code} from={from} to={to} perHr={rate} height={110} fullDay={fullDay} />
        </div>
      )}

      {/* The machine's own split of the window */}
      <div className="grid grid-cols-4 gap-1.5 mt-3.5 pt-3 border-t border-line">
        <TimeStat label="Runtime" ms={t.row.runningMs} color={TEAL} />
        <TimeStat label="Idle" ms={t.row.idleMs} color={AMBER} />
        <TimeStat label="Stopped" ms={t.row.stoppedMs} color={RED} />
        <TimeStat label="Downtime" ms={t.row.idleMs + t.row.stoppedMs} color="#991B1B" />
      </div>
      <div className="text-[10px] text-steel mt-1.5">
        Total downtime {fmtDuration(t.row.idleMs + t.row.stoppedMs)}
        {t.row.offlineMs >= 60_000 && <> · signal lost {fmtDuration(t.row.offlineMs)}</>}
        {t.row.productionFrom && <> · pieces counted at {t.row.productionFrom}</>}
      </div>
    </div>
  );
}

function Stat({ label, value, sub, color }: { label: string; value: string; sub?: string; color: string }): JSX.Element {
  return (
    <div className="rounded-lg border border-line bg-base px-2.5 py-1.5">
      <div className="label truncate">{label}</div>
      <div className="data text-lg font-bold leading-none mt-0.5" style={{ color }}>{value}</div>
      {sub && <div className="text-[9px] text-steel mt-0.5 truncate">{sub}</div>}
    </div>
  );
}

// ── Hour-by-hour bars with the target/hr line ────────────────────────────────
// Real confirmed counter steps from /machines/:code/hourly; windows are
// clipped to the endpoint's 7-day cap.
function HourlyBars({ code, from, to, perHr, height = 160, fullDay = false }: {
  code: string; from: string; to: string; perHr: number | null; height?: number; fullDay?: boolean;
}): JSX.Element {
  const HOUR = 3600_000;
  // Clamp "now" to the MINUTE: a raw Date.now() here lands in the query key,
  // and a millisecond-fresh key per render is a self-sustaining refetch loop
  // whenever the window's `to` is still in the future (a running hour/shift).
  const nowMin = Math.floor(Date.now() / 60_000) * 60_000;
  // Buckets sit on the plant's LOCAL clock hours (07:00–08:00), never UTC's:
  // the request's `from` is a local hour boundary and the server anchors its
  // bucket grid to it.
  const alignHour = (ms: number) => { const d = new Date(ms); d.setMinutes(0, 0, 0); return d.getTime(); };

  let fromMs: number, renderEnd: number;
  if (fullDay) {
    // Today / Yesterday → the whole calendar day, midnight to midnight; the
    // hours still to come stay on the frame as empty slots.
    const d = new Date(from); d.setHours(0, 0, 0, 0);
    fromMs = d.getTime();
    renderEnd = fromMs + 24 * HOUR;
  } else {
    // Default frame: the last 8 hours of the window.
    const end = Math.min(new Date(to).getTime(), nowMin);
    fromMs = alignHour(Math.max(new Date(from).getTime(), end - 8 * HOUR));
    renderEnd = end;
  }
  const fetchTo = Math.min(renderEnd, nowMin);
  const fromISO = new Date(fromMs).toISOString();
  const toISO = new Date(fetchTo).toISOString();

  const { data } = useQuery({
    queryKey: ['machine-hourly', code, fromISO, toISO],
    queryFn: () => machineApi.hourly(code, { from: fromISO, to: toISO }),
    enabled: fetchTo > fromMs,
    refetchInterval: 60_000,
    placeholderData: keepPreviousData,
  });

  const bars = useMemo(() => {
    const made = new Map((data?.data.hours || []).map((h) => [new Date(h.t).getTime(), h.made]));
    const out: { t: number; made: number; future: boolean }[] = [];
    for (let b = fromMs; b < renderEnd; b += HOUR) {
      out.push({ t: b, made: made.get(b) || 0, future: b >= nowMin });
    }
    return out;
  }, [data, fromMs, renderEnd, nowMin]);
  const max = Math.max(...bars.map((b) => b.made), perHr || 0, 1);

  const hh2 = (ms: number) => String(new Date(ms).getHours()).padStart(2, '0');
  const slot = (ms: number) => `${hh2(ms)}-${hh2(ms + HOUR)}`;

  if (!data && fetchTo > fromMs) return <div className="py-6 text-center text-sm text-steel">Counting the hours…</div>;
  if (data && data.data.key == null) return <div className="py-6 text-center text-sm text-steel">This machine publishes no production counter — hourly bars need one.</div>;

  return (
    <div className="overflow-x-auto pb-1">
      <div className="relative" style={{ minWidth: Math.max(bars.length * 36, 280) }}>
        {perHr != null && (
          <div
            className="absolute left-0 right-0 border-t-2 border-dashed border-stopped/60 z-10 pointer-events-none"
            style={{ top: `${(1 - perHr / max) * height}px` }}
            title={`Target ${fmtTarget(perHr)}/hr`}
          />
        )}
        <div className="flex items-end gap-1.5" style={{ height }}>
          {bars.map((b) => (
            <div key={b.t} className="flex-1 min-w-[28px] flex flex-col items-center justify-end h-full" title={`${slot(b.t)} · ${b.future ? 'upcoming' : `${b.made} pcs`}`}>
              {b.made > 0 && <span className="data text-[10px] font-bold mb-0.5" style={{ color: perHr != null && b.made >= perHr ? TEAL : AMBER }}>{b.made}</span>}
              <div
                className="w-full rounded-t"
                style={{
                  height: `${(b.made / max) * 100}%`,
                  background: perHr != null && b.made >= perHr ? TEAL : AMBER,
                  minHeight: b.made > 0 ? 3 : 0,
                }}
              />
            </div>
          ))}
        </div>
        <div className="flex gap-1.5 mt-1 border-t border-line pt-1">
          {bars.map((b) => (
            <div key={b.t} className={`flex-1 min-w-[28px] text-center text-[9px] ${b.future ? 'text-steel/40' : 'text-steel'}`}>
              {slot(b.t)}
            </div>
          ))}
        </div>
      </div>
      <div className="flex items-center gap-4 mt-2 text-[10px] text-steel">
        <span className="inline-flex items-center gap-1.5"><span className="w-3 h-2 rounded-sm" style={{ background: TEAL }} /> met the hour's target</span>
        <span className="inline-flex items-center gap-1.5"><span className="w-3 h-2 rounded-sm" style={{ background: AMBER }} /> under target</span>
        {perHr != null && <span className="inline-flex items-center gap-1.5"><span className="w-4 border-t-2 border-dashed border-stopped/60" /> target {fmtTarget(perHr)}/hr</span>}
      </div>
    </div>
  );
}
