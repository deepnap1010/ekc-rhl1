// client/src/components/machine/CorrectionBook.tsx
// The error-correction book: say what a machine really did over a period —
// the state it was in, the pieces it made — when the telemetry got it wrong
// or was not there (the collector started at noon; the machine had been
// running since seven with 50 pieces on the floor). The recorded data is
// never edited: a correction is written beside it, signed, and every figure
// that overlaps the period reads the correction instead. A wrong correction
// is revoked, not deleted.
//
// One component, two homes: Settings → Error correction (pick the machine,
// see the whole book) and a machine card's Correct button (the machine and
// its window come fixed). Only roles the admin gave the `corrections` module
// reach either (view the book, create, delete = revoke).
import { useMemo, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Undo2 } from 'lucide-react';
import { correctionApi, machineApi } from '../../api/endpoints';
import { useAuthStore } from '../../store/auth';
import { useAppConfig } from '../../hooks/useAppConfig';
import { useMachineName } from '../../lib/machineName';
import { toast } from '../../store/toast';
import { fmtNum, fmtTime } from '../../lib/format';
import type { MachineCorrection } from '../../types/api';

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
const DAY_MS = 86_400_000;
const MIN_MS = 60_000;

// Durations are typed the way the card shows them: "4h 10m", "4:10", "250"
// (minutes) all mean the same thing; '' means nothing said.
const parseDur = (s: string): number | null => {
  const t = s.trim().toLowerCase();
  if (!t) return 0;
  let m = t.match(/^(\d+)\s*:\s*(\d{1,2})$/);
  if (m) return (Number(m[1]) * 60 + Number(m[2])) * MIN_MS;
  m = t.match(/^(?:(\d+(?:\.\d+)?)\s*h)?\s*(?:(\d+)\s*m(?:in)?)?$/);
  if (m && (m[1] || m[2])) return Math.round((Number(m[1] || 0) * 60 + Number(m[2] || 0)) * MIN_MS);
  if (/^\d+(\.\d+)?$/.test(t)) return Math.round(Number(t) * MIN_MS);
  return null;
};
const fmtDur = (ms: number): string => {
  const min = Math.round(ms / MIN_MS);
  return min >= 60 ? `${Math.floor(min / 60)}h ${String(min % 60).padStart(2, '0')}m` : `${min}m`;
};
/** "4h 10m run · 35m idle · 15m stopped" — or the older whole-period state. */
const describeTime = (c: MachineCorrection): string => {
  if (c.time) {
    const parts = [[c.time.runningMs, 'run'], [c.time.idleMs, 'idle'], [c.time.stoppedMs, 'stopped']] as [number, string][];
    return parts.filter(([ms]) => ms > 0).map(([ms, l]) => `${fmtDur(ms)} ${l}`).join(' · ') || 'as recorded';
  }
  return c.state ? `all ${c.state}` : 'as recorded';
};
const TILES: { key: 'running' | 'idle' | 'stopped'; label: string; color: string }[] = [
  { key: 'running', label: 'Running (uptime)', color: '#0D9488' },
  { key: 'idle', label: 'Idle', color: '#D97706' },
  { key: 'stopped', label: 'Stopped', color: '#DC2626' },
];

export default function CorrectionBook({ machine, from, to, onRecorded }: {
  machine?: { code: string; name: string };   // fixed (a card's button) — otherwise pick one
  from?: string; to?: string;                  // the default period (a card's window)
  onRecorded?: () => void;
}): JSX.Element {
  const qc = useQueryClient();
  const can = useAuthStore((s) => s.can);
  const mName = useMachineName();
  const { downtimeAsk, readOnly } = useAppConfig();
  const canView = can('corrections', 'view');
  const canCreate = can('corrections', 'create') && !readOnly;
  const canRevoke = can('corrections', 'delete') && !readOnly;
  const now = Date.now();

  // The machines in this person's scope, for the picker.
  const { data: machines } = useQuery({
    queryKey: ['machines', 'book'],
    queryFn: () => machineApi.list({ limit: 200 }).then((r) => r.data),
    enabled: !machine,
    staleTime: 60_000,
  });
  const options = useMemo(() => (machines || [])
    .map((m) => String(m.code || m._id))
    .filter(Boolean)
    .map((code) => ({ code, name: mName(code) }))
    .sort((a, b) => a.name.localeCompare(b.name)), [machines, mName]);
  const [picked, setPicked] = useState('');
  const code = machine?.code ?? picked;
  const name = machine?.name ?? (code ? mName(code) : '');

  const [form, setForm] = useState({
    from: toLocalInput(from ?? new Date(new Date().setHours(0, 0, 0, 0))),
    to: toLocalInput(Math.min(to ? new Date(to).getTime() : now, now)),
    running: '', idle: '', stopped: '',   // the card's tiles, as amounts for the period
    pieces: '',
    downtimeReason: '',
    reason: '',
  });
  const [error, setError] = useState('');
  const set = <K extends keyof typeof form>(k: K, v: (typeof form)[K]): void => setForm((f) => ({ ...f, [k]: v }));

  // The period's length, what the three amounts add up to, and what is left
  // — shown live, because the remainder is booked as signal lost.
  const fromT = fromLocalInput(form.from) ? new Date(form.from).getTime() : null;
  const toT = fromLocalInput(form.to) ? new Date(form.to).getTime() : null;
  const periodMs = fromT != null && toT != null ? Math.max(0, toT - fromT) : 0;   // unknown until both ends are typed
  const amounts = { running: parseDur(form.running), idle: parseDur(form.idle), stopped: parseDur(form.stopped) };
  const badDur = Object.values(amounts).some((v) => v === null);
  const saidMs = (amounts.running || 0) + (amounts.idle || 0) + (amounts.stopped || 0);
  const leftMs = periodMs - saidMs;
  const fillAll = (key: 'running' | 'idle' | 'stopped'): void => {
    const whole = fmtDur(periodMs);
    setForm((f) => ({ ...f, running: key === 'running' ? whole : '', idle: key === 'idle' ? whole : '', stopped: key === 'stopped' ? whole : '' }));
  };
  const hasDown = (amounts.idle || 0) + (amounts.stopped || 0) > 0;

  // The book — this machine's, or everything in scope — last 30 days,
  // revoked rows included (greyed).
  const since = useMemo(() => new Date(now - 30 * DAY_MS).toISOString(), [now]);
  const { data: book } = useQuery({
    queryKey: ['corrections', code || 'all'],
    queryFn: () => correctionApi.list({ machineId: code || undefined, from: since, revoked: '1' }).then((r) => r.data),
    enabled: canView,
  });

  // Every cached figure that overlaps the period is stale now: cards, bars,
  // reports, targets. One sweep is simpler than naming each key — minus the
  // per-card sparkline stats, which a correction does not touch and which
  // would be one request per card.
  const refresh = (): Promise<void> => qc.invalidateQueries({ predicate: (q) => q.queryKey[0] !== 'machine-stats' });
  const create = useMutation({
    mutationFn: () => {
      if (!code) throw new Error('Pick the machine');
      const f = fromLocalInput(form.from), t = fromLocalInput(form.to);
      if (!f || !t) throw new Error('Enter the period as date and time');
      const pieces = form.pieces.trim() === '' ? null : Number(form.pieces);
      if (pieces !== null && (!Number.isInteger(pieces) || pieces < 0)) throw new Error('Pieces must be a whole number');
      if (badDur) throw new Error('Durations read like "4h 10m", "4:10" or minutes ("250")');
      if (saidMs > periodMs + MIN_MS) throw new Error(`Running + idle + stopped (${fmtDur(saidMs)}) is longer than the period (${fmtDur(periodMs)})`);
      const time = saidMs > 0 ? { runningMs: amounts.running || 0, idleMs: amounts.idle || 0, stoppedMs: amounts.stopped || 0 } : null;
      if (!time && pieces === null) throw new Error('Say how the period\'s time went, how many pieces it made, or both');
      if (form.reason.trim().length < 3) throw new Error('Say why this correction is needed (at least 3 characters)');
      return correctionApi.create({
        machineRef: code, from: f, to: t, time, pieces,
        downtimeReason: hasDown ? form.downtimeReason : '', reason: form.reason.trim(),
      });
    },
    onSuccess: async () => {
      await refresh();
      toast.success(`${name}: correction recorded`);
      setForm((f) => ({ ...f, pieces: '', reason: '', running: '', idle: '', stopped: '', downtimeReason: '' }));
      onRecorded?.();
    },
    onError: (e: unknown) => setError(e instanceof Error ? e.message : 'Could not record the correction'),
  });
  const revoke = useMutation({
    mutationFn: (c: MachineCorrection) => {
      const why = window.prompt(`Revoke the correction for ${mName(c.machineRef)}, ${fmtTime(c.from)} → ${fmtTime(c.to)}? The recorded data applies again. Reason (optional):`);
      if (why === null) throw new Error('cancelled');
      return correctionApi.revoke(c._id, why);
    },
    onSuccess: async () => { await refresh(); toast.success('Correction revoked'); },
    onError: (e: unknown) => { if (!(e instanceof Error && e.message === 'cancelled')) toast.error(e instanceof Error ? e.message : 'Could not revoke'); },
  });

  const reasons = (downtimeAsk?.reasons || []).map((r) => r.label);
  const inputCls = 'bg-base border border-line rounded-lg px-2.5 py-1.5 text-sm text-primary outline-none focus:border-accent disabled:opacity-60';

  return (
    <div className="space-y-5">
      {canCreate ? (
        <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); setError(''); create.mutate(); }}>
          {!machine && (
            <label className="block">
              <span className="label block mb-1">Machine</span>
              <select value={picked} onChange={(e) => setPicked(e.target.value)} className={`${inputCls} w-full`} required>
                <option value="">— pick the machine —</option>
                {options.map((o) => <option key={o.code} value={o.code}>{o.name}{o.name !== o.code ? ` · ${o.code}` : ''}</option>)}
              </select>
            </label>
          )}
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
            <div className="flex items-baseline justify-between gap-3 mb-1.5">
              <span className="label">How the period's time really went{periodMs > 0 ? ` — ${fmtDur(periodMs)} in all` : ''}</span>
              <span className="flex items-center gap-1 text-[11px] text-steel">
                whole period:
                {TILES.map((t) => (
                  <button key={t.key} type="button" onClick={() => fillAll(t.key)} disabled={!periodMs}
                    className="px-1.5 py-0.5 rounded border border-line hover:border-accent/40 hover:text-accent disabled:opacity-50">{t.label.split(' ')[0].toLowerCase()}</button>
                ))}
                <button type="button" onClick={() => setForm((f) => ({ ...f, running: '', idle: '', stopped: '' }))} className="px-1.5 py-0.5 rounded border border-line hover:text-primary">as recorded</button>
              </span>
            </div>
            <div className="grid grid-cols-3 gap-2">
              {TILES.map((t) => (
                <label key={t.key} className="block rounded-xl border border-line px-3 py-2">
                  <span className="text-[10px] uppercase tracking-wide font-semibold" style={{ color: t.color }}>{t.label}</span>
                  <input value={form[t.key]} onChange={(e) => set(t.key, e.target.value)} placeholder="e.g. 4h 10m" inputMode="text"
                    className={`${inputCls} w-full mt-1 data`} />
                </label>
              ))}
            </div>
            <div className={`text-[11px] mt-1 ${badDur || saidMs > periodMs + MIN_MS ? 'text-stopped' : 'text-steel'}`}>
              {badDur ? 'Durations read like "4h 10m", "4:10" or minutes ("250").'
                : saidMs === 0 ? 'Leave all three empty to keep the recorded time; fill them to replace it for this period.'
                  : saidMs > periodMs + MIN_MS ? `That is ${fmtDur(saidMs - periodMs)} more than the period holds.`
                    : leftMs >= MIN_MS ? `${fmtDur(leftMs)} of the period is unaccounted for — it will count as signal lost.`
                      : 'The whole period is accounted for.'}
            </div>
          </div>

          {hasDown && (
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
            <span className="text-[11px] text-steel">Only the period you name changes; time and pieces outside it stay as recorded. Two corrections cannot overlap — revoke one to replace it.</span>
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
        <div className="label mb-1.5">{machine ? `Corrections for ${machine.name} — last 30 days` : `The book${code ? ` — ${name}` : ' — every machine you can see'}, last 30 days`}</div>
        {!canView ? (
          <div className="text-xs text-steel">Your role may write corrections but not read the book — an overlap with an existing one is refused on save.</div>
        ) : !book?.length ? (
          <div className="text-xs text-steel">None. Every figure shown {machine ? `for ${machine.name}` : ''} is what the machines recorded.</div>
        ) : (
          <div className="rounded-xl border border-line overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="bg-base/60 text-steel">
                <tr>
                  {!machine && <th className="text-left label px-3 py-1.5">Machine</th>}
                  <th className="text-left label px-3 py-1.5">Period</th><th className="text-left label px-3 py-1.5">Time</th><th className="text-right label px-3 py-1.5">Pieces</th>
                  <th className="text-left label px-3 py-1.5">Why</th><th className="text-left label px-3 py-1.5">By</th><th className="px-3 py-1.5" />
                </tr>
              </thead>
              <tbody>
                {book.map((c) => (
                  <tr key={c._id} className={`border-t border-line ${c.revokedAt ? 'text-steel/60 line-through' : 'text-primary'}`}>
                    {!machine && <td className="px-3 py-1.5 whitespace-nowrap font-medium">{mName(c.machineRef)}</td>}
                    <td className="px-3 py-1.5 whitespace-nowrap data">{fmtTime(c.from)} → {fmtTime(c.to)}</td>
                    <td className="px-3 py-1.5 whitespace-nowrap">{describeTime(c)}{c.downtimeReason ? ` · ${c.downtimeReason}` : ''}</td>
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
  );
}
