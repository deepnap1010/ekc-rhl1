// client/src/pages/ProductionSetup.tsx — Production Targets configuration.
// Supervisors define DIA products (capacity + dimensions) and their stages,
// each with a processing time per unit. Targets are DERIVED from those times
// (60 min ÷ 3 min = 20/hr) — nobody ever types a target. Assigning a DIA to a
// machine happens on the machine itself (header chip / Configure tab); this
// page is the catalogue.
import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus, Pencil, Target, ArrowUp, ArrowDown, X } from 'lucide-react';
import { productionApi } from '../api/endpoints';
import { Spinner } from '../components/ui';
import PageHeader from '../components/PageHeader';
import Modal from '../components/Modal';
import { useAuthStore } from '../store/auth';
import { toast } from '../store/toast';
import { fmtTarget, fmtProcessing, hourlyRate } from '../lib/targets';
import type { DiaConfig, DiaStage } from '../types/api';

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

// ── Create / edit modal ───────────────────────────────────────────────────────
interface StageDraft { key?: string; name: string; min: string; sec: string; active: boolean }

const toDraft = (s: DiaStage): StageDraft => ({
  key: s.key, name: s.name, min: String(Math.floor(s.processingSec / 60)), sec: String(s.processingSec % 60), active: s.active,
});
const draftSec = (s: StageDraft): number => (Number(s.min) || 0) * 60 + (Number(s.sec) || 0);

function DiaModal({ dia, onClose, onSaved }: { dia: DiaConfig | null; onClose: () => void; onSaved: () => void }): JSX.Element {
  const [name, setName] = useState(dia?.name || '');
  const [capacity, setCapacity] = useState(dia?.capacity || '');
  const [dims, setDims] = useState(dia?.dims || '');
  const [stages, setStages] = useState<StageDraft[]>(
    dia ? dia.stages.map(toDraft) : [{ name: '', min: '3', sec: '0', active: true }],
  );

  const saveMut = useMutation({
    mutationFn: () => {
      const body = {
        name, capacity, dims,
        stages: stages.map((s) => ({ key: s.key, name: s.name, processingSec: draftSec(s), active: s.active })),
      };
      return dia ? productionApi.updateDia(dia._id, body) : productionApi.createDia(body);
    },
    onSuccess: () => { toast.success(dia ? 'DIA saved' : 'DIA created'); onSaved(); },
    onError: (e: unknown) => toast.error(e instanceof Error ? e.message : 'Could not save'),
  });

  const move = (i: number, dir: -1 | 1) => setStages((prev) => {
    const next = [...prev];
    const j = i + dir;
    if (j < 0 || j >= next.length) return prev;
    [next[i], next[j]] = [next[j], next[i]];
    return next;
  });
  const patch = (i: number, p: Partial<StageDraft>) =>
    setStages((prev) => prev.map((s, k) => (k === i ? { ...s, ...p } : s)));

  const valid = name.trim() && stages.length > 0 && stages.every((s) => s.name.trim() && draftSec(s) >= 1 && draftSec(s) <= 86_400);

  return (
    <Modal title={dia ? `Edit ${dia.name}` : 'New DIA'} subtitle="Targets derive from the processing times below" icon={Target} onClose={onClose} maxW="max-w-2xl">
      <div className="space-y-4">
        <div className="grid sm:grid-cols-3 gap-3">
          <Field label="Name" value={name} onChange={setName} placeholder="40L" />
          <Field label="Capacity" value={capacity} onChange={setCapacity} placeholder="40L" />
          <Field label="DIA / Size" value={dims} onChange={setDims} placeholder="316 × 40" />
        </div>

        <div>
          <div className="label mb-2">Production stages · time per unit</div>
          <div className="space-y-2">
            {stages.map((s, i) => {
              const sec = draftSec(s);
              return (
                <div key={i} className="flex items-center gap-2 flex-wrap">
                  <input value={s.name} onChange={(e) => patch(i, { name: e.target.value })} placeholder={`Stage ${i + 1} — e.g. Cutting`}
                    className="flex-1 min-w-[140px] bg-base border border-line rounded-lg px-3 py-2 text-sm outline-none focus:border-accent" />
                  <span className="flex items-center gap-1 text-xs text-steel">
                    <input value={s.min} onChange={(e) => patch(i, { min: e.target.value.replace(/\D/g, '') })} inputMode="numeric"
                      className="w-12 bg-base border border-line rounded-lg px-2 py-2 text-sm text-right outline-none focus:border-accent" />m
                    <input value={s.sec} onChange={(e) => patch(i, { sec: e.target.value.replace(/\D/g, '') })} inputMode="numeric"
                      className="w-12 bg-base border border-line rounded-lg px-2 py-2 text-sm text-right outline-none focus:border-accent" />s
                  </span>
                  <span className="data text-xs text-accent w-20 text-right">{sec >= 1 ? `${fmtTarget(hourlyRate(sec))}/hr` : '—'}</span>
                  <span className="flex items-center">
                    <IconBtn onClick={() => move(i, -1)} disabled={i === 0} label="Move up"><ArrowUp size={13} /></IconBtn>
                    <IconBtn onClick={() => move(i, 1)} disabled={i === stages.length - 1} label="Move down"><ArrowDown size={13} /></IconBtn>
                    <IconBtn onClick={() => setStages((p) => p.filter((_, k) => k !== i))} disabled={stages.length === 1} label="Remove stage"><X size={13} /></IconBtn>
                  </span>
                </div>
              );
            })}
          </div>
          <button onClick={() => setStages((p) => [...p, { name: '', min: '3', sec: '0', active: true }])}
            className="mt-2 flex items-center gap-1 text-xs text-accent hover:underline"><Plus size={12} /> Add stage</button>
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

function IconBtn({ onClick, disabled, label, children }: { onClick: () => void; disabled?: boolean; label: string; children: JSX.Element }): JSX.Element {
  return (
    <button onClick={onClick} disabled={disabled} title={label} aria-label={label}
      className="p-1.5 text-steel hover:text-primary disabled:opacity-30">{children}</button>
  );
}
