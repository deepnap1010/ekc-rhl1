// client/src/components/DowntimeAskSettings.tsx
// Admin Settings → Alerts & Downtime: the rules behind the operator's
// downtime-reason popup. Same contract as ProdClassSettings — explicit Save
// (the server validates the whole object), direct push + invalidate, no
// localStorage mirror. Reasons are plain words: rename, reorder, remove
// freely; past spans keep the words that were true when they were written.
import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { PauseCircle, ArrowUp, ArrowDown, Check, X, Plus } from 'lucide-react';
import { configApi } from '../api/endpoints';
import { useAppConfig } from '../hooks/useAppConfig';
import { useAuthStore } from '../store/auth';
import { toast } from '../store/toast';
import type { DowntimeAskConfig, DownAskType } from '../types/api';

const clone = (c: DowntimeAskConfig): DowntimeAskConfig => ({ ...c, reasons: c.reasons.map((r) => ({ label: r.label, types: [...r.types] })) });
const typesKey = (t: DownAskType[]): string => (t.includes('idle') && t.includes('stopped') ? 'both' : t[0] || 'both');
const typesOf = (k: string): DownAskType[] => (k === 'idle' ? ['idle'] : k === 'stopped' ? ['stopped'] : ['idle', 'stopped']);

function Toggle({ on, onChange, label, disabled }: { on: boolean; onChange: () => void; label: string; disabled: boolean }): JSX.Element {
  return (
    <button disabled={disabled} onClick={onChange} aria-label={label}
      className={`w-9 h-5 rounded-full transition-colors relative shrink-0 ${on ? 'bg-accent' : 'bg-line'} disabled:opacity-50`}>
      <span className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition-all ${on ? 'left-[18px]' : 'left-0.5'}`} />
    </button>
  );
}

export default function DowntimeAskSettings(): JSX.Element {
  const qc = useQueryClient();
  const can = useAuthStore((s) => s.can);
  const canEdit = can('settings', 'update');
  const { downtimeAsk, readOnly } = useAppConfig();

  const [draft, setDraft] = useState<DowntimeAskConfig | null>(null);
  const [saving, setSaving] = useState(false);
  const [newReason, setNewReason] = useState('');

  useEffect(() => { if (!draft && downtimeAsk) setDraft(clone(downtimeAsk)); }, [draft, downtimeAsk]);
  if (!draft) return <div className="card p-4 text-sm text-steel">Loading downtime popup settings…</div>;

  const dirty = JSON.stringify(draft) !== JSON.stringify(downtimeAsk);
  const patch = (fn: (d: DowntimeAskConfig) => void): void => { const next = clone(draft); fn(next); setDraft(next); };
  const move = (i: number, dir: -1 | 1): void => patch((d) => {
    const j = i + dir;
    if (j < 0 || j >= d.reasons.length) return;
    [d.reasons[i], d.reasons[j]] = [d.reasons[j], d.reasons[i]];
  });
  const addReason = (): void => {
    const l = newReason.trim();
    if (!l) return;
    if (draft.reasons.length >= 30) { toast.error('At most 30 reasons'); return; }
    if (draft.reasons.some((r) => r.label.toLowerCase() === l.toLowerCase())) { toast.error(`"${l}" already exists`); return; }
    patch((d) => { d.reasons.push({ label: l, types: ['idle', 'stopped'] }); });
    setNewReason('');
  };

  const save = async (): Promise<void> => {
    setSaving(true);
    try {
      await configApi.update({ downtimeAsk: draft });
      await qc.invalidateQueries({ queryKey: ['app-config'] });
      setDraft(null);   // re-seed from the server's normalized copy
      toast.success('Downtime popup rules saved');
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
          <span className="w-8 h-8 rounded-lg bg-accent/10 flex items-center justify-center"><PauseCircle size={16} className="text-accent" /></span>
          <div>
            <h3 className="font-semibold text-primary text-sm">Downtime reason popup</h3>
            <p className="text-xs text-steel">A machine idle or stopped for too long asks its operator why. The answer shows on the Downtime page and in the History Log.</p>
          </div>
        </div>
        {dirty && (
          <div className="flex items-center gap-2">
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

      <div className="mt-4 grid sm:grid-cols-2 lg:grid-cols-4 gap-3">
        <label className="flex items-center justify-between gap-2 rounded-xl border border-line px-3 py-2.5">
          <span className="text-xs font-medium text-primary">Popup</span>
          <Toggle on={draft.enabled} disabled={dis} onChange={() => patch((d) => { d.enabled = !d.enabled; })} label="Toggle downtime popup" />
        </label>
        <label className="flex items-center justify-between gap-2 rounded-xl border border-line px-3 py-2.5" title="How long a machine must be idle or stopped before its operator is asked">
          <span className="text-xs font-medium text-primary">Ask after</span>
          <span className="flex items-center gap-1.5">
            <input type="number" min={1} max={240} value={draft.askAfterMin} disabled={dis}
              onChange={(e) => patch((d) => { d.askAfterMin = Number(e.target.value); })}
              className={`${inputCls} w-20 data text-right`} />
            <span className="text-xs text-steel">min</span>
          </span>
        </label>
        <label className="flex items-center justify-between gap-2 rounded-xl border border-line px-3 py-2.5" title="0 = the popup stays until answered">
          <span className="text-xs font-medium text-primary">Popup duration</span>
          <span className="flex items-center gap-1.5">
            <input type="number" min={0} max={3600} step={10} value={draft.timeoutSec} disabled={dis}
              onChange={(e) => patch((d) => { d.timeoutSec = Number(e.target.value); })}
              className={`${inputCls} w-20 data text-right`} />
            <span className="text-xs text-steel">{draft.timeoutSec > 0 ? 'sec' : 'waits'}</span>
          </span>
        </label>
        <div className="flex items-center justify-between gap-2 rounded-xl border border-line px-3 py-2.5">
          <span className="text-xs font-medium text-primary">Ask when</span>
          <span className="flex items-center gap-3 text-xs text-primary">
            <label className="inline-flex items-center gap-1.5"><input type="checkbox" checked={draft.askIdle} disabled={dis} onChange={() => patch((d) => { d.askIdle = !d.askIdle; })} className="w-4 h-4" style={{ accentColor: 'rgb(var(--c-accent, 13 148 136))' }} /> Idle</label>
            <label className="inline-flex items-center gap-1.5"><input type="checkbox" checked={draft.askStopped} disabled={dis} onChange={() => patch((d) => { d.askStopped = !d.askStopped; })} className="w-4 h-4" style={{ accentColor: 'rgb(var(--c-accent, 13 148 136))' }} /> Stopped</label>
          </span>
        </div>
      </div>

      <div className="mt-3 rounded-xl border border-line overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-base/60">
            <tr className="text-steel">
              <th className="text-left label px-3 py-2">Reason</th>
              <th className="text-left label px-3 py-2">Offered when</th>
              <th className="text-right label px-3 py-2">Order</th>
            </tr>
          </thead>
          <tbody>
            {draft.reasons.length === 0 && (
              <tr><td colSpan={3} className="px-3 py-3 text-xs text-steel">No reasons yet — operators will type their own.</td></tr>
            )}
            {draft.reasons.map((r, i) => (
              <tr key={i} className="border-t border-line">
                <td className="px-3 py-2">
                  <input value={r.label} disabled={dis} maxLength={60}
                    onChange={(e) => patch((d) => { d.reasons[i].label = e.target.value; })}
                    className={`${inputCls} w-full max-w-[260px]`} />
                </td>
                <td className="px-3 py-2">
                  <select value={typesKey(r.types)} disabled={dis}
                    onChange={(e) => patch((d) => { d.reasons[i].types = typesOf(e.target.value); })} className={inputCls}>
                    <option value="both">Idle & Stopped</option>
                    <option value="idle">Idle only</option>
                    <option value="stopped">Stopped only</option>
                  </select>
                </td>
                <td className="px-3 py-2 text-right whitespace-nowrap">
                  <button disabled={dis || i === 0} onClick={() => move(i, -1)} className="p-1 text-steel hover:text-accent disabled:opacity-30" aria-label="Move up"><ArrowUp size={14} /></button>
                  <button disabled={dis || i === draft.reasons.length - 1} onClick={() => move(i, 1)} className="p-1 text-steel hover:text-accent disabled:opacity-30" aria-label="Move down"><ArrowDown size={14} /></button>
                  <button disabled={dis} onClick={() => patch((d) => { d.reasons.splice(i, 1); })}
                    className="p-1 text-steel hover:text-stopped disabled:opacity-30" aria-label={`Remove ${r.label}`} title="Remove this reason"><X size={14} /></button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="flex gap-2 px-3 py-2 border-t border-line bg-base/40">
          <input value={newReason} disabled={dis} maxLength={60} onChange={(e) => setNewReason(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addReason(); } }}
            placeholder="New reason — e.g. Crane not available" className={`${inputCls} flex-1`} />
          <button disabled={dis || !newReason.trim() || draft.reasons.length >= 30} onClick={addReason}
            className="inline-flex items-center gap-1 text-sm px-3 py-1.5 rounded-lg border border-accent/30 text-accent bg-accent/5 hover:bg-accent/10 disabled:opacity-50"><Plus size={14} /> Add reason</button>
        </div>
      </div>

      <label className="mt-3 flex items-center justify-between gap-2 rounded-xl border border-line px-3 py-2.5">
        <span className="text-xs font-medium text-primary">Operators may type another reason</span>
        <Toggle on={draft.allowCustom} disabled={dis} onChange={() => patch((d) => { d.allowCustom = !d.allowCustom; })} label="Toggle free-text reasons" />
      </label>

      <p className="text-[11px] text-steel mt-3">
        The popup appears on the operator's screen once one of their machines has been idle or stopped for the ask-after time — also for a span that already ended, if it lasted that long and ended within the last two hours.
        Popup duration 0 keeps it on screen until answered; with a countdown, an unanswered span is left without a reason and can still get one on the Downtime page.
        Renaming or removing a reason changes future popups only — recorded reasons keep their words.
      </p>
    </div>
  );
}
