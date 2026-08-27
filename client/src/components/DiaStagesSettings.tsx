// client/src/components/DiaStagesSettings.tsx — Settings → Dia & Stages.
// The teammate build's console, laid out exactly as they shipped it:
//
//   1. DIAMETERS — create a dia inline: name + a grid of "min/pc" inputs, one
//      per stage in the flow; BLANK = this dia doesn't run that stage. Saved
//      dias list underneath with their cycle summary, machine usage, "Edit
//      cycles" in place, and Retire.
//   2. STAGES — the production flow in priority order, created ONCE. No cycle
//      counts here: each dia carries its own per-stage times.
//   3. ASSIGN DIA TO MACHINES — machines grouped by family, a dia select per
//      machine, every change kept as a record (history behind the clock icon).
//
// All of it writes this app's store (dia_configs + machine_assignments): one
// record whether a dia is set here, on a machine card, or on the Production
// Targets page — with the processing time frozen onto the assignment and an
// audit row behind it.
import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Ruler, Plus, X, ChevronUp, ChevronDown, ChevronRight, Boxes, Check,
  History as HistoryIcon, Layers,
} from 'lucide-react';
import Modal from './Modal';
import { machineApi, configApi, productionApi } from '../api/endpoints';
import { useAppConfig } from '../hooks/useAppConfig';
import { useAuthStore } from '../store/auth';
import { toast } from '../store/toast';
import { fmtTime } from '../lib/format';
import { groupMachines } from '../lib/machineOrder';
import { stageForMachine } from '../lib/diaStage';
import { fmtProcessing } from '../lib/targets';
import type { DiaConfig, StageTemplate } from '../types/api';

// Times read and type in MINUTES per piece (their unit); stored in seconds.
const fmtMin = (sec: number): string => (sec % 60 === 0 ? `${sec / 60}m` : `${Math.round((sec / 60) * 10) / 10}m`);
const minToSec = (v: string): number | null => {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0 || n > 24 * 60) return null;
  return Math.max(1, Math.round(n * 60));
};
const secToMinStr = (sec: number): string => (sec % 60 === 0 ? String(sec / 60) : String(Math.round((sec / 60) * 100) / 100));

export default function DiaStagesSettings(): JSX.Element {
  const qc = useQueryClient();
  const can = useAuthStore((st) => st.can);
  const canDia = can('production', 'update');
  const canCreate = can('production', 'create');
  const canTemplates = can('settings', 'update');
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
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['dia-configs'] });
    qc.invalidateQueries({ queryKey: ['assignments'] });
  };

  return (
    <div className="space-y-5">
      <DiametersPanel dias={dias || []} templates={stageTemplates} usageOf={usageOf}
        canCreate={canCreate} canEdit={canDia} onSaved={refresh} />
      <StagesPanel dias={dias || []} templates={stageTemplates} machines={machineList || []} canEdit={canTemplates} />
      <AssignPanel machines={machineList || []} dias={dias || []} asgBy={asgBy} canEdit={canDia} onSaved={refresh} />
    </div>
  );
}

// ═══ 1 · Diameters ════════════════════════════════════════════════════════════
function DiametersPanel({ dias, templates, usageOf, canCreate, canEdit, onSaved }: {
  dias: DiaConfig[]; templates: StageTemplate[];
  usageOf: (name: string) => number;
  canCreate: boolean; canEdit: boolean; onSaved: () => void;
}): JSX.Element {
  const [name, setName] = useState('');
  const [draft, setDraft] = useState<Record<string, string>>({});   // stage name -> min/pc
  const [busy, setBusy] = useState(false);

  const saveDia = async () => {
    const nm = name.trim();
    if (!nm) { toast.error('Give the dia a name first'); return; }
    if (dias.some((d) => d.name === nm)) { toast.error('That diameter already exists'); return; }
    // Only the stages with a value — blank means this dia doesn't run that stage.
    const stages = templates
      .map((t) => ({ name: t.name, processingSec: minToSec(draft[t.name] || '') }))
      .filter((s): s is { name: string; processingSec: number } => s.processingSec != null)
      .map((s) => ({ name: s.name, processingSec: s.processingSec, active: true }));
    if (!stages.length) { toast.error('Set at least one stage’s cycle count'); return; }
    setBusy(true);
    try {
      await productionApi.createDia({ name: nm, capacity: '', dims: '', stages });
      toast.success(`Dia ${nm} saved with its cycle counts`);
      setName(''); setDraft({});
      onSaved();
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Could not save'); }
    finally { setBusy(false); }
  };

  const [editFor, setEditFor] = useState<string | null>(null);
  const byNewest = (a: DiaConfig, b: DiaConfig) => (b.updatedAt || '').localeCompare(a.updatedAt || '');
  const activeDias = dias.filter((d) => d.active).sort(byNewest);
  const retiredDias = dias.filter((d) => !d.active);

  const setActive = async (d: DiaConfig, active: boolean) => {
    try {
      await productionApi.setDiaActive(d._id, active);
      toast.success(active ? `${d.name} reactivated` : `${d.name} retired`);
      onSaved();
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Could not update'); }
  };

  const cycleSummary = (d: DiaConfig): string =>
    d.stages.filter((s) => s.active).map((s) => `${s.name} ${fmtMin(s.processingSec)}`).join(' · ') || 'no stages';

  return (
    <div className="panel p-5">
      <div className="flex items-center gap-2.5 mb-4">
        <span className="w-9 h-9 rounded-xl bg-accent/10 flex items-center justify-center shrink-0"><Ruler size={16} className="text-accent" /></span>
        <h2 className="font-semibold text-primary">Diameters</h2>
      </div>

      {/* ── Create dia — inline, their exact shape ── */}
      {canCreate && (
        <div className="rounded-xl border border-line bg-base p-4 mb-5">
          <div className="label mb-1.5">Create dia</div>
          <input value={name} onChange={(e) => setName(e.target.value)}
            placeholder="Dia name — e.g. 310*13*25"
            className="w-full bg-surface border border-line rounded-lg px-3 py-2 text-sm outline-none focus:border-accent mb-2" />
          <p className="text-[11px] text-steel mb-3">
            Cycle count per stage for this dia — minutes per piece. Blank = this dia doesn't run that stage.
          </p>
          <div className="grid sm:grid-cols-2 gap-x-8 gap-y-2 mb-3">
            {templates.map((t) => (
              <div key={t.name} className="flex items-center gap-2">
                <span className="flex-1 text-sm text-primary truncate">{t.name}</span>
                <input value={draft[t.name] || ''} inputMode="decimal" placeholder="—"
                  onChange={(e) => setDraft((p) => ({ ...p, [t.name]: e.target.value.replace(/[^\d.]/g, '') }))}
                  className="w-20 bg-surface border border-line rounded-lg px-2 py-1.5 text-sm text-center outline-none focus:border-accent" />
                <span className="text-[10px] text-steel w-12">min/pc</span>
              </div>
            ))}
            {!templates.length && <p className="text-xs text-steel">Add stages below first — a dia's times hang on them.</p>}
          </div>
          <button onClick={saveDia} disabled={busy || !name.trim()}
            className="flex items-center gap-1.5 bg-accent text-white text-sm font-medium px-3.5 py-2 rounded-lg disabled:opacity-50">
            <Check size={14} /> {busy ? 'Saving…' : 'Save dia'}
          </button>
        </div>
      )}

      {/* ── Saved dias ── */}
      <div className="label mb-2">Saved dias</div>
      {!activeDias.length && !retiredDias.length ? (
        <p className="text-xs text-steel">No dia yet — create the first one above.</p>
      ) : (
        <div className="space-y-1.5">
          {[...activeDias, ...retiredDias].map((d) => (
            <div key={d._id} className={`rounded-lg border border-line ${d.active ? '' : 'opacity-60'}`}>
              <div className="flex items-center gap-2.5 px-3 py-2 flex-wrap">
                <span className="data font-bold text-sm text-primary shrink-0">{d.name}</span>
                <span className="pill bg-accent/10 text-accent !text-[10px] shrink-0">{usageOf(d.name)} machine{usageOf(d.name) === 1 ? '' : 's'}</span>
                <span className="text-[11px] text-steel truncate flex-1 min-w-[120px]" title={cycleSummary(d)}>{cycleSummary(d)}</span>
                {d.updatedAt && <span className="text-[10px] text-steel shrink-0">since {new Date(d.updatedAt).toLocaleDateString()}</span>}
                {canEdit && (
                  <span className="flex items-center gap-3 shrink-0 text-xs">
                    <button onClick={() => setEditFor(editFor === d._id ? null : d._id)} className="text-accent hover:underline">
                      {editFor === d._id ? 'Close' : 'Edit cycles'}
                    </button>
                    <button onClick={() => setActive(d, !d.active)} className="text-steel hover:text-primary">
                      {d.active ? 'Retire' : 'Reactivate'}
                    </button>
                  </span>
                )}
              </div>
              {editFor === d._id && (
                <EditCycles dia={d} templates={templates} onSaved={() => { setEditFor(null); onSaved(); }} />
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// "Edit cycles" — the same min/pc grid over a SAVED dia. Blank removes the
// stage from this dia; filling a blank adds it. Machines keep their frozen
// time until re-assigned, so past reports never move.
function EditCycles({ dia, templates, onSaved }: {
  dia: DiaConfig; templates: StageTemplate[]; onSaved: () => void;
}): JSX.Element {
  // Every stage the flow knows OR the dia already has (covers renamed flows).
  const stageNames = useMemo(() => {
    const names = templates.map((t) => t.name);
    for (const s of dia.stages) if (!names.includes(s.name)) names.push(s.name);
    return names;
  }, [dia, templates]);
  const [vals, setVals] = useState<Record<string, string>>(() => {
    const v: Record<string, string> = {};
    for (const s of dia.stages) if (s.active) v[s.name] = secToMinStr(s.processingSec);
    return v;
  });
  const [busy, setBusy] = useState(false);

  const save = async () => {
    const keyOf = new Map(dia.stages.map((s) => [s.name, s.key]));
    const stages = stageNames
      .map((n) => ({ name: n, processingSec: minToSec(vals[n] || '') }))
      .filter((s): s is { name: string; processingSec: number } => s.processingSec != null)
      .map((s) => ({ key: keyOf.get(s.name), name: s.name, processingSec: s.processingSec, active: true }));
    if (!stages.length) { toast.error('A dia needs at least one stage with a cycle count'); return; }
    setBusy(true);
    try {
      await productionApi.updateDia(dia._id, { stages });
      toast.success('Cycles saved — re-assign a machine to put it on the new time');
      onSaved();
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Could not save'); setBusy(false); }
  };

  return (
    <div className="px-3 pb-3 pt-2 border-t border-line">
      <div className="grid sm:grid-cols-2 gap-x-8 gap-y-2 mb-3">
        {stageNames.map((n) => (
          <div key={n} className="flex items-center gap-2">
            <span className="flex-1 text-sm text-primary truncate">{n}</span>
            <input value={vals[n] || ''} inputMode="decimal" placeholder="—"
              onChange={(e) => setVals((p) => ({ ...p, [n]: e.target.value.replace(/[^\d.]/g, '') }))}
              className="w-20 bg-surface border border-line rounded-lg px-2 py-1.5 text-sm text-center outline-none focus:border-accent" />
            <span className="text-[10px] text-steel w-12">min/pc</span>
          </div>
        ))}
      </div>
      <div className="flex items-center gap-3">
        <button onClick={save} disabled={busy}
          className="flex items-center gap-1.5 bg-accent text-white text-xs font-medium px-3 py-1.5 rounded-lg disabled:opacity-50">
          <Check size={12} /> {busy ? 'Saving…' : 'Save cycles'}
        </button>
        <span className="text-[10px] text-steel">Machines keep their current time until re-assigned — past reports stay accurate.</span>
      </div>
    </div>
  );
}

// ═══ 2 · Stages ═══════════════════════════════════════════════════════════════
function StagesPanel({ dias, templates, machines, canEdit }: {
  dias: DiaConfig[]; templates: StageTemplate[];
  machines: { _id: string; code?: string; machineId?: string; name?: string; type?: string | null }[];
  canEdit: boolean;
}): JSX.Element {
  const qc = useQueryClient();
  const push = async (next: StageTemplate[]) => {
    try {
      await configApi.update({ stageTemplates: next });
      qc.invalidateQueries({ queryKey: ['app-config'] });
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Could not save stages'); }
  };
  const move = (i: number, dir: -1 | 1) => {
    const j = i + dir;
    if (j < 0 || j >= templates.length) return;
    const next = [...templates];
    [next[i], next[j]] = [next[j], next[i]];
    void push(next);
  };
  const machinesOf = (name: string) =>
    machines.filter((m) => !!stageForMachine(m, { stages: [{ key: name, name, seq: 1, processingSec: 1, active: true }] })).length;
  // Each stage's per-dia summary: "30*12: 3m · PP239: 2m · 40*50: 4m".
  const diaSummary = (name: string): string =>
    dias.filter((d) => d.active)
      .map((d) => {
        const s = d.stages.find((x) => x.active && x.name === name);
        return s ? `${d.name}: ${fmtMin(s.processingSec)}` : null;
      })
      .filter(Boolean).join(' · ');

  const [nsName, setNsName] = useState('');
  const [nsPos, setNsPos] = useState('end');
  const addStage = () => {
    const name = nsName.trim();
    if (!name) return;
    if (templates.some((t) => t.name.toLowerCase() === name.toLowerCase())) { toast.error('That stage already exists'); return; }
    const next = [...templates];
    if (nsPos === 'end') next.push({ name, defaultSec: 0 });
    else {
      const [where, idxS] = nsPos.split(':');
      const i = Number(idxS);
      next.splice(where === 'before' ? i : i + 1, 0, { name, defaultSec: 0 });
    }
    void push(next);
    setNsName(''); setNsPos('end');
    toast.success(`Stage ${name} added — set its cycle count on each dia`);
  };

  return (
    <div className="panel p-5">
      <div className="flex items-start gap-2.5 mb-1">
        <span className="w-9 h-9 rounded-xl bg-accent/10 flex items-center justify-center shrink-0"><Layers size={16} className="text-accent" /></span>
        <div>
          <h2 className="font-semibold text-primary">Stages</h2>
          <p className="text-xs text-steel max-w-2xl">
            The production flow in priority order — created ONCE. Cycle counts are not set here:
            each dia carries its own per-stage cycle times, filled when the dia is created above.
          </p>
        </div>
      </div>

      <div className="space-y-1.5 mt-4">
        {templates.map((t, i) => (
          <div key={`${t.name}-${i}`} className="flex items-center gap-2.5 rounded-lg border border-line bg-base px-3 py-2 flex-wrap">
            <span className="w-5 h-5 rounded bg-line text-steel data text-[10px] flex items-center justify-center shrink-0">{i + 1}</span>
            <span className="text-sm font-medium text-primary shrink-0">{t.name}</span>
            <span className="text-[11px] text-steel truncate flex-1 min-w-[100px]" title={diaSummary(t.name)}>{diaSummary(t.name)}</span>
            <span className="pill bg-line text-steel !text-[10px] shrink-0">{machinesOf(t.name)} machine{machinesOf(t.name) === 1 ? '' : 's'}</span>
            {canEdit && (
              <span className="flex items-center shrink-0">
                <IconBtn label="Move up" disabled={i === 0} onClick={() => move(i, -1)}><ChevronUp size={13} /></IconBtn>
                <IconBtn label="Move down" disabled={i === templates.length - 1} onClick={() => move(i, 1)}><ChevronDown size={13} /></IconBtn>
                <IconBtn label="Remove stage" onClick={() => void push(templates.filter((_, k) => k !== i))}><X size={13} /></IconBtn>
              </span>
            )}
          </div>
        ))}
        {!templates.length && <p className="text-xs text-steel">No stages yet — add the first one below.</p>}
      </div>

      {canEdit && (
        <div className="flex items-end gap-3 mt-3 flex-wrap">
          <div className="flex-1 min-w-[160px]">
            <div className="label mb-1.5">New stage</div>
            <input value={nsName} onChange={(e) => setNsName(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') addStage(); }}
              placeholder="e.g. Spinning"
              className="w-full bg-base border border-line rounded-lg px-3 py-2 text-sm outline-none focus:border-accent" />
          </div>
          <div>
            <div className="label mb-1.5">Position in the flow</div>
            <select value={nsPos} onChange={(e) => setNsPos(e.target.value)}
              className="bg-base border border-line rounded-lg px-2.5 py-2 text-sm outline-none focus:border-accent">
              <option value="end">At the end</option>
              {templates.map((t, i) => <option key={`b${i}`} value={`before:${i}`}>Before {t.name}</option>)}
              {templates.map((t, i) => <option key={`a${i}`} value={`after:${i}`}>After {t.name}</option>)}
            </select>
          </div>
          <button onClick={addStage} disabled={!nsName.trim()}
            className="flex items-center gap-1 border border-accent/30 bg-accent/5 text-accent text-sm font-medium px-3.5 py-2 rounded-lg disabled:opacity-50 hover:bg-accent/10">
            <Plus size={13} /> Add stage
          </button>
        </div>
      )}
    </div>
  );
}

// ═══ 3 · Assign dia to machines ═══════════════════════════════════════════════
function AssignPanel({ machines, dias, asgBy, canEdit, onSaved }: {
  machines: { _id: string; code?: string; machineId?: string; name?: string; type?: string | null }[];
  dias: DiaConfig[];
  asgBy: Map<string, { dia: string; stage: string }>;
  canEdit: boolean;
  onSaved: () => void;
}): JSX.Element {
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [historyFor, setHistoryFor] = useState<string | null>(null);
  // When no stage name matches the machine's family (an SPG on a dia whose
  // stages are Cutting/Spinning), the server refuses to guess — so this panel
  // asks: a small stage picker for exactly that case.
  const [askStage, setAskStage] = useState<{ code: string; dia: DiaConfig } | null>(null);
  const groups = useMemo(() => groupMachines(machines), [machines]);
  const active = dias.filter((d) => d.active);

  const doAssign = async (code: string, diaName: string, stage?: string) => {
    try {
      await productionApi.setDiaByName(code, diaName, stage);
      toast.success(diaName ? `${code.toUpperCase()} → ${diaName}` : `${code.toUpperCase()} dia cleared`);
      onSaved();
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Could not assign dia'); }
  };
  const assign = (code: string, diaName: string, machine: Parameters<typeof stageForMachine>[0]) => {
    if (!diaName) return void doAssign(code, '');
    const dia = active.find((d) => d.name === diaName);
    if (!dia) return;
    const activeStages = dia.stages.filter((st) => st.active);
    const hit = stageForMachine(machine, dia) || (activeStages.length === 1 ? activeStages[0] : null);
    if (hit) return void doAssign(code, diaName, hit.name);
    setAskStage({ code, dia });
  };

  return (
    <div className="panel p-5">
      <div className="flex items-start gap-2.5 mb-4">
        <span className="w-9 h-9 rounded-xl bg-accent/10 flex items-center justify-center shrink-0"><Boxes size={16} className="text-accent" /></span>
        <div>
          <h2 className="font-semibold text-primary">Assign dia to machines</h2>
          <p className="text-xs text-steel max-w-2xl">
            Machines grouped by family — open a group and set what each machine is making. The same
            option lives on the machine cards; every change is kept as a record.
          </p>
        </div>
      </div>

      <div className="space-y-1.5">
        {groups.map((g) => {
          const isOpen = open.has(g.key);
          const set = g.machines.filter((m) => asgBy.get(String(m.code || m.machineId || '').toUpperCase())).length;
          return (
            <div key={g.key} className="rounded-lg border border-line bg-base">
              <button onClick={() => setOpen((s) => { const n = new Set(s); if (n.has(g.key)) n.delete(g.key); else n.add(g.key); return n; })}
                className="w-full flex items-center gap-2.5 px-3 py-2.5 text-left">
                <span className="w-6 h-6 rounded-lg bg-accent/10 flex items-center justify-center shrink-0"><Boxes size={12} className="text-accent" /></span>
                <span className="text-sm font-medium text-primary truncate">{g.label}</span>
                <span className="pill bg-line text-steel !text-[10px] shrink-0">{g.machines.length} machine{g.machines.length === 1 ? '' : 's'}</span>
                <span className={`pill !text-[10px] shrink-0 ${set === g.machines.length && set > 0 ? 'bg-accent/10 text-accent' : 'bg-line text-steel'}`}>{set}/{g.machines.length} dia set</span>
                <ChevronRight size={14} className={`ml-auto text-steel transition-transform shrink-0 ${isOpen ? 'rotate-90' : ''}`} />
              </button>
              {isOpen && (
                <div className="border-t border-line divide-y divide-line">
                  {g.machines.map((m) => {
                    const code = String(m.code || m.machineId || m._id);
                    const cur = asgBy.get(code.toUpperCase());
                    return (
                      <div key={code} className="flex items-center gap-3 px-3 py-2 flex-wrap">
                        <span className="data text-xs font-medium text-primary flex-1 min-w-[150px] truncate">{code.toUpperCase()}</span>
                        {cur && <span className="text-[10px] text-steel shrink-0">{cur.stage}</span>}
                        <select value={cur?.dia || ''} disabled={!canEdit}
                          onChange={(e) => assign(code, e.target.value, m)}
                          className="bg-surface border border-line rounded-lg px-2.5 py-1.5 text-xs outline-none focus:border-accent disabled:opacity-60 min-w-[140px]">
                          <option value="">No dia</option>
                          {active.map((d) => <option key={d._id} value={d.name}>{d.name}</option>)}
                        </select>
                        <IconBtn label="Assignment history" onClick={() => setHistoryFor(code)}><HistoryIcon size={14} /></IconBtn>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </div>
      {historyFor && <DiaHistoryModal code={historyFor} onClose={() => setHistoryFor(null)} />}
      {askStage && (
        <Modal title={`Which stage — ${askStage.code.toUpperCase()}`}
          subtitle={`No stage of "${askStage.dia.name}" matches this machine's family — pick the one it runs`}
          icon={Layers} onClose={() => setAskStage(null)} maxW="max-w-sm">
          <div className="space-y-1.5">
            {askStage.dia.stages.filter((st) => st.active).map((st) => (
              <button key={st.key}
                onClick={() => { void doAssign(askStage.code, askStage.dia.name, st.name); setAskStage(null); }}
                className="w-full flex items-center justify-between gap-2 rounded-lg border border-line bg-base px-3 py-2 text-sm hover:border-accent/40 hover:bg-accent/5">
                <span className="text-primary">{st.name}</span>
                <span className="data text-xs text-steel">{fmtMin(st.processingSec)}/pc</span>
              </button>
            ))}
          </div>
        </Modal>
      )}
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

function IconBtn({ onClick, disabled, label, children }: { onClick: () => void; disabled?: boolean; label: string; children: JSX.Element }): JSX.Element {
  return (
    <button onClick={onClick} disabled={disabled} title={label} aria-label={label}
      className="p-1.5 text-steel hover:text-primary disabled:opacity-30 shrink-0">{children}</button>
  );
}
