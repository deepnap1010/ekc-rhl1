// client/src/components/ProdClassSettings.tsx
// Admin Settings → Production classification: the rules behind the operator
// popup. Explicit Save (the server validates the WHOLE object — partial
// debounced pushes would let a half-edited state through), direct push +
// invalidate like DiaStagesSettings, no localStorage mirror.
//
// The four internal values are fixed — reports hang off them — so the admin
// edits labels, order, enabled and the timeout/default, never the values.
import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ListChecks, ArrowUp, ArrowDown, Check } from 'lucide-react';
import { configApi } from '../api/endpoints';
import { useAppConfig } from '../hooks/useAppConfig';
import { useAuthStore } from '../store/auth';
import { toast } from '../store/toast';
import { CLASS_COLORS } from './ProductionClassPopup';
import type { ProdClassConfig } from '../types/api';

const clone = (c: ProdClassConfig): ProdClassConfig => ({ ...c, options: c.options.map((o) => ({ ...o })) });

export default function ProdClassSettings(): JSX.Element {
  const qc = useQueryClient();
  const can = useAuthStore((s) => s.can);
  const canEdit = can('settings', 'update');
  const { prodClass, readOnly } = useAppConfig();

  const [draft, setDraft] = useState<ProdClassConfig | null>(null);
  const [saving, setSaving] = useState(false);
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
          <button onClick={save} disabled={dis || saving}
            className="inline-flex items-center gap-1.5 text-xs font-semibold bg-accent text-white rounded-lg px-3 py-2 disabled:opacity-50">
            <Check size={13} /> {saving ? 'Saving…' : 'Save changes'}
          </button>
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
                  <span className="pill font-semibold" style={{ background: `${CLASS_COLORS[o.value]}1A`, color: CLASS_COLORS[o.value] }}>{o.value}</span>
                </td>
                <td className="px-3 py-2 text-right whitespace-nowrap">
                  <button disabled={dis || i === 0} onClick={() => move(o.value, -1)} className="p-1 text-steel hover:text-accent disabled:opacity-30" aria-label="Move up"><ArrowUp size={14} /></button>
                  <button disabled={dis || i === sorted.length - 1} onClick={() => move(o.value, 1)} className="p-1 text-steel hover:text-accent disabled:opacity-30" aria-label="Move down"><ArrowDown size={14} /></button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="text-[11px] text-steel mt-2">
        Changes apply to future production events only — history keeps its recorded classifications.
        Disabled options leave the popup but old records still show their label.
        {!draft.enabled && ' With the popup off, every event is recorded as the default automatically.'}
      </p>
    </div>
  );
}
