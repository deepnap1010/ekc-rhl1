// client/src/components/machine/ConfigurePanel.tsx
// "Configure" tab for a machine — a production-context form tailored to EKC's
// seamless gas-cylinder manufacturing: identity, work order / product, shift &
// personnel, and targets. Persists ONLY to local config (lib/machineConfig);
// it never writes to the machine / telemetry database (live PLC data is the
// single source of truth).
import { useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { RotateCcw, Check, Save, Wifi, WifiOff } from 'lucide-react';
import { userApi } from '../../api/endpoints';
import { toast } from '../../store/toast';
import { fmtMetric, fmtTime, prettyType, prettyKey } from '../../lib/format';
import { cardParams, paramLabel } from '../../lib/params';
import {
  machineKey, getConfig, saveConfig, clearConfig,
  EKC_PLANTS, PROCESS_STAGES, CYLINDER_PRODUCTS, SHIFTS,
  type MachineConfig,
} from '../../lib/machineConfig';
import type { Machine } from '../../types/api';

const numOrU = (v: string): number | undefined => (v === '' ? undefined : Number(v));

export default function ConfigurePanel({ machine }: { machine: Machine }): JSX.Element {
  const id = machineKey(machine);
  const [cfg, setCfg] = useState<MachineConfig>(() => getConfig(id));
  const [saved, setSaved] = useState(false);

  const { data: users } = useQuery({
    queryKey: ['users', 'config'],
    queryFn: () => userApi.list().then((r) => r.data),
    staleTime: 60000,
  });
  const people = (users || []).map((u) => u.name).filter(Boolean);

  // Live preview — the real, already-mapped named metrics currently on the machine.
  const params = machine.currentParameters || machine.liveParameters || machine.latestData || {};
  const preview = cardParams(params, 4);
  const online = (machine.status || '').toLowerCase() === 'running';

  const set = (patch: Partial<MachineConfig>) => { setCfg((c) => ({ ...c, ...patch })); setSaved(false); };
  const save = () => { saveConfig(id, cfg); setSaved(true); toast.success('Configuration saved'); };
  const cancel = () => { setCfg(getConfig(id)); setSaved(false); };
  const reset = () => { clearConfig(id); setCfg({}); setSaved(false); toast.success('Configuration reset'); };

  const typeLabel = prettyType(machine.type || machine.machineType) || 'Unknown';
  const lastSeen = machine.lastReadingAt;

  return (
    <div className="max-w-4xl space-y-5">
      {/* Machine summary bar */}
      <div className="panel px-4 py-3 flex flex-wrap items-center gap-x-4 gap-y-1">
        <span className="data font-bold text-sm text-primary">{String(id).toUpperCase()}</span>
        <span className="text-xs text-steel">{typeLabel}</span>
        <span className="text-xs text-steel">· {cfg.stage || 'Process stage —'}</span>
        <span className={`ml-auto inline-flex items-center gap-1.5 text-xs ${online ? 'text-accent' : 'text-steel'}`}>
          {online ? <Wifi size={13} /> : <WifiOff size={13} />} {online ? 'Online' : 'Offline'} · last seen {fmtTime(lastSeen)}
        </span>
      </div>

      {/* Current readings (live, real) */}
      {preview.length > 0 && (
        <div>
          <div className="label mb-2">Current Readings</div>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            {preview.map(([k, v]) => (
              <div key={k} className="panel p-3">
                <div className="text-[10px] text-steel uppercase tracking-wide truncate" title={prettyKey(paramLabel(k))}>{prettyKey(paramLabel(k))}</div>
                <div className="data text-lg font-bold text-primary mt-0.5 truncate">{fmtMetric(v)}</div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* 1 · Identity & assignment */}
      <Card title="Identity & Assignment">
        <div className="grid sm:grid-cols-2 gap-3">
          <Field label="Display name">
            <input className="input" value={cfg.displayName || ''} placeholder={machine.name || 'Machine name'}
              onChange={(e) => set({ displayName: e.target.value })} />
          </Field>
          <Field label="Production line / cell">
            <input className="input" value={cfg.line || ''} placeholder="e.g. HT Line 1"
              onChange={(e) => set({ line: e.target.value })} />
          </Field>
          <Field label="Plant">
            <select className="input" value={cfg.plant || ''} onChange={(e) => set({ plant: e.target.value })}>
              <option value="">—</option>
              {EKC_PLANTS.map((p) => <option key={p} value={p}>{p}</option>)}
            </select>
          </Field>
          <Field label="Process stage">
            <select className="input" value={cfg.stage || ''} onChange={(e) => set({ stage: e.target.value })}>
              <option value="">Auto ({typeLabel})</option>
              {PROCESS_STAGES.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </Field>
        </div>
      </Card>

      {/* 2 · Work order & product */}
      <Card title="Work Order & Product">
        <div className="grid sm:grid-cols-2 gap-3">
          <Field label="Cylinder type / product">
            <select className="input" value={cfg.product || ''} onChange={(e) => set({ product: e.target.value })}>
              <option value="">—</option>
              {CYLINDER_PRODUCTS.map((p) => <option key={p} value={p}>{p}</option>)}
            </select>
          </Field>
          <Field label="Cylinder spec / size">
            <input className="input" value={cfg.spec || ''} placeholder="e.g. 60L · ISO 11439"
              onChange={(e) => set({ spec: e.target.value })} />
          </Field>
          <Field label="Work order no.">
            <input className="input" value={cfg.workOrder || ''} placeholder="e.g. WO-10245"
              onChange={(e) => set({ workOrder: e.target.value })} />
          </Field>
          <Field label="Heat / batch no.">
            <input className="input" value={cfg.batchNo || ''} placeholder="e.g. HT-2026-0612"
              onChange={(e) => set({ batchNo: e.target.value })} />
          </Field>
        </div>
      </Card>

      {/* 3 · Shift & personnel */}
      <Card title="Shift & Personnel">
        <div className="grid sm:grid-cols-3 gap-3">
          <Field label="Shift">
            <select className="input" value={cfg.shift || ''} onChange={(e) => set({ shift: e.target.value })}>
              <option value="">—</option>
              {SHIFTS.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </Field>
          <Field label="Supervisor">
            <PersonSelect value={cfg.supervisor} people={people} onChange={(v) => set({ supervisor: v })} />
          </Field>
          <Field label="Operator">
            <PersonSelect value={cfg.operator} people={people} onChange={(v) => set({ operator: v })} />
          </Field>
        </div>
      </Card>

      {/* 4 · Production targets */}
      <Card title="Production Targets">
        <div className="grid sm:grid-cols-4 gap-3">
          <Field label="Rated capacity / hr">
            <input className="input" type="number" value={cfg.targets?.capacity ?? ''} placeholder="—"
              onChange={(e) => set({ targets: { ...cfg.targets, capacity: numOrU(e.target.value) } })} />
          </Field>
          <Field label="Shift target">
            <input className="input" type="number" value={cfg.targets?.shiftTarget ?? ''} placeholder="—"
              onChange={(e) => set({ targets: { ...cfg.targets, shiftTarget: numOrU(e.target.value) } })} />
          </Field>
          <Field label="Cycle time (s)">
            <input className="input" type="number" value={cfg.targets?.cycleTime ?? ''} placeholder="—"
              onChange={(e) => set({ targets: { ...cfg.targets, cycleTime: numOrU(e.target.value) } })} />
          </Field>
          <Field label="Mark offline after (min)">
            <input className="input" type="number" value={cfg.offlineMin ?? ''} placeholder="e.g. 2"
              onChange={(e) => set({ offlineMin: numOrU(e.target.value) })} />
          </Field>
        </div>
      </Card>

      {/* Actions */}
      <div className="flex items-center justify-between sticky bottom-0 bg-surface/95 backdrop-blur py-3 -mx-1 px-1 border-t border-line">
        <button onClick={reset} className="flex items-center gap-1.5 text-xs text-steel hover:text-stopped">
          <RotateCcw size={13} /> Reset to default
        </button>
        <div className="flex items-center gap-2">
          {saved && <span className="text-xs text-accent flex items-center gap-1"><Check size={13} /> Saved</span>}
          <button onClick={cancel} className="px-3 py-2 rounded-lg text-sm text-steel hover:bg-base">Cancel</button>
          <button onClick={save} className="flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm bg-accent text-white hover:bg-accent/90 font-medium">
            <Save size={14} /> Save Configuration
          </button>
        </div>
      </div>

      <p className="text-[11px] text-steel/70 px-1">
        This configuration is saved on this device only and is display-only — it never changes the machine's live PLC data.
      </p>
    </div>
  );
}

function PersonSelect({ value, people, onChange }: { value?: string; people: string[]; onChange: (v: string) => void }): JSX.Element {
  // Keep any previously-saved name even if it's not in the (active) user list.
  const options = value && !people.includes(value) ? [value, ...people] : people;
  return (
    <select className="input" value={value || ''} onChange={(e) => onChange(e.target.value)}>
      <option value="">—</option>
      {options.map((p) => <option key={p} value={p}>{p}</option>)}
    </select>
  );
}

function Card({ title, children }: { title: string; children: ReactNode }): JSX.Element {
  return (
    <div className="panel p-4">
      <div className="flex items-center justify-between mb-3">
        <h3 className="font-semibold text-sm text-primary">{title}</h3>
      </div>
      {children}
    </div>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }): JSX.Element {
  return (
    <div>
      <label className="block text-[11px] text-steel mb-1">{label}</label>
      {children}
    </div>
  );
}
