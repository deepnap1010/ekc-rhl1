// client/src/components/machine/MachineEvents.tsx
// Machine History — the EVENT timeline (spec: meaningful operational events,
// not telemetry spam). State sessions (running/idle/stopped/offline, deduped:
// one session per state period, open sessions stay live) and production events
// (counter increments; resets flagged, never faked). Data: /events (+summary),
// written by the same sweep that maintains downtime — the two always agree.
// Events are recorded forward from deployment; earlier periods have none.
import { useState } from 'react';
import { useQuery, keepPreviousData } from '@tanstack/react-query';
import type { LucideIcon } from 'lucide-react';
import { Play, Pause, CircleSlash, Power, Factory, RotateCcw, CalendarClock } from 'lucide-react';
import { eventsApi } from '../../api/endpoints';
import { fmtNum, fmtDuration, fmtTime } from '../../lib/format';
import { prettyKey } from '../../lib/format';
import type { MachineEventRow } from '../../types/api';

const PAGE = 50;
const WINDOWS = [
  { key: '24h', label: '24h', ms: 24 * 3600_000 },
  { key: '7d', label: '7 days', ms: 7 * 24 * 3600_000 },
  { key: '30d', label: '30 days', ms: 30 * 24 * 3600_000 },
];
const KINDS = [
  { value: '', label: 'All events' },
  { value: 'state', label: 'State changes' },
  { value: 'production', label: 'Production' },
];

const STATE_META: Record<string, { icon: LucideIcon; color: string; verb: string }> = {
  running: { icon: Play, color: '#0D9488', verb: 'Started running' },
  idle:    { icon: Pause, color: '#D97706', verb: 'Became idle' },
  stopped: { icon: CircleSlash, color: '#DC2626', verb: 'Stopped' },
  offline: { icon: Power, color: '#94A3B8', verb: 'Went offline' },
};

export default function MachineEvents({ code }: { code: string }): JSX.Element {
  const [win, setWin] = useState('7d');
  const [kind, setKind] = useState('');
  const [page, setPage] = useState(1);

  const winMs = WINDOWS.find((w) => w.key === win)?.ms || WINDOWS[1].ms;
  // Rounded to the minute so query keys stay stable between renders.
  const toMs = Math.floor(Date.now() / 60_000) * 60_000;
  const fromISO = new Date(toMs - winMs).toISOString();
  const toISO = new Date(toMs).toISOString();

  const { data: sum } = useQuery({
    queryKey: ['events-summary', code, win, toMs],
    queryFn: () => eventsApi.summary({ machineId: code, from: fromISO, to: toISO }).then((r) => r.data),
    refetchInterval: 30000,
    placeholderData: keepPreviousData,
  });

  const { data, isLoading } = useQuery({
    queryKey: ['events', code, win, kind, page, toMs],
    queryFn: () => eventsApi.list({
      machineId: code, from: fromISO, to: toISO,
      kind: kind || undefined, page, limit: PAGE,
    }),
    refetchInterval: 30000,
    placeholderData: keepPreviousData,
  });
  const events = data?.data || [];
  const total = data?.meta?.total || 0;
  const pageCount = Math.max(1, Math.ceil(total / PAGE));

  return (
    <div className="space-y-5">
      {/* Summary counters — sessions/pieces, from the same event source as the list */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
        <Counter label="Running sessions" value={fmtNum(sum?.sessions.running || 0)} sub={fmtDuration(sum?.durations.runningMs || 0)} color="#0D9488" />
        <Counter label="Idle periods" value={fmtNum(sum?.sessions.idle || 0)} sub={fmtDuration(sum?.durations.idleMs || 0)} color="#D97706" />
        <Counter label="Stops" value={fmtNum(sum?.sessions.stopped || 0)} sub={fmtDuration(sum?.durations.stoppedMs || 0)} color="#DC2626" />
        <Counter label="Offline periods" value={fmtNum(sum?.sessions.offline || 0)} sub={fmtDuration(sum?.durations.offlineMs || 0)} color="#94A3B8" />
        <Counter label="Production events" value={fmtNum(sum?.production.events || 0)} sub={`${fmtNum(sum?.production.pieces || 0)} pcs`} color="#0D9488" />
        <Counter label="Total events" value={fmtNum(sum?.totalEvents || 0)} sub={WINDOWS.find((w) => w.key === win)?.label} color="#6366F1" />
      </div>

      {/* Filters */}
      <div className="panel p-3 flex items-center gap-2 flex-wrap">
        <div className="flex rounded-xl border border-line overflow-hidden">
          {WINDOWS.map((w) => (
            <button key={w.key} onClick={() => { setWin(w.key); setPage(1); }}
              className={`px-3 py-1.5 text-xs font-medium transition-colors ${win === w.key ? 'bg-accent text-white' : 'bg-base text-steel hover:text-primary'}`}>
              {w.label}
            </button>
          ))}
        </div>
        <select value={kind} onChange={(e) => { setKind(e.target.value); setPage(1); }}
          className="rounded-xl border border-line bg-base px-3 py-1.5 text-sm text-primary outline-none cursor-pointer hover:border-accent/40">
          {KINDS.map((k) => <option key={k.value} value={k.value}>{k.label}</option>)}
        </select>
        <span className="text-xs text-steel ml-auto">{fmtNum(total)} event{total === 1 ? '' : 's'}</span>
      </div>

      {/* Timeline */}
      <div className="panel overflow-hidden">
        {isLoading ? (
          <div className="p-10 text-center text-steel text-sm">Loading events…</div>
        ) : events.length === 0 ? (
          <div className="p-10 text-center text-steel text-sm">
            No events in this window.
            <div className="text-[11px] text-steel/60 mt-1">Events are recorded from state changes and production counts going forward — history before the event engine went live doesn't exist.</div>
          </div>
        ) : (
          <div className="divide-y divide-line">
            {events.map((e) => <EventRow key={e._id} e={e} />)}
          </div>
        )}
      </div>

      {pageCount > 1 && (
        <div className="flex items-center justify-between text-sm">
          <span className="text-steel text-xs">Page {page} of {pageCount}</span>
          <div className="flex items-center gap-2">
            <button disabled={page <= 1} onClick={() => setPage((p) => p - 1)} className="px-3 py-1.5 rounded-lg bg-surface border border-line disabled:opacity-40 hover:bg-base">Prev</button>
            <button disabled={page >= pageCount} onClick={() => setPage((p) => p + 1)} className="px-3 py-1.5 rounded-lg bg-surface border border-line disabled:opacity-40 hover:bg-base">Next</button>
          </div>
        </div>
      )}
    </div>
  );
}

function EventRow({ e }: { e: MachineEventRow }): JSX.Element {
  if (e.kind === 'production') {
    const reset = !!(e.meta as { reset?: boolean } | undefined)?.reset;
    return (
      <div className="flex items-center gap-3 px-4 sm:px-5 py-3">
        <span className="w-8 h-8 rounded-lg flex items-center justify-center shrink-0" style={{ background: 'rgba(13,148,136,0.1)' }}>
          {reset ? <RotateCcw size={15} style={{ color: '#D97706' }} /> : <Factory size={15} style={{ color: '#0D9488' }} />}
        </span>
        <div className="flex-1 min-w-0">
          <div className="text-sm text-primary font-medium">
            {reset ? 'Production counter reset' : `Production +${fmtNum(e.delta || 0)} pcs`}
          </div>
          <div className="text-[11px] text-steel truncate">
            {e.paramKey ? prettyKey(e.paramKey) : 'counter'} · {fmtNum(e.prevValue ?? 0)} → {fmtNum(e.newValue ?? 0)}
          </div>
        </div>
        <span className="data text-xs text-steel shrink-0">{fmtTime(e.startedAt)}</span>
      </div>
    );
  }

  const meta = STATE_META[e.state || 'offline'] || STATE_META.offline;
  const Icon = meta.icon;
  const active = e.endedAt == null;
  const durMs = active ? Date.now() - new Date(e.startedAt).getTime() : (e.durationMs || 0);
  return (
    <div className="flex items-center gap-3 px-4 sm:px-5 py-3">
      <span className="w-8 h-8 rounded-lg flex items-center justify-center shrink-0" style={{ background: `${meta.color}1A` }}>
        <Icon size={15} style={{ color: meta.color }} />
      </span>
      <div className="flex-1 min-w-0">
        <div className="text-sm text-primary font-medium flex items-center gap-2">
          {meta.verb}
          {active && <span className="pill !text-[9px] font-bold" style={{ background: `${meta.color}1A`, color: meta.color }}>ACTIVE</span>}
        </div>
        <div className="text-[11px] text-steel">
          {e.prevState ? `from ${e.prevState} · ` : ''}duration {durMs >= 30_000 ? fmtDuration(durMs) : '<1m'}
        </div>
      </div>
      <div className="text-right shrink-0">
        <div className="data text-xs text-primary">{fmtTime(e.startedAt)}</div>
        {!active && e.endedAt && <div className="data text-[10px] text-steel">→ {fmtTime(e.endedAt)}</div>}
      </div>
    </div>
  );
}

function Counter({ label, value, sub, color }: { label: string; value: string; sub?: string; color: string }): JSX.Element {
  return (
    <div className="card p-3">
      <div className="flex items-center justify-between">
        <span className="label truncate">{label}</span>
        <CalendarClock size={12} style={{ color }} className="shrink-0 opacity-60" />
      </div>
      <div className="data text-lg font-bold mt-1" style={{ color }}>{value}</div>
      {sub && <div className="text-[10px] text-steel mt-0.5">{sub}</div>}
    </div>
  );
}
