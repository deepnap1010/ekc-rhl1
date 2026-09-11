// client/src/components/ProductionHistory.tsx
// The production-count history: every counter advance in the window, with its
// timestamp, size, classification and who said so — and the place to correct
// one. Two exports:
//   · ReclassifyModal — pick the true classification + a reason (admin's list
//     or your own words). Used here and from the History Log page.
//   · ProductionHistoryModal — the list itself, opened from the Dashboard's
//     filter bar. Operators see their machines; admins see the fleet.
// Correcting a piece to a non-counting class (dry cycle, sample…) takes it
// OUT of every production figure — the count is recomputed, never edited.
import { useMemo, useState } from 'react';
import { useQuery, useMutation, useQueryClient, keepPreviousData } from '@tanstack/react-query';
import { ListOrdered, Pencil, Check } from 'lucide-react';
import Modal from './Modal';
import { Spinner } from './ui';
import { productionApi, eventsApi } from '../api/endpoints';
import { useAppConfig } from '../hooks/useAppConfig';
import { useAuthStore } from '../store/auth';
import { toast } from '../store/toast';
import { fmtNum, fmtTime } from '../lib/format';
import { useMachineName } from '../lib/machineName';
import { classColor } from './ProductionClassPopup';
import type { MachineEventRow } from '../types/api';

const OTHER = '__other__';

/** The correction form: classification + a reason, both required. */
export function ReclassifyModal({ e, onClose }: { e: MachineEventRow; onClose: () => void }): JSX.Element {
  const qc = useQueryClient();
  const mName = useMachineName();
  const { prodClass } = useAppConfig();
  const opts = prodClass?.options || [];
  const reasons = prodClass?.reasons || [];
  const [value, setValue] = useState(e.classification || 'OK');
  // Nothing pre-selected: a reason the operator did not choose is not a reason.
  const [pick, setPick] = useState(reasons.length ? '' : OTHER);
  const [custom, setCustom] = useState('');
  const reason = (pick === OTHER ? custom : pick).trim();
  const current = opts.find((o) => o.value === e.classification);
  const next = opts.find((o) => o.value === value);
  const changes = value !== (e.classification || '');

  const mut = useMutation({
    mutationFn: () => eventsApi.editClassification(e._id, value, reason),
    onSuccess: () => {
      // The label moved, and with it whether the piece counts — every
      // production figure on screen is stale until it re-reads (the server
      // drops its own caches on the same write, so these refetches land fresh).
      for (const k of ['events', 'activity', 'machine-activity', 'machine-activity-today', 'machine-hourly',
        'machine-timeline', 'targets-report', 'dia-trace', 'reports', 'production-orders', 'dashboard', 'prodclass']) {
        qc.invalidateQueries({ queryKey: [k] });
      }
      toast.success('Classification corrected');
      onClose();
    },
    onError: (err: unknown) => toast.error(err instanceof Error ? err.message : 'Could not save'),
  });

  return (
    <Modal title="Correct this production" subtitle={`${mName(e.machineId)} · ${fmtTime(e.startedAt)} · counter ${fmtNum(e.prevValue ?? 0)} → ${fmtNum(e.newValue ?? 0)}`}
      icon={Pencil} onClose={onClose} maxW="max-w-md">
      <div className="space-y-4">
        <div>
          <div className="label mb-1.5">What was it really?</div>
          <div className="grid grid-cols-2 gap-2">
            {opts.map((o) => {
              const c = classColor(o.value, opts);
              const on = value === o.value;
              return (
                <button key={o.value} onClick={() => setValue(o.value)}
                  className={`rounded-xl border-2 py-3 px-3 text-sm font-semibold transition-colors ${on ? '' : 'opacity-60 hover:opacity-100'}`}
                  style={{ borderColor: on ? c : `${c}55`, background: `${c}14`, color: c }}>
                  {o.label}{!o.counts && <span className="block text-[10px] font-normal opacity-80">not counted as production</span>}
                </button>
              );
            })}
          </div>
        </div>

        <div>
          <div className="label mb-1.5">Why are you changing it?</div>
          <select value={pick} onChange={(ev) => setPick(ev.target.value)}
            className="w-full border border-line rounded-lg px-3 py-2 text-sm bg-base text-primary">
            {reasons.length > 0 && <option value="">— pick a reason —</option>}
            {reasons.map((r) => <option key={r} value={r}>{r}</option>)}
            <option value={OTHER}>Other — write the reason</option>
          </select>
          {pick === OTHER && (
            <input autoFocus value={custom} onChange={(ev) => setCustom(ev.target.value)} maxLength={200}
              placeholder="Type the reason" className="mt-2 w-full border border-line rounded-lg px-3 py-2 text-sm bg-base text-primary" />
          )}
        </div>

        <div className="flex items-center justify-between gap-3 text-[11px] text-steel">
          <span>
            {current?.label || e.classification || '—'} → <span className="font-semibold text-primary">{next?.label || value}</span>
            {next && !next.counts ? ' · leaves the production count' : next && current && !current.counts ? ' · returns to the production count' : ''}
          </span>
          <button onClick={() => mut.mutate()} disabled={!changes || !reason || mut.isPending}
            className="inline-flex items-center gap-1.5 text-xs font-semibold bg-accent text-white rounded-lg px-3 py-2 disabled:opacity-50">
            <Check size={13} /> {mut.isPending ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </Modal>
  );
}

const SOURCE_LABEL: Record<string, string> = {
  default: 'not answered', timeout: 'popup timed out', operator: 'from the popup', edit: 'corrected',
};

/** The list. `from`/`to` is the page's window; `machineId` narrows to one machine. */
export function ProductionHistoryModal({ from, to, machineId, windowLabel, onClose }: {
  from?: string; to?: string; machineId?: string; windowLabel: string; onClose: () => void;
}): JSX.Element {
  const mName = useMachineName();
  const user = useAuthStore((s) => s.user);
  const can = useAuthStore((s) => s.can);
  const { prodClass } = useAppConfig();
  const opts = prodClass?.options || [];
  const [editing, setEditing] = useState<MachineEventRow | null>(null);
  const [page, setPage] = useState(1);
  const SIZE = 100;

  // The whole window, not a page of it: the number an operator reads is
  // "piece 12 of this shift", and that runs from the shift's FIRST piece —
  // which the newest hundred rows do not contain. Capped at 2,000 rows (ten
  // server pages); a window that large is a report, not a history.
  const CAP = 2000;
  const { data, isLoading, isFetching } = useQuery({
    queryKey: ['events', 'production-history', from, to, machineId || ''],
    queryFn: async () => {
      const all: MachineEventRow[] = [];
      let total = 0;
      for (let p = 1; p <= CAP / 200; p += 1) {
        const r = await productionApi.events({ kind: 'production', from, to, machineId: machineId || undefined, page: p, limit: 200 });
        total = (r.meta as { total?: number } | undefined)?.total || 0;
        all.push(...(r.data || []));
        if ((r.data || []).length < 200) break;
      }
      return { rows: all, total };
    },
    enabled: !!from && !!to,
    refetchInterval: 30_000,
    placeholderData: keepPreviousData,
  });
  const allRows = (data?.rows || []).filter((r) => !(r.meta as { reset?: boolean } | undefined)?.reset);
  const capped = (data?.total || 0) > CAP;
  // Piece number within the window, per machine, counting only what counts —
  // "11 → 12" beside a +1, the same reading the popup gives. Oldest first, so
  // the first piece of the shift is #1.
  const pieceNo = useMemo(() => {
    const m = new Map<string, { before: number; after: number }>();
    const running = new Map<string, number>();
    for (const r of [...allRows].reverse()) {
      const key = r.machineId.toUpperCase();
      const o = opts.find((x) => x.value === r.classification);
      const implausible = !!(r.meta as { implausible?: boolean } | undefined)?.implausible;
      const counts = !implausible && !(o && !o.counts);
      const before = running.get(key) || 0;
      const after = counts ? before + (r.delta || 0) : before;
      running.set(key, after);
      m.set(r._id, { before, after });
    }
    return m;
  }, [allRows, opts]);
  const pages = Math.max(1, Math.ceil(allRows.length / SIZE));
  const rows = allRows.slice((page - 1) * SIZE, page * SIZE);
  const total = allRows.length;

  // Who may correct which row: history editors any row; an operator their own.
  const editor = can('history', 'update');
  const mine = useMemo(() => new Set((user?.assignedMachines || []).map((m) => m.toUpperCase())), [user]);
  const mayEdit = (r: MachineEventRow): boolean => editor || (can('production', 'view') && mine.has(r.machineId.toUpperCase()));

  // The window's totals, in the operator's terms: counted vs classified
  // away. Climbs the engine refused (meta.implausible) are neither.
  const tally = useMemo(() => {
    let counted = 0, away = 0;
    for (const r of allRows) {
      if ((r.meta as { implausible?: boolean } | undefined)?.implausible) continue;
      const o = opts.find((x) => x.value === r.classification);
      if (o && !o.counts) away += r.delta || 0; else counted += r.delta || 0;
    }
    return { counted, away };
  }, [allRows, opts]);

  return (
    <Modal title="Production history" subtitle={`${windowLabel} · every counter advance, newest first`} icon={ListOrdered} onClose={onClose} maxW="max-w-4xl">
      <div className="flex flex-wrap items-center gap-2 mb-3 text-xs text-steel">
        <span className="pill bg-running/10 text-running font-semibold">{fmtNum(tally.counted)} counted</span>
        {tally.away > 0 && <span className="pill bg-line text-steel font-semibold">{fmtNum(tally.away)} classified away</span>}
        <span className="ml-auto">{total} event{total === 1 ? '' : 's'}{capped ? ' · latest 2,000 shown' : ''}{pages > 1 ? ` · page ${page}/${pages}` : ''}{isFetching && !isLoading ? ' · updating…' : ''}</span>
      </div>

      {isLoading ? (
        <div className="p-10"><Spinner label="Loading production history" /></div>
      ) : rows.length === 0 ? (
        <div className="p-10 text-center text-steel text-sm">No production in this window.</div>
      ) : (
        <div className="panel overflow-x-auto">
          <table className="w-full text-sm whitespace-nowrap">
            <thead className="bg-base">
              <tr className="text-steel">
                <th className="text-left label px-3 py-2">Time</th>
                {!machineId && <th className="text-left label px-3 py-2">Machine</th>}
                <th className="text-right label px-3 py-2">Pieces</th>
                <th className="text-right label px-3 py-2" title="Piece number within this window — the register is in small print">Count</th>
                <th className="text-left label px-3 py-2">Classification</th>
                <th className="text-left label px-3 py-2">By</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const o = opts.find((x) => x.value === r.classification);
                const c = classColor(r.classification, opts);
                const implausible = !!(r.meta as { implausible?: boolean } | undefined)?.implausible;
                const who = r.classSource === 'operator' || r.classSource === 'edit' ? r.classifiedBy?.name : r.operatorName;
                return (
                  <tr key={r._id} className={`border-t border-line ${o && !o.counts ? 'opacity-70' : ''}`}>
                    <td className="px-3 py-2 data text-xs">{fmtTime(r.startedAt)}</td>
                    {!machineId && <td className="px-3 py-2 data text-xs font-semibold text-primary">{mName(r.machineId)}</td>}
                    <td className="px-3 py-2 data text-xs text-right font-semibold" style={{ color: implausible || (o && !o.counts) ? '#94A3B8' : '#0D9488' }}
                      title={implausible ? 'A jump the machine cannot physically have made in the time — never counted' : undefined}>
                      {implausible ? 'not counted' : o && !o.counts ? '—' : `+${fmtNum(r.delta || 0)}`}
                    </td>
                    <td className="px-3 py-2 data text-right">
                      {(() => {
                        const n = pieceNo.get(r._id);
                        const moved = !!n && n.after !== n.before;
                        return (
                          <>
                            <div className={`text-sm font-semibold tabular-nums ${moved ? 'text-primary' : 'text-steel/60'}`}>
                              {n ? (moved ? `${fmtNum(n.before)} → ${fmtNum(n.after)}` : fmtNum(n.after)) : '—'}
                            </div>
                            <div className="text-[10px] text-steel/70">counter {fmtNum(r.prevValue ?? 0)} → {fmtNum(r.newValue ?? 0)}</div>
                          </>
                        );
                      })()}
                    </td>
                    <td className="px-3 py-2">
                      <span className="pill font-semibold" style={{ background: `${c}1A`, color: c }}>{o?.label || r.classification || '—'}</span>
                    </td>
                    <td className="px-3 py-2 text-xs text-steel" title={r.editReason ? `Reason: ${r.editReason}` : undefined}>
                      {SOURCE_LABEL[r.classSource || ''] || 'before classification existed'}{who ? ` · ${who}` : ''}
                      {r.editReason && <span className="block text-[10px] italic truncate max-w-[220px]">“{r.editReason}”</span>}
                    </td>
                    <td className="px-3 py-2 text-right">
                      {mayEdit(r) && (
                        <button onClick={() => setEditing(r)} title="Correct this classification"
                          className="inline-flex items-center gap-1 text-xs text-accent border border-accent/30 rounded-lg px-2 py-1 hover:bg-accent/10">
                          <Pencil size={12} /> Edit
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {pages > 1 && (
        <div className="flex items-center justify-end gap-2 mt-3 text-xs text-steel">
          <button disabled={page <= 1} onClick={() => setPage((p) => p - 1)} className="border border-line rounded-lg px-2 py-1 disabled:opacity-40">Newer</button>
          <span>page {page} of {pages}</span>
          <button disabled={page >= pages} onClick={() => setPage((p) => p + 1)} className="border border-line rounded-lg px-2 py-1 disabled:opacity-40">Older</button>
        </div>
      )}

      {editing && <ReclassifyModal e={editing} onClose={() => setEditing(null)} />}
    </Modal>
  );
}
