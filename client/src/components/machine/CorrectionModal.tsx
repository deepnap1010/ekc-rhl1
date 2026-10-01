// client/src/components/machine/CorrectionModal.tsx
// The error-correction book, for one machine: say what it really did over a
// period — the state it was in, the pieces it made — when the telemetry got
// it wrong or was not there (the collector started at noon; the machine had
// been running since seven with 50 pieces on the floor). The recorded data
// is never edited: a correction is written beside it, signed, and every
// figure that overlaps the period reads the correction instead. A wrong
// correction is revoked, not deleted.
//
// Only roles the admin gave the `corrections` module reach this (view the
// book, create, delete = revoke) — Roles & Permissions, like any module.
import { useMemo, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Wrench, Undo2 } from 'lucide-react';
import Modal from '../Modal';
import { correctionApi } from '../../api/endpoints';
import { useAuthStore } from '../../store/auth';
import { useAppConfig } from '../../hooks/useAppConfig';
import { toast } from '../../store/toast';
import { fmtNum, fmtTime } from '../../lib/format';
import type { CorrectionState, MachineCorrection } from '../../types/api';

// <input type="datetime-local"> speaks local wall-clock time without a zone.
const toLocalInput = (iso: string | number | Date): string => {
  const d = new Date(iso);
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
};
const fromLocalInput = (s: string): string | null => {
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};
const STATES: { value: '' | CorrectionState; label: string; hint: string }[] = [
  { value: '', label: 'As recorded', hint: 'Leave the running / idle / stopped time as the telemetry has it' },
  { value: 'running', label: 'Running', hint: 'The whole period counts as running' },
  { value: 'idle', label: 'Idle', hint: 'The whole period counts as idle' },
  { value: 'stopped', label: 'Stopped', hint: 'The whole period counts as stopped' },
];

export default function CorrectionModal({ code, name, from, to, onClose }: {
  code: string; name: string;
  from: string; to: string;    // the window the card was showing — the default period
  onClose: () => void;
}): JSX.Element {
  const qc = useQueryClient();
  const can = useAuthStore((s) => s.can);
  const { downtimeAsk, readOnly } = useAppConfig();
  const canCreate = can('corrections', 'create') && !readOnly;
  const canRevoke = can('corrections', 'delete') && !readOnly;
  const now = Date.now();
  const [form, setForm] = useState({
    from: toLocalInput(from),
    to: toLocalInput(Math.min(new Date(to).getTime(), now)),
    state: '' as '' | CorrectionState,
    pieces: '',
    downtimeReason: '',
    reason: '',
  });
  const [error, setError] = useState('');
  const set = <K extends keyof typeof form>(k: K, v: (typeof form)[K]): void => setForm((f) => ({ ...f, [k]: v }));

  // The book for this machine, last 30 days (revoked rows included, greyed).
  const since = useMemo(() => new Date(now - 30 * 86_400_000).toISOString(), [now]);
  const { data: book } = useQuery({
    queryKey: ['corrections', code],
    queryFn: () => correctionApi.list({ machineId: code, from: since, revoked: '1' }).then((r) => r.data),
    enabled: can('corrections', 'view'),
  });

  // Every cached figure that overlaps the period is stale now: cards, bars,
  // reports, targets. One sweep is simpler than naming each key — minus the
  // per-card sparkline stats, which a correction does not touch and which
  // would be one request per card.
  const refresh = (): Promise<void> => qc.invalidateQueries({ predicate: (q) => q.queryKey[0] !== 'machine-stats' });
  const create = useMutation({
    mutationFn: () => {
      const f = fromLocalInput(form.from), t = fromLocalInput(form.to);
      if (!f || !t) throw new Error('Enter the period as date and time');
      const pieces = form.pieces.trim() === '' ? null : Number(form.pieces);
      if (pieces !== null && (!Number.isInteger(pieces) || pieces < 0)) throw new Error('Pieces must be a whole number');
      if (!form.state && pieces === null) throw new Error('Say what the machine was doing, how many pieces it made, or both');
      if (form.reason.trim().length < 3) throw new Error('Say why this correction is needed (at least 3 characters)');
      return correctionApi.create({
        machineRef: code, from: f, to: t, state: form.state || null, pieces,
        downtimeReason: form.state === 'idle' || form.state === 'stopped' ? form.downtimeReason : '', reason: form.reason.trim(),
      });
    },
    onSuccess: async () => { await refresh(); toast.success(`${name}: correction recorded`); onClose(); },
    onError: (e: unknown) => setError(e instanceof Error ? e.message : 'Could not record the correction'),
  });
  const revoke = useMutation({
    mutationFn: (c: MachineCorrection) => {
      const why = window.prompt(`Revoke the correction for ${fmtTime(c.from)} → ${fmtTime(c.to)}? The recorded data applies again. Reason (optional):`);
      if (why === null) throw new Error('cancelled');
      return correctionApi.revoke(c._id, why);
    },
    onSuccess: async () => { await refresh(); toast.success('Correction revoked'); },
    onError: (e: unknown) => { if (!(e instanceof Error && e.message === 'cancelled')) toast.error(e instanceof Error ? e.message : 'Could not revoke'); },
  });

  const reasons = (downtimeAsk?.reasons || []).map((r) => r.label);
  const inputCls = 'bg-base border border-line rounded-lg px-2.5 py-1.5 text-sm text-primary outline-none focus:border-accent disabled:opacity-60';

  return (
    <Modal title={`Correct ${name}`} subtitle="What this machine really did — the recorded data stays, the correction is written beside it" icon={Wrench} onClose={onClose} maxW="max-w-2xl">
      <div className="space-y-5">
        {canCreate ? (
          <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); setError(''); create.mutate(); }}>
            <div className="grid sm:grid-cols-2 gap-3">
              <label className="block">
                <span className="label block mb-1">Period from</span>
                <input type="datetime-local" value={form.from} max={toLocalInput(now)} onChange={(e) => set('from', e.target.value)} className={`${inputCls} w-full`} required />
              </label>
              <label className="block">
                <span className="label block mb-1">to</span>
                <input type="datetime-local" value={form.to} max={toLocalInput(now)} onChange={(e) => set('to', e.target.value)} className={`${inputCls} w-full`} required />
              </label>
            </div>

            <div>
              <span className="label block mb-1.5">In that period the machine was</span>
              <div className="inline-flex rounded-lg border border-line overflow-hidden">
                {STATES.map((s) => (
                  <button key={s.value} type="button" title={s.hint} onClick={() => set('state', s.value)}
                    className={`px-3 py-1.5 text-sm font-medium transition-colors ${form.state === s.value ? 'bg-accent text-white' : 'text-steel hover:text-primary'}`}>
                    {s.label}
                  </button>
                ))}
              </div>
            </div>

            {(form.state === 'idle' || form.state === 'stopped') && (
              <label className="block">
                <span className="label block mb-1">Downtime reason (how the review sheets file it)</span>
                <input list="correction-reasons" value={form.downtimeReason} maxLength={60} onChange={(e) => set('downtimeReason', e.target.value)}
                  placeholder={reasons[0] ? `e.g. ${reasons[0]}` : 'e.g. No Power'} className={`${inputCls} w-full`} />
                <datalist id="correction-reasons">{reasons.map((r) => <option key={r} value={r} />)}</datalist>
              </label>
            )}

            <label className="block">
              <span className="label block mb-1">Pieces made in that period</span>
              <input type="number" min={0} step={1} value={form.pieces} onChange={(e) => set('pieces', e.target.value)}
                placeholder="leave empty to keep the recorded count" className={`${inputCls} w-full data`} />
              <span className="text-[11px] text-steel">The number replaces whatever was counted inside the period — e.g. the 50 pieces made before the collector started. Counting continues from the telemetry after it.</span>
            </label>

            <label className="block">
              <span className="label block mb-1">Why this correction <span className="text-stopped">*</span></span>
              <textarea value={form.reason} rows={2} maxLength={200} onChange={(e) => set('reason', e.target.value)}
                placeholder="e.g. Kontrolix started at 12:10; machine ran from 07:00 with 50 pieces made" className={`${inputCls} w-full resize-none`} required />
            </label>

            {error && <div className="text-sm text-stopped bg-stopped/8 border border-stopped/15 rounded-lg px-3 py-2">{error}</div>}
            <div className="flex items-center justify-between gap-3">
              <span className="text-[11px] text-steel">Only the period you name changes. An hour that was 40 min running and 20 min idle is two corrections, one after the other. Two corrections cannot overlap — revoke one to replace it.</span>
              <button type="submit" disabled={create.isPending} className="shrink-0 px-4 py-2 rounded-lg bg-accent text-white text-sm font-medium hover:bg-accent/90 disabled:opacity-60">
                {create.isPending ? 'Recording…' : 'Record correction'}
              </button>
            </div>
          </form>
        ) : (
          <div className="text-xs text-steel bg-base border border-line rounded-lg px-3 py-2">
            {readOnly ? 'This is the review copy — corrections are made on the plant server.' : 'Your role may read the correction book but not write to it.'}
          </div>
        )}

        <div>
          <div className="label mb-1.5">Corrections for this machine — last 30 days</div>
          {!can('corrections', 'view') ? (
            <div className="text-xs text-steel">Your role may write corrections but not read the book — an overlap with an existing one is refused on save.</div>
          ) : !book?.length ? (
            <div className="text-xs text-steel">None. Every figure shown for {name} is what it recorded.</div>
          ) : (
            <div className="rounded-xl border border-line overflow-hidden">
              <table className="w-full text-xs">
                <thead className="bg-base/60 text-steel">
                  <tr><th className="text-left label px-3 py-1.5">Period</th><th className="text-left label px-3 py-1.5">Was</th><th className="text-right label px-3 py-1.5">Pieces</th><th className="text-left label px-3 py-1.5">Why</th><th className="text-left label px-3 py-1.5">By</th><th className="px-3 py-1.5" /></tr>
                </thead>
                <tbody>
                  {book.map((c) => (
                    <tr key={c._id} className={`border-t border-line ${c.revokedAt ? 'text-steel/60 line-through' : 'text-primary'}`}>
                      <td className="px-3 py-1.5 whitespace-nowrap data">{fmtTime(c.from)} → {fmtTime(c.to)}</td>
                      <td className="px-3 py-1.5">{c.state || 'as recorded'}{c.downtimeReason ? ` · ${c.downtimeReason}` : ''}</td>
                      <td className="px-3 py-1.5 text-right data">{c.pieces == null ? '—' : fmtNum(c.pieces)}</td>
                      <td className="px-3 py-1.5 max-w-[220px] truncate" title={c.reason}>{c.reason}</td>
                      <td className="px-3 py-1.5 whitespace-nowrap">{c.createdBy?.name || ''}{c.revokedAt ? ` · revoked by ${c.revokedBy?.name || '?'}` : ''}</td>
                      <td className="px-3 py-1.5 text-right">
                        {!c.revokedAt && canRevoke && (
                          <button type="button" onClick={() => revoke.mutate(c)} disabled={revoke.isPending} title="Revoke — the recorded data applies again"
                            className="inline-flex items-center gap-1 text-steel hover:text-stopped disabled:opacity-50"><Undo2 size={12} /> Revoke</button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
}
