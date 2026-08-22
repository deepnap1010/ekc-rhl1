// client/src/components/MachineGroups.tsx
// Machines seen as FAMILIES: all cutting machines together, all SPGs together…
// Each group shows its COMBINED output + time split for the selected window and
// then its machines as cards (three at a time, the rest behind "view all").
//
// Membership is derived from the machine code (lib/machineOrder#groupOf), never
// configured — a machine added tomorrow lands in the right group by itself, and
// an unfamiliar one simply starts its own group.
//
// Window: every group follows the dashboard's date filter, and can be switched
// to its own (today / yesterday / this week / … ) without disturbing the page.
//
// The page opens on the production LINES — the families that hold more than one
// machine (cutting, SPG, bottom milling today). One-off machines wait behind
// "View all machine groups" so fifteen panels don't bury the three that matter.
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, keepPreviousData } from '@tanstack/react-query';
import { ChevronDown, Layers, ArrowRight, Boxes } from 'lucide-react';
import { machineApi } from '../api/endpoints';
import { StatusPill, TimeStat } from './ui';
import { fmtNum, fmtDuration, fmtTime } from '../lib/format';
import { groupMachines } from '../lib/machineOrder';
import { isFurnaceRef } from '../lib/temperature';
import { sumActivity } from '../lib/metrics';
import { resolveRange, DATE_PRESETS, presetLabel, type DatePreset } from '../store/filters';
import type { ShiftTiming } from '../lib/settings';
import type { MachineActivityRow } from '../types/api';

const TEAL = '#0D9488', AMBER = '#D97706', RED = '#DC2626', DEEP_RED = '#991B1B', SLATE = '#94A3B8';

const PREVIEW = 3;   // cards shown before "view all"

interface Props {
  rows: MachineActivityRow[];   // reconstructed activity for the page's window
  windowMs: number;
  windowLabel: string;          // e.g. "Today" — what the page filter currently means
  loading?: boolean;
}

export default function MachineGroups({ rows, windowMs, windowLabel, loading }: Props): JSX.Element {
  const [showAll, setShowAll] = useState(false);
  const groups = groupMachines(rows);

  // Derived, not configured: a family is any kind with more than one machine, so
  // a second CNC lathe promotes that group to the front page by itself.
  const lines = groups.filter((g) => g.machines.length > 1);
  const singles = groups.filter((g) => g.machines.length === 1);
  // Nothing to hide (or nothing but one-offs) → show everything, no button.
  const collapsible = lines.length > 0 && singles.length > 0;
  const visible = collapsible && !showAll ? lines : [...lines, ...singles];

  if (loading && rows.length === 0) {
    return <div className="panel p-10 text-center text-sm text-steel">Reconstructing machine activity…</div>;
  }
  if (groups.length === 0) {
    return (
      <div className="panel p-10 text-center">
        <Layers size={26} className="text-steel/40 mx-auto mb-3" />
        <div className="text-sm text-steel">No machines in scope.</div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {visible.map((g) => (
        <GroupPanel key={g.key} label={g.label} rows={g.machines}
          windowMs={windowMs} windowLabel={windowLabel} />
      ))}

      {/* Hidden groups append BELOW — expanding never reshuffles what's on screen */}
      {collapsible && (
        <button
          onClick={() => setShowAll((v) => !v)}
          className="w-full panel py-3 text-xs font-medium text-accent hover:bg-accent/5 border-dashed transition-colors inline-flex items-center justify-center gap-1.5"
        >
          {showAll
            ? <>Show fewer groups <ChevronDown size={13} className="rotate-180" /></>
            : <>View all machine groups (+{singles.length} more) <ChevronDown size={13} /></>}
        </button>
      )}
    </div>
  );
}

// ── One family ───────────────────────────────────────────────────────────────
function GroupPanel({ label, rows, windowMs, windowLabel }: {
  label: string; rows: MachineActivityRow[]; windowMs: number; windowLabel: string;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  // '' = follow the page filter. An override re-fetches ONLY this group's window.
  const [override, setOverride] = useState<DatePreset | ''>('');

  const ownRange = override
    ? resolveRange({ preset: override, shiftName: '', customFrom: '', customTo: '' }, [] as ShiftTiming[])
    : null;
  const fromISO = ownRange?.from.toISOString();
  const toISO = ownRange?.to.toISOString();
  const { data: ownData, isFetching } = useQuery({
    // Same key shape as the page's own activity query, so a group whose override
    // matches the page window reuses that response instead of re-fetching.
    queryKey: ['activity', fromISO, toISO],
    queryFn: () => machineApi.activity({ from: fromISO as string, to: toISO as string }),
    enabled: !!fromISO && !!toISO,
    refetchInterval: 30_000,
    placeholderData: keepPreviousData,
  });

  // Each response says which window it covers, so we can tell THIS override's data
  // from the previous one still on screen. Rows, window length and label then flip
  // together: gated separately, a group briefly showed the page window's durations
  // divided by the override's window — availability in the thousands of percent.
  const own = !!override && ownData?.meta?.from === fromISO ? ownData : undefined;
  const ownWindowMs = own?.meta?.windowMs ?? null;
  // Own window → the SAME machines, re-read over that window (membership comes
  // from the page's rows, so a machine filter still applies to an override).
  const members = new Set(rows.map((r) => r.code));
  const ownRows = own && ownWindowMs != null ? own.data.filter((r) => members.has(r.code)) : null;

  const shown = ownRows ?? rows;
  const effWindowMs = ownRows ? (ownWindowMs as number) : windowMs;
  const t = sumActivity(shown, effWindowMs);
  const scopeLabel = ownRows && override ? presetLabel(override) : windowLabel;

  const visible = open ? shown : shown.slice(0, PREVIEW);
  const hidden = shown.length - visible.length;

  return (
    <div className="panel p-4">
      {/* Header — click anywhere to open the full machine list of this family */}
      <div className="flex items-start gap-3 flex-wrap">
        <button
          onClick={() => setOpen((v) => !v)}
          className="flex items-center gap-2.5 min-w-0 text-left group/head"
          title={open ? 'Collapse' : `Show all ${shown.length} machines`}
        >
          <span className="w-9 h-9 rounded-xl bg-accent/10 flex items-center justify-center shrink-0">
            <Boxes size={17} className="text-accent" />
          </span>
          <span className="min-w-0">
            <span className="flex items-center gap-1.5">
              <h3 className="font-semibold text-sm text-primary truncate group-hover/head:text-accent transition-colors">{label}</h3>
              <ChevronDown size={14} className={`text-steel transition-transform ${open ? 'rotate-180' : ''}`} />
            </span>
            <span className="block text-[11px] text-steel mt-0.5">
              {t.machines} machine{t.machines === 1 ? '' : 's'} · {t.running} running · {scopeLabel}
              {override && !ownRows ? ' · loading…' : isFetching && override ? ' · updating…' : ''}
            </span>
          </span>
        </button>

        <div className="ml-auto flex items-center gap-2">
          <select
            value={override}
            onChange={(e) => setOverride(e.target.value as DatePreset | '')}
            onClick={(e) => e.stopPropagation()}
            className={`rounded-lg border px-2.5 py-1.5 text-xs outline-none cursor-pointer transition-colors hover:border-accent/40 ${
              override ? 'border-accent/40 bg-accent/5 text-accent font-medium' : 'border-line bg-base text-steel'
            }`}
            title="View this group over its own window"
          >
            <option value="">Page window · {windowLabel}</option>
            {DATE_PRESETS.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
          </select>
        </div>
      </div>

      {/* Group totals — the sum of every machine in the family for this window */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-2 mt-3.5">
        {/* A furnace family makes HEAT, not pieces — its headline figure is the mean
            work-zone temperature over the window, never a piece count. */}
        {isFurnaceRef(label) ? (
          <Total label="Avg Temperature" value={t.avgTemp != null ? `${fmtNum(t.avgTemp)} °C` : '—'}
            sub={t.reportedTemp ? `${t.reportedTemp}/${t.machines} reporting` : 'no temperature signal'}
            color={t.avgTemp != null ? AMBER : SLATE} />
        ) : (
          <Total label="Production" value={t.reportedProduction ? `${fmtNum(t.production)} pcs` : '—'}
            sub={t.reportedProduction ? `${t.reportedProduction}/${t.machines} counters` : 'no counter signal'} color={TEAL} />
        )}
        <Total label="Runtime" value={fmtDuration(t.runningMs)} sub={`${t.availabilityPct}% availability`} color={TEAL} />
        <Total label="Idle" value={fmtDuration(t.idleMs)} sub="connected, no activity" color={t.idleMs ? AMBER : SLATE} />
        <Total label="Stopped" value={fmtDuration(t.stoppedMs)} sub="not operational" color={t.stoppedMs ? RED : SLATE} />
        <Total label="Downtime" value={fmtDuration(t.downtimeMs)}
          sub={`${fmtDuration(t.idleMs)} idle + ${fmtDuration(t.stoppedMs)} stopped`} color={t.downtimeMs ? DEEP_RED : SLATE} />
      </div>

      <SplitBar running={t.runningMs} idle={t.idleMs} stopped={t.stoppedMs} offline={t.offlineMs} />

      {/* Machines — three across; the rest open on demand */}
      <div className="grid sm:grid-cols-2 xl:grid-cols-3 gap-3 mt-3.5">
        {visible.map((r) => <MachineMiniCard key={r.code} row={r} />)}
      </div>

      {(hidden > 0 || open) && (
        <button
          onClick={() => setOpen((v) => !v)}
          className="mt-3 w-full rounded-xl border border-dashed border-line py-2 text-xs font-medium text-steel hover:text-accent hover:border-accent/40 transition-colors"
        >
          {open ? 'Show less' : `View all ${shown.length} machines (+${hidden} more)`}
        </button>
      )}
    </div>
  );
}

// ── Building blocks ──────────────────────────────────────────────────────────
function Total({ label, value, sub, color }: { label: string; value: string; sub?: string; color: string }): JSX.Element {
  return (
    <div className="rounded-xl border border-line bg-base px-3 py-2">
      <div className="label truncate">{label}</div>
      <div className="data text-base font-bold mt-0.5 truncate" style={{ color }}>{value}</div>
      {sub && <div className="text-[10px] text-steel truncate" title={sub}>{sub}</div>}
    </div>
  );
}

// Proportional time split of the whole group — one glance says how the family
// spent the window. Silent when nothing was observed at all.
function SplitBar({ running, idle, stopped, offline }: { running: number; idle: number; stopped: number; offline: number }): JSX.Element | null {
  const total = running + idle + stopped + offline;
  if (!total) return null;
  const seg = [
    { ms: running, color: TEAL, label: 'Runtime' },
    { ms: idle, color: AMBER, label: 'Idle' },
    { ms: stopped, color: RED, label: 'Stopped' },
    { ms: offline, color: SLATE, label: 'Signal lost' },
  ].filter((s) => s.ms > 0);
  return (
    <div className="flex h-1.5 rounded-full overflow-hidden mt-2.5 bg-line">
      {seg.map((s) => (
        <span key={s.label} style={{ width: `${(s.ms / total) * 100}%`, background: s.color }}
          title={`${s.label} · ${fmtDuration(s.ms)}`} />
      ))}
    </div>
  );
}

function MachineMiniCard({ row }: { row: MachineActivityRow }): JSX.Element {
  const downtimeMs = row.idleMs + row.stoppedMs;
  const furnace = isFurnaceRef(row.code);
  return (
    <Link to={`/machines/${row.code}`} className="card p-3.5 flex flex-col transition-all hover:shadow-md hover:border-accent/30 hover:-translate-y-0.5 group">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="data font-bold text-xs text-primary truncate group-hover:text-accent transition-colors">{row.code.toUpperCase()}</div>
          {row.name.toUpperCase() !== row.code.toUpperCase() && (
            <div className="text-[10px] text-steel truncate">{row.name}</div>
          )}
        </div>
        <StatusPill status={row.status} />
      </div>

      {/* Output in the window — the number a supervisor scans for */}
      <div className="mt-2.5 rounded-lg border border-line bg-base px-3 py-2 flex items-end justify-between gap-2">
        <div className="min-w-0">
          <div className="label">{furnace ? 'Temperature' : 'Production'}</div>
          {furnace ? (
            <div className="data text-xl font-bold leading-none mt-0.5" style={{ color: row.avgTemp != null ? AMBER : SLATE }}>
              {row.avgTemp != null ? fmtNum(row.avgTemp) : '—'}
              {row.avgTemp != null && <span className="text-[11px] font-medium text-steel"> °C</span>}
            </div>
          ) : (
            <div className="data text-xl font-bold leading-none mt-0.5" style={{ color: row.production ? TEAL : SLATE }}>
              {row.production != null ? fmtNum(row.production) : '—'}
              {row.production != null && <span className="text-[11px] font-medium text-steel"> pcs</span>}
            </div>
          )}
        </div>
        <div className="text-right shrink-0">
          <div className="text-[10px] text-steel">{row.live ? `${fmtNum(row.readings)} readings` : 'no data'}</div>
          <div className="text-[10px] text-steel/70">{row.lastSeen ? fmtTime(row.lastSeen) : '—'}</div>
        </div>
      </div>

      <div className="grid grid-cols-4 gap-1.5 mt-2.5">
        <TimeStat label="Runtime" ms={row.runningMs} color={TEAL} />
        <TimeStat label="Idle" ms={row.idleMs} color={AMBER} />
        <TimeStat label="Stopped" ms={row.stoppedMs} color={RED} />
        <TimeStat label="Downtime" ms={downtimeMs} color={DEEP_RED} />
      </div>

      <span className="mt-2.5 text-[10px] text-accent/80 font-medium inline-flex items-center gap-0.5 group-hover:text-accent transition-colors">
        Open machine <ArrowRight size={11} className="transition-transform group-hover:translate-x-0.5" />
      </span>
    </Link>
  );
}
