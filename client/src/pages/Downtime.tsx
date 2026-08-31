// client/src/pages/Downtime.tsx
import { useEffect, useMemo, useState } from 'react';
import { useQuery, useMutation, useQueryClient, keepPreviousData } from '@tanstack/react-query';
import { Clock, AlertTriangle, Activity, Pencil, Check } from 'lucide-react';
import { downtimeApi, machineApi } from '../api/endpoints';
import { useAuthStore } from '../store/auth';
import { StatCard, Spinner } from '../components/ui';
import PageHeader from '../components/PageHeader';
import RangeFilter from '../components/RangeFilter';
import Pager, { DEFAULT_PAGE_SIZE } from '../components/Pager';
import { useRangeFilter } from '../hooks/useRangeFilter';
import { presetLabel } from '../store/filters';
import { fmtDuration, fmtTime, fmtNum, prettyType } from '../lib/format';
import type { ApiMeta, DowntimeEvent } from '../types/api';
import { useMachineName, useMachineTitle } from '../lib/machineName';

const TYPES = ['all', 'idle', 'stopped', 'offline'];
const STATUS_OPTS = ['all', 'open', 'closed'];
const REVIEW_OPTS = ['all', 'unacknowledged', 'acknowledged'];
// Bounding every query by a time window keeps it index-backed at production scale.

export default function Downtime() {
  const mName = useMachineName();
  const mTitle = useMachineTitle();
  const qc = useQueryClient();
  const user = useAuthStore((s) => s.user);
  const [type, setType] = useState('all');
  const [status, setStatus] = useState('all');
  const [review, setReview] = useState('all');
  const [page, setPage] = useState(1);
  const [size, setSize] = useState(DEFAULT_PAGE_SIZE);
  const [reasonModal, setReasonModal] = useState<DowntimeEvent | null>(null);
  // The shared window control — the same presets and the same custom date+time
  // popup as everywhere else, instead of this page's own 7D/30D/90D buttons.
  const win = useRangeFilter('month');
  const [machineId, setMachineId] = useState('');

  // Machine selector options — the real machine dataset.
  const { data: machineList } = useQuery({
    queryKey: ['machines', 'selector'],
    queryFn: () => machineApi.list({ limit: 200, sort: 'name' }).then((r) => r.data),
    staleTime: 60_000,
  });

  const from = win.fromISO;
  const to = win.toISO;
  // A half-filled custom range must NOT silently run an unbounded all-time query.
  const customReady = win.value.preset !== 'custom' || (!!from && !!to);
  const winLabel = win.value.preset === 'custom'
    ? (customReady ? 'custom range' : 'pick start & end')
    : presetLabel(win.value.preset).toLowerCase();

  const ackMut = useMutation({
    mutationFn: ({ id, acknowledged }: { id: string; acknowledged: boolean }) =>
      downtimeApi.acknowledge(id, { acknowledged, acknowledgedBy: user?.name || 'Supervisor' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['downtime'] }),
  });

  const { data: summary } = useQuery({
    queryKey: ['downtime', 'summary', win, machineId, from, to],
    queryFn: () => downtimeApi.summary({ from, to, machineId: machineId || undefined }).then((r) => r.data),
    refetchInterval: 30000,
    placeholderData: keepPreviousData,
    enabled: customReady,
  });

  const listPage = (p: number) => ({
    queryKey: ['downtime', 'list', win, machineId, from, to, type, status, review, size, p],
    queryFn: () => downtimeApi.list({
      from,
      to,
      machineId: machineId || undefined,
      type: type !== 'all' ? type : undefined,
      status: status !== 'all' ? status : undefined,
      acknowledged: review === 'unacknowledged' ? 'false' : review === 'acknowledged' ? 'true' : undefined,
      page: p,
      limit: size,
    }),
  });
  const { data, isLoading, isFetching } = useQuery({
    ...listPage(page),
    refetchInterval: 30000,
    placeholderData: keepPreviousData,
    enabled: customReady,
  });

  const events = data?.data || [];
  const meta = data?.meta ?? ({} as ApiMeta);
  const pages = meta.pages || 1;

  // Warm the next page while this one is on screen.
  useEffect(() => {
    if (customReady && page < pages) qc.prefetchQuery({ ...listPage(page + 1), staleTime: 30_000 });
  }, [customReady, page, pages, size, win, machineId, from, to, type, status, review]);

  // Filter chips reflect the states actually present in the window (incl. 'offline').
  const typeOpts = useMemo(() => {
    const seen = (summary?.byType || []).map((t) => t.type).filter(Boolean);
    return seen.length ? ['all', ...seen] : TYPES;
  }, [summary]);

  // If a machine/range change removes the selected type's chip, snap back to
  // "all" — otherwise an invisible filter keeps the table empty.
  useEffect(() => {
    if (type !== 'all' && !typeOpts.includes(type)) { setType('all'); setPage(1); }
  }, [typeOpts, type]);

  return (
    <div>
      <PageHeader
        title="Downtime" subtitle="Idle, stopped & offline event log"
      />

      <div className="px-4 sm:px-6 pb-8 space-y-5">
        {/* Summary cards */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          <StatCard label="Total Events" value={fmtNum(summary?.totalEvents || 0)} sub={winLabel} accent="#64748B" icon={Clock} />
          <StatCard label="Total Downtime" value={fmtDuration(summary?.totalMs || 0)} sub="Accumulated loss" accent="#F0B429" icon={Activity} />
          <StatCard label="Open Events" value={summary?.openEvents || 0} sub="Currently down" accent="#F2545B" icon={AlertTriangle} />
          <StatCard label="Unacknowledged" value={summary?.unacknowledged || 0} sub="Need review" accent="#F2545B" icon={AlertTriangle} />
        </div>

        {/* Worst machines */}
        {((summary?.worstMachines?.length ?? 0) > 0) && (
          <div className="panel p-5">
            <h2 className="font-semibold text-sm mb-3">Top 5 — Most Downtime</h2>
            <div className="grid md:grid-cols-5 gap-3">
              {summary!.worstMachines.map((m) => (
                <div key={m._id} className="card px-3 py-2.5 text-center">
                  <div className="data text-sm font-bold text-idle">{fmtDuration(m.totalMs)}</div>
                  <div className="text-[10px] text-steel mt-0.5 truncate" title={mTitle(m._id)}>{mName(m._id)}</div>
                  <div className="text-[10px] text-steel/60">{m.events} events</div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Filters */}
        <div className="panel p-3 flex flex-wrap gap-3 items-center">
          <select
            value={machineId}
            onChange={(e) => { setMachineId(e.target.value); setPage(1); }}
            className={`rounded-xl border px-3 py-2 text-sm outline-none cursor-pointer transition-colors hover:border-accent/40 max-w-[230px] ${machineId ? 'border-accent/40 bg-accent/5 text-accent font-medium' : 'border-line bg-base text-primary'}`}
            title="Scope downtime to one machine"
          >
            <option value="">All Machines</option>
            {(machineList || []).map((m) => {
              const c = m.code || m.machineId || m._id;
              return <option key={c} value={c}>{mName(c)}{m.type ? ` · ${prettyType(m.type)}` : ''}</option>;
            })}
          </select>
          <RangeFilter value={win.value} onChange={(v) => { win.setValue(v); setPage(1); }} range={win.range}
            title="Which period this log covers" />
          <FilterGroup label="Type" value={type} opts={typeOpts} onChange={(v) => { setType(v); setPage(1); }} />
          <FilterGroup label="Status" value={status} opts={STATUS_OPTS} onChange={(v) => { setStatus(v); setPage(1); }} />
          <FilterGroup label="Review" value={review} opts={REVIEW_OPTS} onChange={(v) => { setReview(v); setPage(1); }} />
        </div>

        {/* Events table */}
        {isLoading ? <Spinner /> : (
          <>
            <div className={`panel overflow-hidden ${isFetching ? 'opacity-70 transition-opacity' : ''}`}>
              <table className="w-full text-sm">
                <thead className="bg-base">
                  <tr className="text-steel">
                    <th className="text-left label px-4 py-3">Machine</th>
                    <th className="text-left label px-4 py-3">Type</th>
                    <th className="text-left label px-4 py-3">Started</th>
                    <th className="text-left label px-4 py-3">Ended</th>
                    <th className="text-left label px-4 py-3">Duration</th>
                    <th className="text-left label px-4 py-3">Reason</th>
                    <th className="text-left label px-4 py-3">Acknowledge</th>
                  </tr>
                </thead>
                <tbody>
                  {events.length === 0 ? (
                    <tr>
                      <td colSpan={7} className="text-center text-steel py-10">No downtime events found</td>
                    </tr>
                  ) : events.map((e) => (
                    <tr key={e._id} className="border-t border-line hover:bg-white/5">
                      <td className="px-4 py-3 data font-medium" title={mTitle(e.machineId)}>{mName(e.machineId)}</td>
                      <td className="px-4 py-3">
                        <span className={`pill ${e.type === 'stopped' ? 'bg-stopped/10 text-stopped' : e.type === 'offline' ? 'bg-steel/10 text-steel' : 'bg-idle/10 text-idle'}`}>
                          <span className={`w-1.5 h-1.5 rounded-full ${e.type === 'stopped' ? 'bg-stopped' : e.type === 'offline' ? 'bg-steel' : 'bg-idle'}`} />
                          {e.type}
                        </span>
                      </td>
                      <td className="px-4 py-3 data text-xs">{fmtTime(e.startedAt)}</td>
                      <td className="px-4 py-3 data text-xs">
                        {e.endedAt ? fmtTime(e.endedAt) : (
                          <span className="text-stopped text-[11px] font-medium">● Open</span>
                        )}
                      </td>
                      <td className="px-4 py-3 data text-xs text-idle">
                        {e.durationMs ? fmtDuration(e.durationMs) : (e.endedAt ? '—' : 'Ongoing')}
                      </td>
                      <td className="px-4 py-3">
                        {e.reason ? (
                          <button
                            onClick={() => setReasonModal(e)}
                            className="group/r text-left"
                            title="Click to edit reason"
                          >
                            <span className="inline-flex items-center gap-1.5 text-xs text-steel group-hover/r:text-accent">
                              {e.reason}
                              <Pencil size={11} className="shrink-0 opacity-0 transition-opacity group-hover/r:opacity-100" />
                            </span>
                            {e.reportedBy && <span className="block text-[10px] text-steel/50">— {e.reportedBy}</span>}
                          </button>
                        ) : (
                          <button
                            onClick={() => setReasonModal(e)}
                            className="text-xs text-accent hover:underline"
                          >
                            Add reason
                          </button>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        {e.acknowledged ? (
                          <button
                            onClick={() => ackMut.mutate({ id: e._id, acknowledged: false })}
                            className="inline-flex items-center gap-1.5 text-xs text-accent hover:text-accent/80"
                            title={`Acknowledged by ${e.acknowledgedBy || '—'}${e.acknowledgedAt ? ' · ' + fmtTime(e.acknowledgedAt) : ''} — click to undo`}
                          >
                            <Check size={13} className="shrink-0" />
                            <span className="truncate max-w-[120px]">{e.acknowledgedBy || 'Acknowledged'}</span>
                          </button>
                        ) : (
                          <button
                            onClick={() => ackMut.mutate({ id: e._id, acknowledged: true })}
                            disabled={ackMut.isPending}
                            className="px-2.5 py-1 rounded-lg border border-line text-xs text-steel hover:border-accent hover:text-accent disabled:opacity-50"
                          >
                            Acknowledge
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Pagination */}
            {meta.total > 0 && (
              <Pager page={page} size={size} onPage={setPage} onSize={setSize}
                total={meta.total} loading={isFetching && !isLoading} noun="events" />
            )}
          </>
        )}
      </div>

      {/* Reason modal */}
      {reasonModal && (
        <ReasonModal event={reasonModal} onClose={() => setReasonModal(null)} onSaved={() => {
          setReasonModal(null);
          qc.invalidateQueries({ queryKey: ['downtime'] });
        }} />
      )}
    </div>
  );
}

interface FilterGroupProps {
  label: string;
  value: string;
  opts: string[];
  onChange: (value: string) => void;
}

function FilterGroup({ label, value, opts, onChange }: FilterGroupProps) {
  return (
    <div className="flex items-center gap-1">
      <span className="label mr-1">{label}:</span>
      {opts.map((o) => (
        <button
          key={o}
          onClick={() => onChange(o)}
          className={`px-2.5 py-1.5 rounded-lg text-xs capitalize transition-colors ${value === o ? 'bg-accent/15 text-accent' : 'text-steel hover:bg-white/5'}`}
        >
          {o}
        </button>
      ))}
    </div>
  );
}

interface ReasonModalProps {
  event: DowntimeEvent;
  onClose: () => void;
  onSaved: () => void;
}

function ReasonModal({ event, onClose, onSaved }: ReasonModalProps) {
  const mName = useMachineName();
  const [reason, setReason] = useState(event.reason || '');
  const user = useAuthStore((s) => s.user);
  const mut = useMutation({
    mutationFn: () => downtimeApi.updateReason(event._id, { reason, reportedBy: user?.name || 'Operator' }),
    onSuccess: onSaved,
  });

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 backdrop-blur-sm" onClick={onClose}>
      <div className="card p-6 w-full max-w-sm mx-4" onClick={(e) => e.stopPropagation()}>
        <h3 className="font-semibold mb-1">{event.reason ? 'Edit' : 'Log'} Downtime Reason</h3>
        <p className="text-xs text-steel mb-4">{mName(event.machineId)} — {event.type}</p>
        <textarea
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="e.g. Planned maintenance, material shortage, operator break…"
          rows={3}
          className="w-full bg-base border border-line rounded-lg px-3 py-2 text-sm outline-none focus:border-accent resize-none"
        />
        <div className="flex gap-2 mt-4">
          <button onClick={onClose} className="flex-1 py-2 rounded-lg border border-line text-sm text-steel hover:bg-white/5">Cancel</button>
          <button
            onClick={() => mut.mutate()}
            disabled={mut.isPending || !reason.trim()}
            className="flex-1 py-2 rounded-lg bg-accent text-base text-sm font-medium disabled:opacity-60"
          >
            {mut.isPending ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}
