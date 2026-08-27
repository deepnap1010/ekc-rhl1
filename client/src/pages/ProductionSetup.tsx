// client/src/pages/ProductionSetup.tsx — Production Targets configuration.
// Supervisors define DIA products (capacity + dimensions) and their stages,
// each with a processing time per unit. Targets are DERIVED from those times
// (60 min ÷ 3 min = 20/hr) — nobody ever types a target. Assigning a DIA to a
// machine happens on the machine itself (header chip / Configure tab); this
// page is the catalogue.
import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus, Pencil, Target, X, ClipboardList, Coffee } from 'lucide-react';
import { productionApi } from '../api/endpoints';
import { Spinner } from '../components/ui';
import PageHeader from '../components/PageHeader';
import Modal from '../components/Modal';
import { useAuthStore } from '../store/auth';
import { toast } from '../store/toast';
import { fmtTarget, fmtProcessing, hourlyRate, minPerPcToSec, secToMinPerPc } from '../lib/targets';
import Pager, { DEFAULT_PAGE_SIZE } from '../components/Pager';
import { fmtTime } from '../lib/format';
import { useAppConfig } from '../hooks/useAppConfig';
import type { DiaConfig, AuditRow, BreakWindow } from '../types/api';

export default function ProductionSetup(): JSX.Element {
  const qc = useQueryClient();
  const can = useAuthStore((s) => s.can);
  const [editing, setEditing] = useState<DiaConfig | 'new' | null>(null);

  const { data: dias, isLoading } = useQuery({
    queryKey: ['dia-configs'],
    queryFn: () => productionApi.dia().then((r) => r.data),
  });

  const activeMut = useMutation({
    mutationFn: ({ id, active }: { id: string; active: boolean }) => productionApi.setDiaActive(id, active),
    onSuccess: (_r, v) => { qc.invalidateQueries({ queryKey: ['dia-configs'] }); toast.success(v.active ? 'DIA reactivated' : 'DIA deactivated'); },
    onError: (e: unknown) => toast.error(e instanceof Error ? e.message : 'Could not update'),
  });

  return (
    <div>
      <PageHeader
        title="Production Targets"
        subtitle="DIA products, stages & processing times — targets derive from these"
        right={can('production', 'create') ? (
          <button onClick={() => setEditing('new')}
            className="flex items-center gap-1.5 bg-accent text-white text-sm font-medium px-3.5 py-2 rounded-lg hover:opacity-90">
            <Plus size={15} /> New DIA
          </button>
        ) : undefined}
      />

      <div className="px-4 sm:px-6 py-6">
        {isLoading ? <Spinner /> : !(dias || []).length ? (
          <div className="panel p-10 text-center">
            <Target size={28} className="mx-auto text-steel mb-3" />
            <p className="text-sm text-steel max-w-md mx-auto">
              No DIA configured yet. Create one — e.g. <span className="data">40L · 316 × 40</span> with a
              Cutting stage at 3 min/unit — and the system derives its targets (20/hour) automatically.
            </p>
          </div>
        ) : (
          <div className="grid md:grid-cols-2 xl:grid-cols-3 gap-4">
            {(dias || []).map((d) => (
              <div key={d._id} className={`panel p-5 flex flex-col ${d.active ? '' : 'opacity-60'}`}>
                <div className="flex items-start justify-between gap-2 mb-1">
                  <div className="min-w-0">
                    <h3 className="font-semibold text-primary truncate">{d.name}</h3>
                    <p className="text-xs text-steel">{[d.capacity, d.dims].filter(Boolean).join(' · ') || '—'}</p>
                  </div>
                  <span className={`pill !text-[10px] shrink-0 ${d.active ? 'bg-accent/10 text-accent' : 'bg-line text-steel'}`}>
                    {d.active ? 'Active' : 'Inactive'}
                  </span>
                </div>
                <div className="mt-3 space-y-1.5 flex-1">
                  {d.stages.map((s) => (
                    <div key={s.key} className={`flex items-baseline justify-between gap-2 text-xs ${s.active ? '' : 'line-through text-steel/60'}`}>
                      <span className="truncate">{s.name}</span>
                      <span className="data text-steel shrink-0">
                        {fmtProcessing(s.processingSec)}/unit
                        <span className="text-accent font-semibold"> → {fmtTarget(hourlyRate(s.processingSec))}/hr</span>
                      </span>
                    </div>
                  ))}
                </div>
                <div className="mt-4 pt-3 border-t border-line flex items-center justify-between text-xs">
                  <span className="text-steel">{d.usedOn ? `Running on ${d.usedOn} machine${d.usedOn === 1 ? '' : 's'}` : 'Not assigned'}</span>
                  <span className="flex gap-2">
                    {can('production', 'delete') && (
                      <button onClick={() => activeMut.mutate({ id: d._id, active: !d.active })}
                        className="text-steel hover:text-primary">{d.active ? 'Deactivate' : 'Reactivate'}</button>
                    )}
                    {can('production', 'update') && (
                      <button onClick={() => setEditing(d)} className="flex items-center gap-1 text-accent hover:underline">
                        <Pencil size={11} /> Edit
                      </button>
                    )}
                  </span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <OrdersSection dias={dias || []} />

      {can('production', 'update') && <BreaksSection />}

      {can('production', 'admin') && <AuditTrail />}

      {editing && (
        <DiaModal
          dia={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); qc.invalidateQueries({ queryKey: ['dia-configs'] }); qc.invalidateQueries({ queryKey: ['assignments'] }); }}
        />
      )}
    </div>
  );
}

// ── Orders — make N pieces of one DIA; progress is COUNTED, never typed ──────
function OrdersSection({ dias }: { dias: DiaConfig[] }): JSX.Element | null {
  const qc = useQueryClient();
  const can = useAuthStore((s) => s.can);
  const [creating, setCreating] = useState(false);
  const [orderNo, setOrderNo] = useState('');
  const [diaId, setDiaId] = useState('');
  const [qty, setQty] = useState('');

  const { data: orders } = useQuery({
    queryKey: ['production-orders'],
    queryFn: () => productionApi.orders().then((r) => r.data),
    refetchInterval: 60_000,
    retry: false,
  });

  const refresh = () => qc.invalidateQueries({ queryKey: ['production-orders'] });
  const createMut = useMutation({
    mutationFn: () => productionApi.createOrder({ orderNo, diaId, quantity: Number(qty) }),
    onSuccess: () => { toast.success(`Order ${orderNo} opened`); setCreating(false); setOrderNo(''); setDiaId(''); setQty(''); refresh(); },
    onError: (e: unknown) => toast.error(e instanceof Error ? e.message : 'Could not create order'),
  });
  const statusMut = useMutation({
    mutationFn: ({ id, status }: { id: string; status: 'open' | 'done' | 'cancelled' }) => productionApi.updateOrder(id, status),
    onSuccess: refresh,
    onError: (e: unknown) => toast.error(e instanceof Error ? e.message : 'Could not update order'),
  });

  if (!(orders || []).length && !can('production', 'create')) return null;
  return (
    <div className="px-4 sm:px-6 pb-2 space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="font-semibold text-sm text-primary flex items-center gap-1.5"><ClipboardList size={15} className="text-accent" /> Orders</h2>
        {can('production', 'create') && (
          <button onClick={() => setCreating(true)} className="flex items-center gap-1 text-xs text-accent hover:underline"><Plus size={12} /> New order</button>
        )}
      </div>
      {!(orders || []).length ? (
        <p className="text-xs text-steel">No orders yet. An order tracks counted pieces of one DIA against a quantity — progress comes from the machines, never from typing.</p>
      ) : (
        <div className="grid md:grid-cols-2 xl:grid-cols-3 gap-4">
          {(orders || []).map((o) => {
            const p = o.quantity > 0 ? Math.min((o.produced / o.quantity) * 100, 100) : 0;
            const donePct = o.quantity > 0 ? Math.round((o.produced / o.quantity) * 1000) / 10 : 0;
            return (
              <div key={o._id} className={`panel p-4 ${o.status !== 'open' ? 'opacity-60' : ''}`}>
                <div className="flex items-center justify-between gap-2 mb-1">
                  <span className="data font-bold text-sm text-primary truncate">{o.orderNo}</span>
                  <span className={`pill !text-[10px] shrink-0 ${
                    o.status === 'open' ? 'bg-accent/10 text-accent' : o.status === 'done' ? 'bg-line text-steel' : 'bg-stopped/10 text-stopped'
                  }`}>{o.status}</span>
                </div>
                <div className="text-xs text-steel mb-2">{o.diaName}</div>
                <div className="flex items-baseline gap-1.5">
                  <span className="data text-xl font-bold text-primary">{fmtNumLocal(o.produced)}</span>
                  <span className="text-steel text-xs">of</span>
                  <span className="data text-xl font-bold text-accent">{fmtNumLocal(o.quantity)}</span>
                  <span className="data text-xs font-semibold ml-auto" style={{ color: donePct >= 100 ? '#0D9488' : '#64748B' }}>{donePct}%</span>
                </div>
                <div className="h-1.5 bg-line rounded-full overflow-hidden mt-2">
                  <div className="h-full rounded-full bg-accent" style={{ width: `${p}%` }} />
                </div>
                {can('production', 'update') && o.status === 'open' && (
                  <div className="mt-3 pt-2 border-t border-line flex gap-3 text-xs">
                    <button onClick={() => statusMut.mutate({ id: o._id, status: 'done' })} className="text-accent hover:underline">Mark done</button>
                    <button onClick={() => statusMut.mutate({ id: o._id, status: 'cancelled' })} className="text-steel hover:text-stopped">Cancel</button>
                  </div>
                )}
                {can('production', 'update') && o.status !== 'open' && (
                  <div className="mt-3 pt-2 border-t border-line text-xs">
                    <button onClick={() => statusMut.mutate({ id: o._id, status: 'open' })} className="text-steel hover:text-accent">Reopen</button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {creating && (
        <Modal title="New order" subtitle="Progress counts pieces made from the moment it opens" icon={ClipboardList} onClose={() => setCreating(false)} maxW="max-w-sm">
          <div className="space-y-3">
            <Field label="Order number" value={orderNo} onChange={setOrderNo} placeholder="ORD-1001" />
            <div>
              <div className="label mb-1.5">DIA</div>
              <select value={diaId} onChange={(e) => setDiaId(e.target.value)}
                className="w-full bg-base border border-line rounded-lg px-3 py-2 text-sm outline-none focus:border-accent">
                <option value="">Select…</option>
                {dias.filter((d) => d.active).map((d) => <option key={d._id} value={d._id}>{d.name}{d.dims ? ` · ${d.dims}` : ''}</option>)}
              </select>
            </div>
            <Field label="Quantity (pieces)" value={qty} onChange={(v) => setQty(v.replace(/\D/g, ''))} placeholder="500" />
            <div className="flex justify-end gap-2 pt-1">
              <button onClick={() => setCreating(false)} className="px-3.5 py-2 rounded-lg border border-line text-sm text-steel hover:bg-base">Cancel</button>
              <button onClick={() => createMut.mutate()} disabled={!orderNo.trim() || !diaId || !Number(qty) || createMut.isPending}
                className="px-3.5 py-2 rounded-lg bg-accent text-white text-sm font-medium disabled:opacity-50">
                {createMut.isPending ? 'Opening…' : 'Open order'}
              </button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}

const fmtNumLocal = (n: number): string => new Intl.NumberFormat('en-IN').format(n);

// ── Break schedule — planned daily pauses, excluded from every target ────────
function BreaksSection(): JSX.Element {
  const qc = useQueryClient();
  const { breaks: saved } = useAppConfig();
  const [draft, setDraft] = useState<BreakWindow[] | null>(null);   // null = mirror server
  const rows = draft ?? saved;

  const saveMut = useMutation({
    mutationFn: (b: BreakWindow[]) => productionApi.setBreaks(b),
    onSuccess: () => { toast.success('Break schedule saved — targets now exclude these windows'); setDraft(null); qc.invalidateQueries({ queryKey: ['app-config'] }); qc.invalidateQueries({ queryKey: ['targets-report'] }); },
    onError: (e: unknown) => toast.error(e instanceof Error ? e.message : 'Could not save breaks'),
  });
  const patch = (i: number, p: Partial<BreakWindow>) =>
    setDraft((rows.map((b, k) => (k === i ? { ...b, ...p } : b))));
  const valid = rows.every((b) => b.name.trim() && /^\d{2}:\d{2}$/.test(b.start) && /^\d{2}:\d{2}$/.test(b.end));

  return (
    <div className="px-4 sm:px-6 pb-2 space-y-3">
      <h2 className="font-semibold text-sm text-primary flex items-center gap-1.5"><Coffee size={15} className="text-accent" /> Break schedule</h2>
      <div className="panel p-4 space-y-2">
        <p className="text-xs text-steel">Daily planned pauses (plant clock). Targets exclude these windows everywhere — lunch never reads as "behind target".</p>
        {rows.map((b, i) => (
          <div key={i} className="flex items-center gap-2 flex-wrap">
            <input value={b.name} onChange={(e) => patch(i, { name: e.target.value })} placeholder="Lunch"
              className="flex-1 min-w-[120px] bg-base border border-line rounded-lg px-3 py-2 text-sm outline-none focus:border-accent" />
            <input type="time" value={b.start} onChange={(e) => patch(i, { start: e.target.value })}
              className="bg-base border border-line rounded-lg px-2 py-1.5 text-sm outline-none focus:border-accent" />
            <span className="text-steel text-xs">to</span>
            <input type="time" value={b.end} onChange={(e) => patch(i, { end: e.target.value })}
              className="bg-base border border-line rounded-lg px-2 py-1.5 text-sm outline-none focus:border-accent" />
            <button onClick={() => setDraft(rows.filter((_, k) => k !== i))} title="Remove" className="p-1.5 text-steel hover:text-stopped"><X size={13} /></button>
          </div>
        ))}
        <div className="flex items-center justify-between pt-1">
          <button onClick={() => setDraft([...rows, { name: '', start: '13:00', end: '13:30' }])}
            className="flex items-center gap-1 text-xs text-accent hover:underline"><Plus size={12} /> Add break</button>
          {draft !== null && (
            <button onClick={() => saveMut.mutate(rows)} disabled={!valid || saveMut.isPending}
              className="px-3.5 py-1.5 rounded-lg bg-accent text-white text-xs font-medium disabled:opacity-50">
              {saveMut.isPending ? 'Saving…' : 'Save schedule'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Audit trail — who changed what, before → after ───────────────────────────
function AuditTrail(): JSX.Element | null {
  const [page, setPage] = useState(1);
  const [size, setSize] = useState(DEFAULT_PAGE_SIZE);
  const { data } = useQuery({
    queryKey: ['production-audit', page, size],
    queryFn: () => productionApi.audit({ page, limit: size }),
    retry: false,
  });
  const rows: AuditRow[] = data?.data || [];
  const total = data?.meta?.total || 0;
  if (!rows.length && page === 1) return null;

  // The one line a reader needs per change: what moved, from what, to what.
  const diff = (r: AuditRow): string => {
    const b = r.before || {}, a = r.after || {};
    const keys = [...new Set([...Object.keys(b), ...Object.keys(a)])]
      .filter((k) => JSON.stringify(b[k]) !== JSON.stringify(a[k]));
    return keys.slice(0, 3).map((k) => {
      const short = (v: unknown): string => {
        if (v === undefined || v === null) return '—';
        const s = typeof v === 'string' ? v : JSON.stringify(v);
        return s.length > 40 ? s.slice(0, 40) + '…' : s;
      };
      return `${k}: ${short(b[k])} → ${short(a[k])}`;
    }).join(' · ');
  };

  return (
    <div className="px-4 sm:px-6 pb-8 space-y-3">
      <h2 className="font-semibold text-sm text-primary">Change history</h2>
      <div className="panel overflow-x-auto">
        <table className="w-full text-sm whitespace-nowrap">
          <thead className="bg-base">
            <tr className="text-steel">
              <th className="text-left label px-4 py-2.5">When</th>
              <th className="text-left label px-4 py-2.5">Who</th>
              <th className="text-left label px-4 py-2.5">Action</th>
              <th className="text-left label px-4 py-2.5">What</th>
              <th className="text-left label px-4 py-2.5">Change</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r._id} className="border-t border-line hover:bg-base/60">
                <td className="px-4 py-2 data text-xs">{fmtTime(r.at)}</td>
                <td className="px-4 py-2 text-xs">{r.user?.name || '—'}</td>
                <td className="px-4 py-2"><span className="pill bg-accent/10 text-accent !text-[10px]">{r.action}</span></td>
                <td className="px-4 py-2 text-xs text-primary">{r.entity?.label || '—'}</td>
                <td className="px-4 py-2 text-xs text-steel max-w-[380px] truncate" title={diff(r)}>{diff(r) || '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {total > size && (
        <Pager page={page} size={size} onPage={setPage} onSize={setSize} total={total} noun="changes" />
      )}
    </div>
  );
}

// ── Create / edit modal ───────────────────────────────────────────────────────
// ── Create / edit modal — the same shape as Settings → Dia & Stages: ONE name
// field, then one min/pc input per stage of the plant's flow, stacked in
// sequence. Blank = this dia doesn't run that stage. Editing prefills the
// dia's own times (its extra stages included, so nothing saved is hidden).
function DiaModal({ dia, onClose, onSaved }: { dia: DiaConfig | null; onClose: () => void; onSaved: () => void }): JSX.Element {
  const { stageTemplates } = useAppConfig();
  const [name, setName] = useState(dia?.name || '');
  // Flow order first; any stage the dia carries beyond the flow appends after.
  const stageNames = (() => {
    const names = stageTemplates.map((t) => t.name);
    for (const st of dia?.stages || []) if (!names.includes(st.name)) names.push(st.name);
    return names;
  })();
  const [vals, setVals] = useState<Record<string, string>>(() => {
    const v: Record<string, string> = {};
    for (const st of dia?.stages || []) if (st.active) v[st.name] = secToMinPerPc(st.processingSec);
    return v;
  });

  const saveMut = useMutation({
    mutationFn: () => {
      const keyOf = new Map((dia?.stages || []).map((st) => [st.name, st.key]));
      const stages = stageNames
        .map((n) => ({ name: n, processingSec: minPerPcToSec(vals[n] || '') }))
        .filter((st): st is { name: string; processingSec: number } => st.processingSec != null)
        .map((st) => ({ key: keyOf.get(st.name), name: st.name, processingSec: st.processingSec, active: true }));
      const body = { name, stages };
      return dia ? productionApi.updateDia(dia._id, body) : productionApi.createDia(body);
    },
    onSuccess: () => { toast.success(dia ? 'DIA saved' : 'DIA created'); onSaved(); },
    onError: (e: unknown) => toast.error(e instanceof Error ? e.message : 'Could not save'),
  });

  const anyStage = stageNames.some((n) => minPerPcToSec(vals[n] || '') != null);
  const valid = !!name.trim() && anyStage;

  return (
    <Modal title={dia ? `Edit ${dia.name}` : 'New DIA'} subtitle="Targets derive from the cycle counts below" icon={Target} onClose={onClose} maxW="max-w-md">
      <div className="space-y-4">
        <div>
          <div className="label mb-1.5">Dia name</div>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Dia name — e.g. 310*13*25"
            className="w-full bg-base border border-line rounded-lg px-3 py-2 text-sm outline-none focus:border-accent" />
        </div>

        <div>
          <p className="text-[11px] text-steel mb-2.5">
            Cycle count per stage for this dia — minutes per piece. Blank = this dia doesn't run that stage.
          </p>
          <div className="space-y-2">
            {stageNames.map((n) => {
              const sec = minPerPcToSec(vals[n] || '');
              return (
                <div key={n} className="flex items-center gap-2">
                  <span className="flex-1 text-sm text-primary truncate">{n}</span>
                  <input value={vals[n] || ''} inputMode="decimal" placeholder="—"
                    onChange={(e) => setVals((p) => ({ ...p, [n]: e.target.value.replace(/[^\d.]/g, '') }))}
                    className="w-20 bg-base border border-line rounded-lg px-2 py-1.5 text-sm text-center outline-none focus:border-accent" />
                  <span className="text-[10px] text-steel w-10 shrink-0">min/pc</span>
                  <span className="data text-xs text-accent w-16 text-right shrink-0">{sec != null ? `${fmtTarget(hourlyRate(sec))}/hr` : ''}</span>
                </div>
              );
            })}
            {!stageNames.length && (
              <p className="text-xs text-steel">No stages in the flow yet — add them under Settings → Dia &amp; Stages first.</p>
            )}
          </div>
        </div>

        {dia && (dia.usedOn || 0) > 0 && (
          <p className="text-[11px] text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
            {dia.usedOn} machine{dia.usedOn === 1 ? '' : 's'} currently run{dia.usedOn === 1 ? 's' : ''} this DIA on a frozen
            snapshot — saving here changes nothing on them until you re-assign, so past reports stay accurate.
          </p>
        )}

        <div className="flex justify-end gap-2 pt-1">
          <button onClick={onClose} className="px-3.5 py-2 rounded-lg border border-line text-sm text-steel hover:bg-base">Cancel</button>
          <button onClick={() => saveMut.mutate()} disabled={!valid || saveMut.isPending}
            className="px-3.5 py-2 rounded-lg bg-accent text-white text-sm font-medium disabled:opacity-50">
            {saveMut.isPending ? 'Saving…' : dia ? 'Save DIA' : 'Create DIA'}
          </button>
        </div>
      </div>
    </Modal>
  );
}

function Field({ label, value, onChange, placeholder }: { label: string; value: string; onChange: (v: string) => void; placeholder?: string }): JSX.Element {
  return (
    <div>
      <div className="label mb-1.5">{label}</div>
      <input value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder}
        className="w-full bg-base border border-line rounded-lg px-3 py-2 text-sm outline-none focus:border-accent" />
    </div>
  );
}

