// client/src/components/DiaStagesSettings.tsx — Settings → Dia & Stages.
// The teammate build's shared-config editor, on this app's store: stages are a
// plant-wide TEMPLATE (names in flow order + default times) that new dias start
// from, each DIA carries its own per-stage rate (the same stage runs at
// different speeds for different products), and machines are assigned by
// family, each with its own record trail.
//
// Everything here writes the same records the Production Targets page and the
// machine cards do — a dia set in any of the three is one assignment, with its
// processing time frozen at that moment and an audit row behind it.
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Ruler, Plus, X, ChevronUp, ChevronDown, ChevronRight, Boxes, History as HistoryIcon, ArrowUpRight,
} from 'lucide-react';
import Modal from './Modal';
import { machineApi, configApi, productionApi } from '../api/endpoints';
import { useAppConfig } from '../hooks/useAppConfig';
import { useAuthStore } from '../store/auth';
import { toast } from '../store/toast';
import { fmtTime } from '../lib/format';
import { groupMachines } from '../lib/machineOrder';
import { stageForMachine } from '../lib/diaStage';
import { fmtTarget, fmtProcessing, hourlyRate } from '../lib/targets';
import type { DiaConfig, StageTemplate } from '../types/api';

const secOf = (min: string, sec: string): number => (Number(min) || 0) * 60 + (Number(sec) || 0);

export default function DiaStagesSettings(): JSX.Element {
  const qc = useQueryClient();
  const can = useAuthStore((st) => st.can);
  const canEditDia = can('production', 'update');
  const canCreate = can('production', 'create');
  const canEditTemplates = can('settings', 'update');
  const { stageTemplates } = useAppConfig();

  const { data: dias } = useQuery({
    queryKey: ['dia-configs'],
    queryFn: () => productionApi.dia().then((r) => r.data),
  });
  const { data: machineList } = useQuery({
    queryKey: ['machines', 'diastages'],
    queryFn: () => machineApi.list({ limit: 200 }).then((r) => r.data),
    staleTime: 60_000,
  });
  const { data: assigned } = useQuery({
    queryKey: ['assignments', 'current'],
    queryFn: () => productionApi.currentAssignments().then((r) => r.data),
    enabled: can('production', 'view'),
    refetchInterval: 60_000,
    retry: false,
  });
  const asgBy = useMemo(() => {
    const m = new Map<string, { dia: string; stage: string }>();
    (assigned || []).forEach((a) => m.set(a.machineRef.toUpperCase(), { dia: a.snapshot.diaName, stage: a.snapshot.stageName }));
    return m;
  }, [assigned]);
  const usageOf = (name: string) => (assigned || []).filter((a) => a.snapshot.diaName === name).length;

  const refreshDias = () => {
    qc.invalidateQueries({ queryKey: ['dia-configs'] });
    qc.invalidateQueries({ queryKey: ['assignments'] });
  };

  // ── Stage templates — the plant's stage vocabulary, in flow order ──────────
  const pushTemplates = async (next: StageTemplate[]) => {
    try {
      await configApi.update({ stageTemplates: next });
      qc.invalidateQueries({ queryKey: ['app-config'] });
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Could not save stages'); }
  };
  const [tEdit, setTEdit] = useState<{ i: number; value: string } | null>(null);
  const [nsName, setNsName] = useState('');
  const [nsPos, setNsPos] = useState('end');   // 'end' | 'before:<i>' | 'after:<i>'
  const addTemplate = () => {
    const name = nsName.trim();
    if (!name) return;
    if (stageTemplates.some((t) => t.name.toLowerCase() === name.toLowerCase())) { toast.error('That stage already exists'); return; }
    const next = [...stageTemplates];
    if (nsPos === 'end') next.push({ name, defaultSec: 0 });
    else {
      const [where, idxS] = nsPos.split(':');
      const i = Number(idxS);
      next.splice(where === 'before' ? i : i + 1, 0, { name, defaultSec: 0 });
    }
    void pushTemplates(next);
    setNsName(''); setNsPos('end');
    toast.success(`Stage ${name} added — set its time on each dia`);
  };
  const moveTemplate = (i: number, dir: -1 | 1) => {
    const j = i + dir;
    if (j < 0 || j >= stageTemplates.length) return;
    const next = [...stageTemplates];
    [next[i], next[j]] = [next[j], next[i]];
    void pushTemplates(next);
  };
  const machinesOf = (name: string) =>
    (machineList || []).filter((m) => {
      const fake = { stages: [{ key: name, name, seq: 1, processingSec: 1, active: true }] };
      return !!stageForMachine(m, fake);
    }).length;

  // ── New dia — starts from the templates, each time editable ───────────────
  const [creating, setCreating] = useState(false);

  return (
    <div className="space-y-8">
      {/* ── Stage flow ── */}
      <section>
        <div className="flex items-center gap-2 mb-1">
          <h3 className="font-semibold text-primary flex items-center gap-1.5"><Boxes size={15} className="text-accent" /> Stage flow</h3>
          <span className="text-xs text-steel">plant-wide, in order</span>
        </div>
        <p className="text-xs text-steel mb-3 max-w-2xl">
          The stages a product passes through. This is the TEMPLATE a new dia starts from —
          each dia then carries its own time per stage, because the same stage runs at
          different speeds for different products.
        </p>
        <div className="space-y-1.5">
          {stageTemplates.map((st, i) => (
            <div key={`${st.name}-${i}`} className="flex items-center gap-2 rounded-lg border border-line bg-base px-3 py-2">
              <span className="data text-[10px] text-steel w-5 shrink-0">{i + 1}</span>
              {tEdit?.i === i ? (
                <input autoFocus value={tEdit.value}
                  onChange={(e) => setTEdit({ i, value: e.target.value })}
                  onBlur={() => {
                    const v = tEdit.value.trim();
                    setTEdit(null);
                    if (v && v !== st.name) void pushTemplates(stageTemplates.map((x, k) => (k === i ? { ...x, name: v } : x)));
                  }}
                  onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); if (e.key === 'Escape') setTEdit(null); }}
                  className="flex-1 bg-surface border border-accent/40 rounded px-2 py-1 text-sm outline-none" />
              ) : (
                <button disabled={!canEditTemplates} onClick={() => setTEdit({ i, value: st.name })}
                  className="flex-1 text-left text-sm text-primary hover:text-accent disabled:hover:text-primary truncate">
                  {st.name}
                </button>
              )}
              <span className="text-[10px] text-steel shrink-0">{machinesOf(st.name)} machine{machinesOf(st.name) === 1 ? '' : 's'}</span>
              {canEditTemplates && (
                <span className="flex items-center shrink-0">
                  <IconBtn label="Move up" disabled={i === 0} onClick={() => moveTemplate(i, -1)}><ChevronUp size={13} /></IconBtn>
                  <IconBtn label="Move down" disabled={i === stageTemplates.length - 1} onClick={() => moveTemplate(i, 1)}><ChevronDown size={13} /></IconBtn>
                  <IconBtn label="Remove stage" onClick={() => void pushTemplates(stageTemplates.filter((_, k) => k !== i))}><X size={13} /></IconBtn>
                </span>
              )}
            </div>
          ))}
          {!stageTemplates.length && <p className="text-xs text-steel">No stages yet — add the first one below.</p>}
        </div>

        {canEditTemplates && (
          <div className="flex items-center gap-2 mt-2.5 flex-wrap">
            <input value={nsName} onChange={(e) => setNsName(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') addTemplate(); }}
              placeholder="New stage — e.g. Neck Forming"
              className="flex-1 min-w-[180px] bg-base border border-line rounded-lg px-3 py-2 text-sm outline-none focus:border-accent" />
            <select value={nsPos} onChange={(e) => setNsPos(e.target.value)}
              className="bg-base border border-line rounded-lg px-2.5 py-2 text-xs outline-none focus:border-accent">
              <option value="end">at the end</option>
              {stageTemplates.map((st, i) => <option key={`b${i}`} value={`before:${i}`}>before {st.name}</option>)}
              {stageTemplates.map((st, i) => <option key={`a${i}`} value={`after:${i}`}>after {st.name}</option>)}
            </select>
            <button onClick={addTemplate} disabled={!nsName.trim()}
              className="flex items-center gap-1 bg-accent text-white text-xs font-medium px-3 py-2 rounded-lg disabled:opacity-50">
              <Plus size={12} /> Add
            </button>
          </div>
        )}
      </section>

      {/* ── Diameters ── */}
      <section>
        <div className="flex items-center gap-2 mb-1 flex-wrap">
          <h3 className="font-semibold text-primary flex items-center gap-1.5"><Ruler size={15} className="text-accent" /> Diameters</h3>
          <span className="text-xs text-steel">the product each machine is set up to make</span>
          {canCreate && (
            <button onClick={() => setCreating(true)} className="ml-auto flex items-center gap-1 text-xs text-accent hover:underline">
              <Plus size={12} /> New dia
            </button>
          )}
        </div>
        <p className="text-xs text-steel mb-3 max-w-2xl">
          Each dia holds its own time per stage. Editing a time here changes nothing on a running
          machine until it is re-assigned — that is what keeps past reports accurate.
        </p>

        {!(dias || []).length ? (
          <p className="text-xs text-steel">No dia yet. Create one — its stages come from the flow above.</p>
        ) : (
          <div className="space-y-2">
            {(dias || []).map((d) => (
              <DiaRow key={d._id} dia={d} usage={usageOf(d.name)} canEdit={canEditDia} onSaved={refreshDias} />
            ))}
          </div>
        )}
        <Link to="/production" className="mt-3 inline-flex items-center gap-1 text-xs text-accent hover:underline">
          Full catalogue, orders &amp; change history <ArrowUpRight size={12} />
        </Link>
      </section>

      {/* ── Per-machine assignment ── */}
      <section>
        <div className="flex items-center gap-2 mb-1">
          <h3 className="font-semibold text-primary flex items-center gap-1.5"><Boxes size={15} className="text-accent" /> Machines</h3>
          <span className="text-xs text-steel">which dia each machine is running</span>
        </div>
        <p className="text-xs text-steel mb-3 max-w-2xl">
          Assigning here writes the same record the machine card and its Configure tab do —
          the dia's time is frozen onto it, so the target that machine is held to never
          moves under a finished shift.
        </p>
        <MachineAssignList machines={machineList || []} dias={dias || []} asgBy={asgBy} canEdit={canEditDia} onSaved={refreshDias} />
      </section>

      {creating && (
        <NewDiaModal templates={stageTemplates} onClose={() => setCreating(false)}
          onSaved={() => { setCreating(false); refreshDias(); }} />
      )}
    </div>
  );
}

// ── One dia: its per-stage times, editable in place ──────────────────────────
function DiaRow({ dia, usage, canEdit, onSaved }: {
  dia: DiaConfig; usage: number; canEdit: boolean; onSaved: () => void;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const saveStage = async (key: string, sec: number) => {
    setBusy(true);
    try {
      await productionApi.updateDia(dia._id, {
        stages: dia.stages.map((s) => ({
          key: s.key, name: s.name, active: s.active,
          processingSec: s.key === key ? sec : s.processingSec,
        })),
      });
      toast.success('Saved — assign the machine again to put it on the new time');
      onSaved();
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Could not save'); }
    finally { setBusy(false); }
  };
  const setActive = async (active: boolean) => {
    try {
      await productionApi.setDiaActive(dia._id, active);
      toast.success(active ? `${dia.name} reactivated` : `${dia.name} retired`);
      onSaved();
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Could not update'); }
  };

  return (
    <div className={`rounded-lg border border-line ${dia.active ? 'bg-base' : 'bg-base/50 opacity-70'}`}>
      <button onClick={() => setOpen((v) => !v)} className="w-full flex items-center gap-2 px-3 py-2 text-left">
        <ChevronRight size={13} className={`text-steel transition-transform shrink-0 ${open ? 'rotate-90' : ''}`} />
        <span className="data font-semibold text-sm text-primary truncate">{dia.name}</span>
        {dia.dims && <span className="text-xs text-steel truncate">· {dia.dims}</span>}
        <span className="ml-auto flex items-center gap-2 shrink-0">
          <span className="text-[10px] text-steel">{usage ? `on ${usage} machine${usage === 1 ? '' : 's'}` : 'not assigned'}</span>
          <span className={`pill !text-[10px] ${dia.active ? 'bg-accent/10 text-accent' : 'bg-line text-steel'}`}>{dia.active ? 'Active' : 'Retired'}</span>
        </span>
      </button>
      {open && (
        <div className="px-3 pb-3 pt-1 border-t border-line space-y-1.5">
          {dia.stages.map((s) => (
            <StageTimeRow key={s.key} name={s.name} sec={s.processingSec} disabled={!canEdit || busy}
              onSave={(sec) => saveStage(s.key, sec)} />
          ))}
          {canEdit && (
            <button onClick={() => setActive(!dia.active)}
              className="text-[11px] text-steel hover:text-primary mt-1">
              {dia.active ? 'Retire this dia' : 'Reactivate'}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function StageTimeRow({ name, sec, disabled, onSave }: {
  name: string; sec: number; disabled: boolean; onSave: (sec: number) => void;
}): JSX.Element {
  const [min, setMin] = useState(String(Math.floor(sec / 60)));
  const [s, setS] = useState(String(sec % 60));
  const next = secOf(min, s);
  const dirty = next !== sec && next >= 1;
  return (
    <div className="flex items-center gap-2 flex-wrap text-sm">
      <span className="flex-1 min-w-[120px] text-primary truncate">{name}</span>
      <span className="flex items-center gap-1 text-xs text-steel">
        <input value={min} onChange={(e) => setMin(e.target.value.replace(/\D/g, ''))} disabled={disabled} inputMode="numeric"
          className="w-12 bg-surface border border-line rounded px-2 py-1 text-sm text-right outline-none focus:border-accent disabled:opacity-60" />m
        <input value={s} onChange={(e) => setS(e.target.value.replace(/\D/g, ''))} disabled={disabled} inputMode="numeric"
          className="w-12 bg-surface border border-line rounded px-2 py-1 text-sm text-right outline-none focus:border-accent disabled:opacity-60" />s
      </span>
      <span className="data text-xs text-accent w-20 text-right shrink-0">{next >= 1 ? `${fmtTarget(hourlyRate(next))}/hr` : '—'}</span>
      <button onClick={() => onSave(next)} disabled={disabled || !dirty}
        className="text-[11px] text-accent hover:underline disabled:opacity-30 disabled:no-underline shrink-0">Save</button>
    </div>
  );
}

// ── Machines by family, dia assigned inline ──────────────────────────────────
function MachineAssignList({ machines, dias, asgBy, canEdit, onSaved }: {
  machines: { _id: string; code?: string; machineId?: string; name?: string; type?: string | null }[];
  dias: DiaConfig[];
  asgBy: Map<string, { dia: string; stage: string }>;
  canEdit: boolean;
  onSaved: () => void;
}): JSX.Element {
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [historyFor, setHistoryFor] = useState<string | null>(null);
  const groups = useMemo(() => groupMachines(machines), [machines]);
  const active = dias.filter((d) => d.active);

  const assign = async (code: string, diaName: string) => {
    try {
      if (!diaName) await productionApi.setDiaByName(code, '');
      else await productionApi.setDiaByName(code, diaName);
      toast.success(diaName ? `${code} → ${diaName}` : `${code} dia cleared`);
      onSaved();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not assign dia');
    }
  };

  return (
    <div className="space-y-1.5">
      {groups.map((g) => {
        const isOpen = open.has(g.key);
        const set = g.machines.filter((m) => asgBy.get(String(m.code || m.machineId || '').toUpperCase())).length;
        return (
          <div key={g.key} className="rounded-lg border border-line bg-base">
            <button onClick={() => setOpen((s) => { const n = new Set(s); if (n.has(g.key)) n.delete(g.key); else n.add(g.key); return n; })}
              className="w-full flex items-center gap-2 px-3 py-2 text-left">
              <ChevronRight size={13} className={`text-steel transition-transform shrink-0 ${isOpen ? 'rotate-90' : ''}`} />
              <span className="text-sm font-medium text-primary truncate">{g.label}</span>
              <span className="ml-auto text-[10px] text-steel shrink-0">{set}/{g.machines.length} with a dia</span>
            </button>
            {isOpen && (
              <div className="px-3 pb-3 pt-1 border-t border-line space-y-1.5">
                {g.machines.map((m) => {
                  const code = String(m.code || m.machineId || m._id);
                  const cur = asgBy.get(code.toUpperCase());
                  return (
                    <div key={code} className="flex items-center gap-2 flex-wrap text-sm">
                      <span className="data text-xs text-primary flex-1 min-w-[140px] truncate">{code.toUpperCase()}</span>
                      {cur && <span className="text-[10px] text-steel shrink-0">{cur.stage}</span>}
                      <select value={cur?.dia || ''} disabled={!canEdit}
                        onChange={(e) => assign(code, e.target.value)}
                        className="bg-surface border border-line rounded-lg px-2 py-1 text-xs outline-none focus:border-accent disabled:opacity-60 min-w-[130px]">
                        <option value="">No dia</option>
                        {active.map((d) => <option key={d._id} value={d.name}>{d.name}</option>)}
                      </select>
                      <IconBtn label="Assignment history" onClick={() => setHistoryFor(code)}><HistoryIcon size={13} /></IconBtn>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}
      {historyFor && <DiaHistoryModal code={historyFor} onClose={() => setHistoryFor(null)} />}
    </div>
  );
}

function DiaHistoryModal({ code, onClose }: { code: string; onClose: () => void }): JSX.Element {
  const { data } = useQuery({
    queryKey: ['dia-history', code],
    queryFn: () => productionApi.assignments({ machineRef: code, limit: 50 }).then((r) => r.data),
  });
  return (
    <Modal title={`Dia history — ${code.toUpperCase()}`} subtitle="Every assignment, newest first" icon={HistoryIcon} onClose={onClose} maxW="max-w-lg">
      {!(data || []).length ? (
        <p className="text-sm text-steel">This machine has never been assigned a dia.</p>
      ) : (
        <div className="space-y-1.5">
          {(data || []).map((h) => (
            <div key={h._id} className="flex items-baseline justify-between gap-2 text-xs border-b border-line pb-1.5 last:border-0">
              <span className="text-primary truncate">
                <span className="data font-medium">{h.snapshot.diaName}</span> · {h.snapshot.stageName}
                <span className="text-steel"> · {fmtProcessing(h.snapshot.processingSec)}/pc</span>
              </span>
              <span className="data text-steel shrink-0">
                {fmtTime(h.effectiveFrom)} → {h.effectiveTo ? fmtTime(h.effectiveTo) : 'now'}
                {h.assignedBy?.name ? ` · ${h.assignedBy.name}` : ''}
              </span>
            </div>
          ))}
        </div>
      )}
    </Modal>
  );
}

// ── New dia — seeded from the stage flow, each time editable ─────────────────
function NewDiaModal({ templates, onClose, onSaved }: {
  templates: StageTemplate[]; onClose: () => void; onSaved: () => void;
}): JSX.Element {
  const [name, setName] = useState('');
  const [capacity, setCapacity] = useState('');
  const [dims, setDims] = useState('');
  const [rows, setRows] = useState(() => templates.map((t) => ({
    name: t.name, min: String(Math.floor((t.defaultSec || 180) / 60)), sec: String((t.defaultSec || 180) % 60),
  })));
  const [busy, setBusy] = useState(false);
  const valid = name.trim() && rows.length > 0 && rows.every((r) => r.name.trim() && secOf(r.min, r.sec) >= 1);

  const save = async () => {
    setBusy(true);
    try {
      await productionApi.createDia({
        name: name.trim(), capacity: capacity.trim(), dims: dims.trim(),
        stages: rows.map((r) => ({ name: r.name.trim(), processingSec: secOf(r.min, r.sec), active: true })),
      });
      toast.success(`Dia ${name.trim()} created`);
      onSaved();
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Could not create'); setBusy(false); }
  };

  return (
    <Modal title="New dia" subtitle="Stages come from the plant's flow — set this product's times" icon={Ruler} onClose={onClose} maxW="max-w-lg">
      <div className="space-y-4">
        <div className="grid sm:grid-cols-3 gap-3">
          <Field label="Name" value={name} onChange={setName} placeholder="310*13*25" />
          <Field label="Capacity" value={capacity} onChange={setCapacity} placeholder="40L" />
          <Field label="DIA / Size" value={dims} onChange={setDims} placeholder="316 × 40" />
        </div>
        <div>
          <div className="label mb-2">Time per piece, by stage</div>
          <div className="space-y-2">
            {rows.map((r, i) => {
              const sec = secOf(r.min, r.sec);
              return (
                <div key={i} className="flex items-center gap-2 flex-wrap">
                  <input value={r.name} onChange={(e) => setRows((p) => p.map((x, k) => (k === i ? { ...x, name: e.target.value } : x)))}
                    placeholder={`Stage ${i + 1}`}
                    className="flex-1 min-w-[130px] bg-base border border-line rounded-lg px-3 py-2 text-sm outline-none focus:border-accent" />
                  <span className="flex items-center gap-1 text-xs text-steel">
                    <input value={r.min} onChange={(e) => setRows((p) => p.map((x, k) => (k === i ? { ...x, min: e.target.value.replace(/\D/g, '') } : x)))} inputMode="numeric"
                      className="w-12 bg-base border border-line rounded-lg px-2 py-2 text-sm text-right outline-none focus:border-accent" />m
                    <input value={r.sec} onChange={(e) => setRows((p) => p.map((x, k) => (k === i ? { ...x, sec: e.target.value.replace(/\D/g, '') } : x)))} inputMode="numeric"
                      className="w-12 bg-base border border-line rounded-lg px-2 py-2 text-sm text-right outline-none focus:border-accent" />s
                  </span>
                  <span className="data text-xs text-accent w-20 text-right">{sec >= 1 ? `${fmtTarget(hourlyRate(sec))}/hr` : '—'}</span>
                  <IconBtn label="Remove stage" disabled={rows.length === 1} onClick={() => setRows((p) => p.filter((_, k) => k !== i))}><X size={13} /></IconBtn>
                </div>
              );
            })}
          </div>
          <button onClick={() => setRows((p) => [...p, { name: '', min: '3', sec: '0' }])}
            className="mt-2 flex items-center gap-1 text-xs text-accent hover:underline"><Plus size={12} /> Add stage</button>
        </div>
        <div className="flex justify-end gap-2">
          <button onClick={onClose} className="px-3.5 py-2 rounded-lg border border-line text-sm text-steel hover:bg-base">Cancel</button>
          <button onClick={save} disabled={!valid || busy}
            className="px-3.5 py-2 rounded-lg bg-accent text-white text-sm font-medium disabled:opacity-50">
            {busy ? 'Creating…' : 'Create dia'}
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
      className="p-1.5 text-steel hover:text-primary disabled:opacity-30 shrink-0">{children}</button>
  );
}
