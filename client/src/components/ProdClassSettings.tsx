// client/src/components/ProdClassSettings.tsx
// Admin Settings → Production classification: the rules behind the operator
// popup. Explicit Save (the server validates the WHOLE object — partial
// debounced pushes would let a half-edited state through), direct push +
// invalidate like DiaStagesSettings, no localStorage mirror.
//
// Options are the admin's to add, rename, reorder, disable and (while unused)
// remove. Each keeps the internal value it was minted with — reports and
// history hang off that — so a rename changes the button, never the records.
// OK is the one fixed point: always present, always counts.
import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ListChecks, ArrowUp, ArrowDown, Check, X, Plus } from 'lucide-react';
import { configApi } from '../api/endpoints';
import { useAppConfig } from '../hooks/useAppConfig';
import { useAuthStore } from '../store/auth';
import { toast } from '../store/toast';
import { classColor } from './ProductionClassPopup';
import type { ProdClassConfig } from '../types/api';

// Deep enough that a draft edit can never reach the react-query cache — a
// shared `reasons` array made "Add reason" mutate the cache and never dirty.
const clone = (c: ProdClassConfig): ProdClassConfig => ({ ...c, options: c.options.map((o) => ({ ...o })), reasons: [...(c.reasons || [])] });

export default function ProdClassSettings(): JSX.Element {
  const qc = useQueryClient();
  const can = useAuthStore((s) => s.can);
  const canEdit = can('settings', 'update');
  const { prodClass, readOnly } = useAppConfig();

  const [draft, setDraft] = useState<ProdClassConfig | null>(null);
  const [saving, setSaving] = useState(false);
  const [newReason, setNewReason] = useState('');
  const [newOption, setNewOption] = useState('');
  const [editReason, setEditReason] = useState<{ was: string; now: string } | null>(null);

  // A stable internal value minted once from the label: "Trial piece" →
  // TRIAL_PIECE (unique against the existing ones). History keys on it, so a
  // later rename touches the button, never the records.
  const mintValue = (label: string, taken: string[]): string => {
    const base = label.trim().toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '').replace(/^[0-9]/, 'X$&').slice(0, 28) || 'OPTION';
    let v = base; let n = 2;
    while (taken.includes(v)) { v = `${base}_${n}`; n += 1; }
    return v;
  };
  useEffect(() => { if (!draft && prodClass) setDraft(clone(prodClass)); }, [draft, prodClass]);
  if (!draft) return <div className="card p-4 text-sm text-steel">Loading classification settings…</div>;

  const dirty = JSON.stringify(draft) !== JSON.stringify(prodClass);
  const sorted = [...draft.options].sort((a, b) => a.order - b.order);
  const enabledOpts = sorted.filter((o) => o.enabled);

  const patch = (fn: (d: ProdClassConfig) => void): void => {
    const next = clone(draft);
    fn(next);
    // The default must stay an enabled option — follow it automatically so the
    // admin can't save (or even see) an impossible combination.
    if (!next.options.find((o) => o.value === next.defaultValue)?.enabled) {
      const first = [...next.options].sort((a, b) => a.order - b.order).find((o) => o.enabled);
      if (first) next.defaultValue = first.value;
    }
    setDraft(next);
  };
  const move = (value: string, dir: -1 | 1): void => patch((d) => {
    const list = [...d.options].sort((a, b) => a.order - b.order);
    const i = list.findIndex((o) => o.value === value);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= list.length) return;
    [list[i], list[j]] = [list[j], list[i]];
    list.forEach((o, k) => { const t = d.options.find((x) => x.value === o.value); if (t) t.order = k + 1; });
  });

  const save = async (): Promise<void> => {
    setSaving(true);
    try {
      await configApi.update({ prodClass: draft });
      await qc.invalidateQueries({ queryKey: ['app-config'] });
      setDraft(null);   // re-seed from the server's normalized copy
      toast.success('Classification rules saved');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not save');
    } finally {
      setSaving(false);
    }
  };

  const dis = !canEdit || readOnly;
  const inputCls = 'border border-line rounded-lg px-2.5 py-1.5 text-sm bg-base text-primary disabled:opacity-50';

  const addOption = (): void => {
    const l = newOption.trim();
    if (!l) return;
    if (draft.options.length >= 20) { toast.error('At most 20 classification options'); return; }
    if (draft.options.some((o) => o.label.trim().toLowerCase() === l.toLowerCase())) { toast.error(`"${l}" already exists — rename that one instead`); return; }
    patch((d) => {
      d.options.push({ value: mintValue(l, d.options.map((x) => x.value)), label: l, enabled: true, order: Math.max(0, ...d.options.map((x) => x.order)) + 1, counts: false });
    });
    setNewOption('');
  };

  return (
    <div className="card p-5">
      <div className="flex items-start justify-between gap-3 mb-1">
        <div className="flex items-center gap-2.5">
          <span className="w-8 h-8 rounded-lg bg-accent/10 flex items-center justify-center"><ListChecks size={16} className="text-accent" /></span>
          <div>
            <h3 className="font-semibold text-primary text-sm">Production classification</h3>
            <p className="text-xs text-steel">Every counter advance asks the operator what it was. Counting never waits for the answer.</p>
          </div>
        </div>
        {dirty && (
          <div className="flex items-center gap-2">
            {/* A save the server refused ("disable it instead") leaves the
                draft without the row it named — Discard re-seeds from the
                saved copy so there is a row to disable. */}
            <button onClick={() => setDraft(null)} disabled={saving}
              className="inline-flex items-center gap-1.5 text-xs font-semibold text-steel hover:text-primary rounded-lg px-3 py-2 disabled:opacity-50">
              <X size={13} /> Discard
            </button>
            <button onClick={save} disabled={dis || saving}
              className="inline-flex items-center gap-1.5 text-xs font-semibold bg-accent text-white rounded-lg px-3 py-2 disabled:opacity-50">
              <Check size={13} /> {saving ? 'Saving…' : 'Save changes'}
            </button>
          </div>
        )}
      </div>

      <div className="mt-4 grid sm:grid-cols-3 gap-3">
        <label className="flex items-center justify-between gap-2 rounded-xl border border-line px-3 py-2.5">
          <span className="text-xs font-medium text-primary">Classification popup</span>
          <button disabled={dis} onClick={() => patch((d) => { d.enabled = !d.enabled; })}
            className={`w-9 h-5 rounded-full transition-colors relative ${draft.enabled ? 'bg-accent' : 'bg-line'} disabled:opacity-50`}
            aria-label="Toggle classification popup">
            <span className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition-all ${draft.enabled ? 'left-[18px]' : 'left-0.5'}`} />
          </button>
        </label>
        <label className="flex items-center justify-between gap-2 rounded-xl border border-line px-3 py-2.5">
          <span className="text-xs font-medium text-primary">Popup duration</span>
          <span className="flex items-center gap-1.5">
            <input type="number" min={3} max={600} value={draft.timeoutSec} disabled={dis}
              onChange={(e) => patch((d) => { d.timeoutSec = Number(e.target.value); })}
              className={`${inputCls} w-20 data text-right`} />
            <span className="text-xs text-steel">sec</span>
          </span>
        </label>
        <label className="flex items-center justify-between gap-2 rounded-xl border border-line px-3 py-2.5">
          <span className="text-xs font-medium text-primary">Default on timeout</span>
          <select value={draft.defaultValue} disabled={dis}
            onChange={(e) => patch((d) => { d.defaultValue = e.target.value; })}
            className={`${inputCls}`}>
            {enabledOpts.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </label>
      </div>

      <div className="mt-3 rounded-xl border border-line overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-base/60">
            <tr className="text-steel">
              <th className="text-left label px-3 py-2">Shown</th>
              <th className="text-left label px-3 py-2">Button label</th>
              <th className="text-left label px-3 py-2">Records as</th>
              <th className="text-left label px-3 py-2" title="Pieces of this kind are production. Unticked = subtracted from every count.">Counts</th>
              <th className="text-right label px-3 py-2">Order</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((o, i) => (
              <tr key={o.value} className="border-t border-line">
                <td className="px-3 py-2">
                  <input type="checkbox" checked={o.enabled} disabled={dis}
                    onChange={() => patch((d) => { const t = d.options.find((x) => x.value === o.value); if (t) t.enabled = !t.enabled; })}
                    className="w-4 h-4" style={{ accentColor: 'rgb(var(--c-accent, 13 148 136))' }} />
                </td>
                <td className="px-3 py-2">
                  <input value={o.label} disabled={dis} maxLength={40}
                    onChange={(e) => patch((d) => { const t = d.options.find((x) => x.value === o.value); if (t) t.label = e.target.value; })}
                    className={`${inputCls} w-full max-w-[220px]`} />
                </td>
                <td className="px-3 py-2">
                  {/* The stable internal value — history and reports key on this. */}
                  <span className="pill font-semibold" style={{ background: `${classColor(o.value, draft.options)}1A`, color: classColor(o.value, draft.options) }}>{o.value}</span>
                </td>
                <td className="px-3 py-2">
                  {/* OK is production by definition; the rest are the admin's call. */}
                  <input type="checkbox" checked={o.counts} disabled={dis || o.value === 'OK'}
                    onChange={() => patch((d) => { const t = d.options.find((x) => x.value === o.value); if (t) t.counts = !t.counts; })}
                    className="w-4 h-4" style={{ accentColor: 'rgb(var(--c-accent, 13 148 136))' }}
                    title={o.value === 'OK' ? 'OK always counts' : o.counts ? 'Counted as production' : 'Subtracted from production'} />
                </td>
                <td className="px-3 py-2 text-right whitespace-nowrap">
                  <button disabled={dis || i === 0} onClick={() => move(o.value, -1)} className="p-1 text-steel hover:text-accent disabled:opacity-30" aria-label="Move up"><ArrowUp size={14} /></button>
                  <button disabled={dis || i === sorted.length - 1} onClick={() => move(o.value, 1)} className="p-1 text-steel hover:text-accent disabled:opacity-30" aria-label="Move down"><ArrowDown size={14} /></button>
                  {/* OK is what "good production" means and stays. Anything else
                      can go — the server refuses if pieces are recorded under it
                      (disable it instead), so history never loses a label. */}
                  <button disabled={dis || o.value === 'OK'} onClick={() => patch((d) => { d.options = d.options.filter((x) => x.value !== o.value); })}
                    className="p-1 text-steel hover:text-stopped disabled:opacity-30" aria-label={`Remove ${o.label}`} title={o.value === 'OK' ? 'OK cannot be removed' : 'Remove this option'}><X size={14} /></button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="flex gap-2 px-3 py-2 border-t border-line bg-base/40">
          <input value={newOption} disabled={dis} maxLength={40} onChange={(e) => setNewOption(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addOption(); } }}
            placeholder="New option — e.g. Rework, Trial piece" className={`${inputCls} flex-1`} />
          <button disabled={dis || !newOption.trim() || draft.options.length >= 20} onClick={addOption}
            className="inline-flex items-center gap-1 text-sm px-3 py-1.5 rounded-lg border border-accent/30 text-accent bg-accent/5 hover:bg-accent/10 disabled:opacity-50"><Plus size={14} /> Add option</button>
        </div>
      </div>

      <div className="mt-4">
        <div className="text-xs font-medium text-primary">Reasons for correcting a past classification</div>
        <div className="text-[11px] text-steel mb-2">The operator picks one when editing history — or writes their own. Click a reason to rename it.</div>
        <div className="flex flex-wrap gap-1.5 mb-2">
          {draft.reasons.length === 0 && <span className="text-xs text-steel">None — operators will write their own.</span>}
          {draft.reasons.map((r) => editReason?.was === r ? (
            <input key={r} autoFocus value={editReason.now} maxLength={60}
              onChange={(e) => setEditReason({ was: r, now: e.target.value })}
              onBlur={() => { const v = editReason.now.trim(); if (v && v !== r && !draft.reasons.some((x) => x !== r && x.toLowerCase() === v.toLowerCase())) patch((d) => { d.reasons = d.reasons.map((x) => (x === r ? v : x)); }); setEditReason(null); }}
              onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); if (e.key === 'Escape') setEditReason(null); }}
              className={`${inputCls} py-0.5 text-xs w-56`} />
          ) : (
            <span key={r} className="inline-flex items-center gap-1 pill bg-line text-primary">
              <button disabled={dis} onClick={() => setEditReason({ was: r, now: r })} className="hover:text-accent disabled:cursor-default" title="Click to rename">{r}</button>
              {!dis && <button onClick={() => patch((d) => { d.reasons = d.reasons.filter((x) => x !== r); })} className="text-steel hover:text-stopped" aria-label={`Remove ${r}`}><X size={12} /></button>}
            </span>
          ))}
        </div>
        <div className="flex gap-2">
          <input value={newReason} disabled={dis} maxLength={60} onChange={(e) => setNewReason(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); const v = newReason.trim(); if (v) { patch((d) => { if (!d.reasons.some((x) => x.toLowerCase() === v.toLowerCase())) d.reasons.push(v); }); setNewReason(''); } } }}
            placeholder="e.g. Missed the popup" className={`${inputCls} flex-1`} />
          <button disabled={dis || !newReason.trim()} onClick={() => { const v = newReason.trim(); patch((d) => { if (!d.reasons.some((x) => x.toLowerCase() === v.toLowerCase())) d.reasons.push(v); }); setNewReason(''); }}
            className="inline-flex items-center gap-1 text-sm px-3 py-1.5 rounded-lg border border-accent/30 text-accent bg-accent/5 hover:bg-accent/10 disabled:opacity-50"><Plus size={14} /> Add</button>
        </div>
      </div>

      <p className="text-[11px] text-steel mt-3">
        Popup changes apply to future production events only — history keeps its recorded classifications.
        Add your own options; rename any label freely — the <b>Records as</b> value never changes, so history stays intact.
        Disabled options leave the popup but old records still show their label; an option with recorded pieces can be disabled, not removed.
        Unticking <b>Counts</b> takes pieces of that kind out of every production figure, past and future, the moment it is saved.
        {!draft.enabled && ' With the popup off, every event is recorded as the default automatically.'}
      </p>
    </div>
  );
}
