// client/src/components/DeleteEmployeeModal.tsx
// Two-step delete flow for an employee:
//   1. Choose a method — Temporary (suspend) or Permanent (terminate).
//   2a. Temporary → window (quick durations or custom range) + reason; auto-restores.
//   2b. Permanent → confirm + optional reason. Kept only as a history tombstone.
import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { Clock, Trash2, AlertTriangle, ArrowLeft } from 'lucide-react';
import Modal from './Modal';
import { userApi } from '../api/endpoints';

interface EmployeeRef { id: string; name: string; email: string }

const toInput = (d: Date): string => {
  const local = new Date(d.getTime() - d.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 10);
};
const PRESETS: { key: string; label: string; add: (d: Date) => void }[] = [
  { key: '7d',  label: '1 week',   add: (d) => d.setDate(d.getDate() + 7) },
  { key: '14d', label: '2 weeks',  add: (d) => d.setDate(d.getDate() + 14) },
  { key: '1m',  label: '1 month',  add: (d) => d.setMonth(d.getMonth() + 1) },
  { key: '3m',  label: '3 months', add: (d) => d.setMonth(d.getMonth() + 3) },
];
const addPreset = (fromStr: string, key: string): string => {
  const d = new Date(`${fromStr}T00:00:00`);
  PRESETS.find((p) => p.key === key)?.add(d);
  return toInput(d);
};

export default function DeleteEmployeeModal({ employee, onClose, onDone }: { employee: EmployeeRef; onClose: () => void; onDone: () => void }): JSX.Element {
  const today = toInput(new Date());
  const [step, setStep] = useState<'choose' | 'temporary' | 'permanent'>('choose');
  const [preset, setPreset] = useState('1m');
  const [from, setFrom] = useState(today);
  const [until, setUntil] = useState(addPreset(today, '1m'));
  const [tempReason, setTempReason] = useState('');
  const [permReason, setPermReason] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [error, setError] = useState('');

  const choosePreset = (key: string) => { setPreset(key); if (key !== 'custom') setUntil(addPreset(from, key)); };
  const onFromChange = (v: string) => { setFrom(v); if (preset !== 'custom') setUntil(addPreset(v, preset)); };

  const mut = useMutation({
    mutationFn: (body: { type: string; reason?: string; from?: string; until?: string }) => userApi.deleteEmployee(employee.id, body),
    onSuccess: () => onDone(),
    onError: (e: unknown) => setError((e as { message?: string })?.message || 'Something went wrong'),
  });

  const submitTemporary = () => {
    setError('');
    if (!from || !until) return setError('Please choose a start and end date');
    if (new Date(`${until}T23:59:59`) <= new Date(`${from}T00:00:00`)) return setError('End date must be after the start date');
    if (!tempReason.trim()) return setError('Please add a reason');
    mut.mutate({
      type: 'temporary',
      reason: tempReason.trim(),
      from: new Date(`${from}T00:00:00`).toISOString(),
      until: new Date(`${until}T23:59:59`).toISOString(),
    });
  };
  const submitPermanent = () => {
    setError('');
    if (!confirmed) return setError('Please confirm you understand this is permanent');
    mut.mutate({ type: 'permanent', reason: permReason.trim() });
  };

  const title = step === 'choose' ? `Delete ${employee.name}` : step === 'temporary' ? 'Temporary delete' : 'Permanent delete';

  return (
    <Modal title={title} subtitle={employee.email} icon={Trash2} onClose={onClose} maxW="max-w-lg">
      {step !== 'choose' && (
        <button onClick={() => { setStep('choose'); setError(''); }} className="flex items-center gap-1.5 text-steel hover:text-primary text-sm mb-3">
          <ArrowLeft size={15} /> Back
        </button>
      )}

      {step === 'choose' && (
        <div className="space-y-3">
          <p className="text-sm text-steel">How do you want to remove <span className="text-primary font-medium">{employee.name}</span>?</p>
          <button onClick={() => setStep('temporary')} className="w-full text-left border border-line rounded-xl p-4 hover:border-accent hover:bg-accent/5 transition-colors flex gap-3">
            <span className="w-9 h-9 rounded-lg bg-idle/10 text-idle flex items-center justify-center shrink-0"><Clock size={18} /></span>
            <span>
              <span className="block text-sm font-medium text-primary">Temporary delete</span>
              <span className="block text-xs text-steel mt-0.5">Suspend for a chosen period with a reason. Auto-restores when the window ends; visible in Employee History.</span>
            </span>
          </button>
          <button onClick={() => setStep('permanent')} className="w-full text-left border border-line rounded-xl p-4 hover:border-stopped hover:bg-stopped/5 transition-colors flex gap-3">
            <span className="w-9 h-9 rounded-lg bg-stopped/10 text-stopped flex items-center justify-center shrink-0"><Trash2 size={18} /></span>
            <span>
              <span className="block text-sm font-medium text-primary">Permanent delete</span>
              <span className="block text-xs text-steel mt-0.5">Remove the employee for good. Cannot be restored — kept only as a record in Employee History.</span>
            </span>
          </button>
        </div>
      )}

      {step === 'temporary' && (
        <div className="space-y-4">
          <div>
            <div className="label mb-1.5">Duration</div>
            <div className="flex flex-wrap gap-2">
              {PRESETS.map((p) => (
                <button key={p.key} type="button" onClick={() => choosePreset(p.key)}
                  className={`px-3 py-1.5 rounded-lg text-xs transition-colors ${preset === p.key ? 'bg-accent/10 text-accent font-medium' : 'text-steel border border-line hover:bg-base'}`}>{p.label}</button>
              ))}
              <button type="button" onClick={() => choosePreset('custom')}
                className={`px-3 py-1.5 rounded-lg text-xs transition-colors ${preset === 'custom' ? 'bg-accent/10 text-accent font-medium' : 'text-steel border border-line hover:bg-base'}`}>Custom</button>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div><div className="label mb-1.5">From</div><input type="date" className="input" value={from} onChange={(e) => onFromChange(e.target.value)} /></div>
            <div><div className="label mb-1.5">Until</div><input type="date" className="input" value={until} min={from} onChange={(e) => { setPreset('custom'); setUntil(e.target.value); }} /></div>
          </div>
          <div>
            <div className="label mb-1.5">Reason <span className="text-stopped">*</span></div>
            <textarea className="input resize-none" rows={3} value={tempReason} onChange={(e) => setTempReason(e.target.value)} placeholder="Why is this employee being suspended?" />
          </div>
          {error && <div className="text-sm text-stopped bg-stopped/10 border border-stopped/15 rounded-lg px-3 py-2">{error}</div>}
          <div className="flex gap-2 justify-end pt-1">
            <button type="button" onClick={onClose} className="px-4 py-2 rounded-lg border border-line text-sm text-steel hover:bg-base">Cancel</button>
            <button onClick={submitTemporary} disabled={mut.isPending} className="px-4 py-2 rounded-lg bg-idle text-white text-sm font-medium hover:bg-idle/90 disabled:opacity-60">{mut.isPending ? 'Saving…' : 'Suspend employee'}</button>
          </div>
        </div>
      )}

      {step === 'permanent' && (
        <div className="space-y-4">
          <div className="flex gap-2.5 text-sm bg-stopped/10 border border-stopped/20 text-stopped rounded-lg px-3 py-2.5">
            <AlertTriangle size={16} className="shrink-0 mt-0.5" />
            <span>This permanently removes <span className="font-medium">{employee.name}</span> from the active roster. They cannot sign in again and it cannot be undone.</span>
          </div>
          <div>
            <div className="label mb-1.5">Reason (optional)</div>
            <textarea className="input resize-none" rows={3} value={permReason} onChange={(e) => setPermReason(e.target.value)} placeholder="Why is this employee being removed?" />
          </div>
          <label className="flex items-start gap-2 text-sm text-primary cursor-pointer">
            <input type="checkbox" className="mt-0.5 accent-accent" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />
            I understand this permanently deletes {employee.name}.
          </label>
          {error && <div className="text-sm text-stopped bg-stopped/10 border border-stopped/15 rounded-lg px-3 py-2">{error}</div>}
          <div className="flex gap-2 justify-end pt-1">
            <button type="button" onClick={onClose} className="px-4 py-2 rounded-lg border border-line text-sm text-steel hover:bg-base">Cancel</button>
            <button onClick={submitPermanent} disabled={mut.isPending} className="px-4 py-2 rounded-lg bg-stopped text-white text-sm font-medium hover:bg-stopped/90 disabled:opacity-60">{mut.isPending ? 'Deleting…' : 'Delete permanently'}</button>
          </div>
        </div>
      )}
    </Modal>
  );
}
