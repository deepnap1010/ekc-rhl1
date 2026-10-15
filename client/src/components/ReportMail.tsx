// client/src/components/ReportMail.tsx
// Reports → Email reports: the Excel workbook — the same file Export Excel
// downloads — mailed to the people the admin picks, on a schedule.
//   · the list: each email in a line — when it goes, what it covers, who gets
//     it, when it goes next and how the last one went; pause, send now, edit
//   · the editor: recipients, timing, what the report covers and the message,
//     with the server's own preview of the next three sends as you type
//   · the history: everything that went out, and what went wrong
// Sending is the server's (services/reportMail); this is its control panel.
// Seeing it needs Report emails → View; changing it, Report emails → Update.
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Mail, MailCheck, MailWarning, Send, Pencil, Trash2, History, Plus, X, Info, ArrowLeft,
  Paperclip, Loader2, CircleCheck, CircleX, Clock, Search,
} from 'lucide-react';
import Modal from './Modal';
import { reportMailApi, machineApi, userApi } from '../api/endpoints';
import { useAuthStore } from '../store/auth';
import { useAppConfig } from '../hooks/useAppConfig';
import { useMachineName } from '../lib/machineName';
import { groupMachines } from '../lib/machineOrder';
import { toast } from '../store/toast';
import type { ReportSchedule, ReportScheduleInput, ReportMailRun, ReportFrequency, ReportPeriod, ReportRunStatus } from '../types/api';

// The plant clock: every time on this screen is IST, as the server sends them.
const IST: Intl.DateTimeFormatOptions = { timeZone: 'Asia/Kolkata', hour12: false };
const whenText = (iso: string): string => new Date(iso).toLocaleString('en-IN', { ...IST, weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const stampText = (iso: string): string => new Date(iso).toLocaleString('en-IN', { ...IST, day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

// The server's own rule (utils/smtp#isEmail), so a red chip here is a refusal there.
const EMAIL_RE = /^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:".]+(\.[^\s@<>()[\]\\,;:".]+)+$/;
const isEmail = (s: string): boolean => s.length <= 254 && EMAIL_RE.test(s);

const FREQUENCIES: { value: ReportFrequency; label: string }[] = [
  { value: 'shift', label: 'After each shift' },
  { value: 'hours', label: 'Every few hours' },
  { value: 'daily', label: 'Daily' },
  { value: 'weekly', label: 'Weekly' },
  { value: 'monthly', label: 'Monthly' },
];
const EVERY_HOURS = [1, 2, 3, 4, 6, 8, 12, 24];
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const AUTO_COVERS: Record<ReportFrequency, string> = {
  shift: 'the shift that just ended',
  hours: 'the hours since the last email',
  daily: 'the previous production day',
  weekly: 'the last 7 days',
  monthly: 'the previous month',
};
const PERIODS: { value: Exclude<ReportPeriod, 'auto'>; label: string }[] = [
  { value: 'shift', label: 'The shift that just ended' },
  { value: 'hours', label: 'The last few hours' },
  { value: 'day', label: 'The previous production day' },
  { value: 'today', label: 'Today so far' },
  { value: 'week', label: 'The last 7 days' },
  { value: 'month_to_date', label: 'This month so far' },
  { value: 'month', label: 'The previous month' },
];

const BLANK: ReportScheduleInput = {
  name: '', enabled: true, to: [], cc: [],
  frequency: 'daily', everyHours: 12, time: '07:30', weekday: 1, monthDay: 1, shifts: [], delayMin: 10,
  period: 'auto', periodHours: 12, machines: [],
  subject: '', message: '', includeSummary: true, attachWorkbook: true, skipIfIdle: false,
};
/** The editable fields of a saved schedule. */
const inputOf = (s: ReportSchedule): ReportScheduleInput => Object.fromEntries(
  (Object.keys(BLANK) as (keyof ReportScheduleInput)[]).map((k) => [k, s[k] ?? BLANK[k]]),
) as unknown as ReportScheduleInput;

const errText = (e: unknown, fallback: string): string => (e instanceof Error && e.message ? e.message : fallback);

type View = { kind: 'list' } | { kind: 'edit'; schedule: ReportSchedule | null } | { kind: 'history'; schedule: ReportSchedule | null };

export function ReportMailModal({ onClose }: { onClose: () => void }): JSX.Element {
  const can = useAuthStore((s) => s.can);
  const editable = can('report_mail', 'update');
  const [view, setView] = useState<View>({ kind: 'list' });
  const { data: status } = useQuery({
    queryKey: ['report-mails', 'status'],
    queryFn: () => reportMailApi.status().then((r) => r.data),
    staleTime: 60_000,
  });
  const subtitle = view.kind === 'edit'
    ? (view.schedule ? `Editing “${view.schedule.name}”` : 'A new scheduled email')
    : view.kind === 'history'
      ? (view.schedule ? `What “${view.schedule.name}” sent` : 'Every email sent, newest first')
      : 'The Excel workbook, mailed to the people you choose, on a schedule';
  return (
    <Modal title="Email reports" subtitle={subtitle} icon={Mail} onClose={onClose} maxW="max-w-4xl">
      <div className="space-y-4">
        <MailServerBar status={status} editable={editable} />
        {view.kind === 'list' && <ScheduleList editable={editable} onEdit={(s) => setView({ kind: 'edit', schedule: s })} onHistory={(s) => setView({ kind: 'history', schedule: s })} />}
        {view.kind === 'edit' && <ScheduleEditor schedule={view.schedule} onDone={() => setView({ kind: 'list' })} />}
        {view.kind === 'history' && <RunHistory schedule={view.schedule} onBack={() => setView({ kind: 'list' })} />}
      </div>
    </Modal>
  );
}

// ── the mail server, as the admin may see it ─────────────────────────────────
function MailServerBar({ status, editable }: { status?: { configured: boolean; host: string; port: number; from: string; readOnly: boolean }; editable: boolean }): JSX.Element | null {
  const me = useAuthStore((s) => s.user);
  const [testing, setTesting] = useState(false);
  const [to, setTo] = useState('');
  useEffect(() => { if (testing && !to) setTo(me?.email || ''); }, [testing, me, to]);
  const test = useMutation({
    mutationFn: () => reportMailApi.test(to.trim()),
    onSuccess: () => { toast.success(`Test email accepted for ${to.trim()} — check the inbox (and spam)`); setTesting(false); },
    onError: (e: unknown) => toast.error(errText(e, 'The test email could not be sent')),
  });
  if (!status) return null;
  if (status.readOnly) {
    return (
      <Notice tone="info" icon={Info}>
        This is the review copy. Report emails are sent by the plant server — set them up on the plant dashboard.
      </Notice>
    );
  }
  if (!status.configured) {
    return (
      <Notice tone="warn" icon={MailWarning}>
        <span className="font-medium">Mail is not set up on the server yet.</span> You can set up emails now — they start going out
        once the server&rsquo;s mail settings (SMTP) are filled in.
      </Notice>
    );
  }
  return (
    <div className="rounded-xl border border-line bg-base px-3.5 py-2.5 flex flex-wrap items-center gap-x-3 gap-y-2">
      <MailCheck size={16} className="text-running shrink-0" />
      <div className="text-xs text-steel min-w-0 flex-1">
        Sending as <span className="font-medium text-primary">{status.from}</span> through <span className="data">{status.host}:{status.port}</span>
      </div>
      {editable && !testing && (
        <button onClick={() => setTesting(true)} className="text-xs font-medium text-accent hover:underline">Send a test email</button>
      )}
      {editable && testing && (
        <form className="flex items-center gap-1.5 w-full sm:w-auto" onSubmit={(e) => { e.preventDefault(); if (isEmail(to.trim())) test.mutate(); }}>
          <input value={to} onChange={(e) => setTo(e.target.value)} type="email" placeholder="name@company.com" autoFocus
            className="input !py-1.5 !text-xs sm:w-56" aria-label="Send the test email to" />
          <button type="submit" disabled={!isEmail(to.trim()) || test.isPending}
            className="inline-flex items-center gap-1 rounded-lg bg-accent text-white text-xs font-medium px-2.5 py-1.5 disabled:opacity-50">
            {test.isPending ? <Loader2 size={12} className="animate-spin" /> : <Send size={12} />} Send
          </button>
          <button type="button" onClick={() => setTesting(false)} className="text-steel hover:text-primary p-1" aria-label="Cancel"><X size={14} /></button>
        </form>
      )}
    </div>
  );
}

function Notice({ tone, icon: Icon, children }: { tone: 'warn' | 'info'; icon: typeof Info; children: ReactNode }): JSX.Element {
  const cls = tone === 'warn' ? 'border-idle/30 bg-idle/10 text-idle' : 'border-line bg-base text-steel';
  return (
    <div className={`rounded-xl border px-3.5 py-2.5 flex items-start gap-2.5 text-xs leading-relaxed ${cls}`}>
      <Icon size={15} className="shrink-0 mt-px" />
      <div className="text-primary/90">{children}</div>
    </div>
  );
}

// ── the list ─────────────────────────────────────────────────────────────────
function ScheduleList({ editable, onEdit, onHistory }: { editable: boolean; onEdit: (s: ReportSchedule | null) => void; onHistory: (s: ReportSchedule | null) => void }): JSX.Element {
  const { data, isLoading } = useQuery({
    queryKey: ['report-mails', 'list'],
    queryFn: () => reportMailApi.list().then((r) => r.data),
    refetchInterval: 30_000,
  });
  const rows = data || [];
  if (isLoading && !data) {
    return <div className="py-10 flex justify-center text-steel"><Loader2 size={18} className="animate-spin" /></div>;
  }
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <div className="text-sm text-steel flex-1">{rows.length ? `${rows.length} scheduled email${rows.length === 1 ? '' : 's'}` : ''}</div>
        <button onClick={() => onHistory(null)} className="inline-flex items-center gap-1.5 rounded-lg border border-line px-2.5 py-1.5 text-xs font-medium text-steel hover:text-primary hover:border-accent/30">
          <History size={13} /> History
        </button>
        {editable && (
          <button onClick={() => onEdit(null)} className="inline-flex items-center gap-1.5 rounded-lg bg-accent text-white px-3 py-1.5 text-xs font-medium hover:bg-accent/90">
            <Plus size={13} /> New email
          </button>
        )}
      </div>
      {!rows.length ? (
        <div className="rounded-xl border border-dashed border-line px-6 py-10 text-center">
          <Mail size={22} className="mx-auto text-steel/70" />
          <div className="mt-2 font-medium text-primary">No report emails yet</div>
          <p className="mt-1 text-xs text-steel max-w-sm mx-auto">
            Send the plant&rsquo;s workbook to the people who need it — after every shift, every 12 hours, each morning, or once a week.
          </p>
          {editable && (
            <button onClick={() => onEdit(null)} className="mt-4 inline-flex items-center gap-1.5 rounded-lg bg-accent text-white px-3 py-1.5 text-xs font-medium hover:bg-accent/90">
              <Plus size={13} /> Set up the first one
            </button>
          )}
        </div>
      ) : (
        <div className="space-y-2.5">
          {rows.map((s) => <ScheduleCard key={s._id} s={s} editable={editable} onEdit={() => onEdit(s)} onHistory={() => onHistory(s)} />)}
        </div>
      )}
    </div>
  );
}

const STATUS_TONE: Record<ReportRunStatus, { cls: string; icon: typeof CircleCheck; word: string }> = {
  sent: { cls: 'text-running', icon: CircleCheck, word: 'Sent' },
  failed: { cls: 'text-stopped', icon: CircleX, word: 'Failed' },
  skipped: { cls: 'text-steel', icon: Info, word: 'Skipped' },
};

function people(list: string[], max = 2): string {
  if (!list.length) return '';
  return list.length <= max ? list.join(', ') : `${list.slice(0, max).join(', ')} +${list.length - max}`;
}

function ScheduleCard({ s, editable, onEdit, onHistory }: { s: ReportSchedule; editable: boolean; onEdit: () => void; onHistory: () => void }): JSX.Element {
  const qc = useQueryClient();
  const mName = useMachineName();
  const [confirm, setConfirm] = useState<'send' | 'delete' | null>(null);
  const refresh = (): void => { void qc.invalidateQueries({ queryKey: ['report-mails'] }); };
  const toggle = useMutation({
    mutationFn: () => reportMailApi.update(s._id, { ...inputOf(s), enabled: !s.enabled }),
    onSuccess: () => { toast.success(s.enabled ? `“${s.name}” paused` : `“${s.name}” is on`); refresh(); },
    onError: (e: unknown) => toast.error(errText(e, 'Could not change it')),
  });
  const send = useMutation({
    mutationFn: () => reportMailApi.sendNow(s._id).then((r) => r.data),
    onSuccess: (r) => { if (r.status === 'sent') toast.success(r.detail); else toast.info(r.detail); setConfirm(null); refresh(); },
    onError: (e: unknown) => { toast.error(errText(e, 'It could not be sent')); setConfirm(null); refresh(); },
  });
  const remove = useMutation({
    mutationFn: () => reportMailApi.remove(s._id),
    onSuccess: () => { toast.success(`“${s.name}” deleted`); refresh(); },
    onError: (e: unknown) => toast.error(errText(e, 'Could not delete it')),
  });
  const last = s.lastRun ? STATUS_TONE[s.lastRun.status] : null;
  const everyone = [...s.to, ...s.cc];
  const scope = s.machines.length ? (s.machines.length <= 3 ? s.machines.map(mName).join(', ') : `${s.machines.length} machines`) : 'All machines';
  return (
    <div className={`rounded-xl border px-4 py-3 transition-colors ${s.enabled ? 'border-line bg-surface' : 'border-line/70 bg-base/60'}`}>
      <div className="flex items-start gap-3">
        <Switch on={s.enabled} disabled={!editable || toggle.isPending} onChange={() => toggle.mutate()} label={s.enabled ? 'Pause this email' : 'Turn this email on'} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <span className={`font-semibold text-sm ${s.enabled ? 'text-primary' : 'text-steel'}`}>{s.name}</span>
            {!s.enabled && <span className="pill bg-line text-steel">paused</span>}
            {s.describe.retrying && <span className="pill bg-idle/10 text-idle">retrying</span>}
            {s.attachWorkbook && <span className="text-steel" title="The Excel workbook is attached"><Paperclip size={12} /></span>}
          </div>
          <div className="text-xs text-steel mt-0.5">{s.describe.when} · {s.describe.covers} · {scope}</div>
          <div className="text-xs text-steel mt-0.5 truncate" title={everyone.join(', ')}>
            To {people(s.to)}{s.cc.length ? ` · Cc ${people(s.cc, 1)}` : ''}
          </div>
          <div className="mt-2 grid sm:grid-cols-2 gap-x-4 gap-y-1 text-xs">
            <div className="flex items-start gap-1.5 min-w-0">
              <Clock size={12} className="text-steel shrink-0 mt-0.5" />
              {s.enabled && s.nextRunAt ? (
                <span className="min-w-0"><span className="font-medium text-primary">Next {whenText(s.nextRunAt)}</span>
                  {s.describe.nextWindow && <span className="text-steel"> · {s.describe.nextWindow}</span>}</span>
              ) : <span className="text-steel">{s.enabled ? 'No send time — check the shift settings' : 'Paused — nothing will be sent'}</span>}
            </div>
            <div className="flex items-start gap-1.5 min-w-0">
              {last && s.lastRun ? (
                <>
                  <last.icon size={12} className={`${last.cls} shrink-0 mt-0.5`} />
                  <span className="min-w-0" title={s.lastRun.detail}>
                    <span className={`font-medium ${last.cls}`}>{last.word} {stampText(s.lastRun.at)}</span>
                    <span className="text-steel"> · {s.lastRun.detail}</span>
                  </span>
                </>
              ) : <span className="text-steel">Not sent yet</span>}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-0.5 shrink-0">
          {editable && <IconButton title="Send it now" onClick={() => setConfirm('send')}><Send size={14} /></IconButton>}
          <IconButton title="What it sent" onClick={onHistory}><History size={14} /></IconButton>
          {editable && <IconButton title="Edit" onClick={onEdit}><Pencil size={14} /></IconButton>}
          {editable && <IconButton title="Delete" onClick={() => setConfirm('delete')} danger><Trash2 size={14} /></IconButton>}
        </div>
      </div>
      {confirm && (
        <div className={`mt-3 rounded-lg border px-3 py-2 flex flex-wrap items-center gap-2 text-xs ${confirm === 'delete' ? 'border-stopped/30 bg-stopped/5' : 'border-accent/30 bg-accent/5'}`}>
          <span className="flex-1 min-w-[180px] text-primary">
            {confirm === 'send'
              ? `Send it now to ${everyone.length} ${everyone.length === 1 ? 'person' : 'people'}? It covers the period it would if it were due this minute.`
              : `Delete “${s.name}”? Nobody will get it any more. Its history stays.`}
          </span>
          <button onClick={() => setConfirm(null)} className="rounded-lg border border-line px-2.5 py-1 font-medium text-steel hover:text-primary">Cancel</button>
          {confirm === 'send' ? (
            <button onClick={() => send.mutate()} disabled={send.isPending} className="inline-flex items-center gap-1 rounded-lg bg-accent text-white px-2.5 py-1 font-medium disabled:opacity-60">
              {send.isPending ? <><Loader2 size={12} className="animate-spin" /> Building and sending…</> : <><Send size={12} /> Send now</>}
            </button>
          ) : (
            <button onClick={() => remove.mutate()} disabled={remove.isPending} className="inline-flex items-center gap-1 rounded-lg bg-stopped text-white px-2.5 py-1 font-medium disabled:opacity-60">
              <Trash2 size={12} /> Delete
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function IconButton({ title, onClick, danger, children }: { title: string; onClick: () => void; danger?: boolean; children: ReactNode }): JSX.Element {
  return (
    <button onClick={onClick} title={title} aria-label={title}
      className={`p-1.5 rounded-lg text-steel transition-colors ${danger ? 'hover:text-stopped hover:bg-stopped/10' : 'hover:text-accent hover:bg-accent/10'}`}>
      {children}
    </button>
  );
}

function Switch({ on, onChange, disabled, label }: { on: boolean; onChange: () => void; disabled?: boolean; label: string }): JSX.Element {
  return (
    <button type="button" role="switch" aria-checked={on} aria-label={label} title={label} disabled={disabled} onClick={onChange}
      className={`mt-0.5 relative w-9 h-5 rounded-full shrink-0 transition-colors disabled:opacity-50 ${on ? 'bg-accent' : 'bg-line'}`}>
      <span className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform ${on ? 'translate-x-4' : ''}`} />
    </button>
  );
}

// ── the editor ───────────────────────────────────────────────────────────────
function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => { const t = setTimeout(() => setV(value), ms); return () => clearTimeout(t); }, [value, ms]);
  return v;
}

function ScheduleEditor({ schedule, onDone }: { schedule: ReportSchedule | null; onDone: () => void }): JSX.Element {
  const qc = useQueryClient();
  const can = useAuthStore((s) => s.can);
  const { shifts } = useAppConfig();
  const [f, setF] = useState<ReportScheduleInput>(() => (schedule ? inputOf(schedule) : { ...BLANK }));
  const set = <K extends keyof ReportScheduleInput>(k: K, v: ReportScheduleInput[K]): void => setF((x) => ({ ...x, [k]: v }));

  const badTo = f.to.filter((a) => !isEmail(a));
  const badCc = f.cc.filter((a) => !isEmail(a));
  const problems = [
    !f.name.trim() && 'Give it a name',
    !f.to.length && 'Add at least one person to send it to',
    (badTo.length || badCc.length) && `Fix ${[...badTo, ...badCc].length === 1 ? 'the address' : 'the addresses'} in red`,
    !f.includeSummary && !f.attachWorkbook && 'Include the summary, the workbook, or both',
  ].filter(Boolean) as string[];

  // The server's own preview of the timing, a moment after typing stops.
  const timing = useDebounced(JSON.stringify({
    frequency: f.frequency, everyHours: f.everyHours, time: f.time, weekday: f.weekday, monthDay: f.monthDay,
    shifts: f.shifts, delayMin: f.delayMin, period: f.period, periodHours: f.periodHours, machines: f.machines,
    subject: f.subject, name: f.name || 'Preview',
  }), 350);
  const { data: preview, error: previewError, isFetching: previewing } = useQuery({
    queryKey: ['report-mails', 'preview', timing],
    queryFn: () => reportMailApi.preview(JSON.parse(timing)).then((r) => r.data),
    staleTime: 30_000,
    retry: false,
  });

  const save = useMutation({
    mutationFn: () => (schedule ? reportMailApi.update(schedule._id, f) : reportMailApi.create(f)),
    onSuccess: () => {
      toast.success(schedule ? `“${f.name.trim()}” saved` : `“${f.name.trim()}” is set up`);
      void qc.invalidateQueries({ queryKey: ['report-mails'] });
      onDone();
    },
    onError: (e: unknown) => toast.error(errText(e, 'Could not save it')),
  });

  return (
    <form className="space-y-5" onSubmit={(e) => { e.preventDefault(); if (!problems.length) save.mutate(); }}>
      <button type="button" onClick={onDone} className="inline-flex items-center gap-1.5 text-xs font-medium text-steel hover:text-accent">
        <ArrowLeft size={13} /> All scheduled emails
      </button>

      <Section title="Name" hint="What you will see in the list, and in the email's corner">
        <input value={f.name} onChange={(e) => set('name', e.target.value)} maxLength={80} className="input" placeholder="e.g. Shift report to the plant head" autoFocus={!schedule} />
      </Section>

      <Section title="Who gets it" hint="Type an address and press Enter — or paste a list">
        <div className="space-y-3">
          <EmailField label="To" value={f.to} onChange={(v) => set('to', v)} placeholder="plant.head@company.com" />
          <EmailField label="Copy to (Cc)" value={f.cc} onChange={(v) => set('cc', v)} placeholder="Optional" />
          {can('employees', 'view') && <EmployeePicker taken={[...f.to, ...f.cc]} onPick={(email) => set('to', [...f.to, email])} />}
        </div>
      </Section>

      <Section title="When it goes" hint="Plant time (IST)">
        <div className="space-y-3">
          <div className="flex flex-wrap gap-1 bg-base rounded-lg p-0.5 border border-line w-fit max-w-full">
            {FREQUENCIES.map((x) => (
              <button key={x.value} type="button" onClick={() => set('frequency', x.value)}
                className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${f.frequency === x.value ? 'bg-accent text-white' : 'text-steel hover:text-primary'}`}>
                {x.label}
              </button>
            ))}
          </div>
          {f.frequency === 'shift' && (
            <div className="space-y-2.5">
              <Inline>
                Send
                <select value={f.delayMin} onChange={(e) => set('delayMin', Number(e.target.value))} className="input !w-auto !py-1.5">
                  {[0, 5, 10, 15, 20, 30, 45, 60, 90, 120].map((m) => <option key={m} value={m}>{m ? `${m} minutes` : 'right'}</option>)}
                </select>
                after
              </Inline>
              <div className="flex flex-wrap gap-2">
                <Chip on={!f.shifts.length} onClick={() => set('shifts', [])}>every shift</Chip>
                {shifts.map((sh) => {
                  const on = f.shifts.includes(sh.name);
                  return (
                    <Chip key={sh.name} on={on} onClick={() => set('shifts', on ? f.shifts.filter((x) => x !== sh.name) : [...f.shifts, sh.name])}>
                      {sh.name} <span className="opacity-70">ends {sh.end}</span>
                    </Chip>
                  );
                })}
              </div>
            </div>
          )}
          {f.frequency === 'hours' && (
            <Inline>
              Every
              <select value={f.everyHours} onChange={(e) => set('everyHours', Number(e.target.value))} className="input !w-auto !py-1.5">
                {EVERY_HOURS.map((h) => <option key={h} value={h}>{h} hour{h === 1 ? '' : 's'}</option>)}
              </select>
              starting at
              <input type="time" value={f.time} onChange={(e) => set('time', e.target.value || '07:00')} className="input !w-auto !py-1.5" />
            </Inline>
          )}
          {f.frequency === 'daily' && (
            <Inline>Every day at <input type="time" value={f.time} onChange={(e) => set('time', e.target.value || '07:30')} className="input !w-auto !py-1.5" /></Inline>
          )}
          {f.frequency === 'weekly' && (
            <Inline>
              Every
              <select value={f.weekday} onChange={(e) => set('weekday', Number(e.target.value))} className="input !w-auto !py-1.5">
                {WEEKDAYS.map((d, i) => <option key={d} value={i}>{d}</option>)}
              </select>
              at <input type="time" value={f.time} onChange={(e) => set('time', e.target.value || '08:00')} className="input !w-auto !py-1.5" />
            </Inline>
          )}
          {f.frequency === 'monthly' && (
            <Inline>
              On day
              <select value={f.monthDay} onChange={(e) => set('monthDay', Number(e.target.value))} className="input !w-auto !py-1.5">
                {Array.from({ length: 28 }, (_, i) => i + 1).map((d) => <option key={d} value={d}>{d}</option>)}
              </select>
              of every month at <input type="time" value={f.time} onChange={(e) => set('time', e.target.value || '08:00')} className="input !w-auto !py-1.5" />
              <span className="text-[11px] text-steel w-full">Days 29–31 are left out, so every month has the day.</span>
            </Inline>
          )}
        </div>
      </Section>

      <Section title="What the report covers">
        <div className="space-y-3">
          <Inline>
            <select value={f.period} onChange={(e) => set('period', e.target.value as ReportPeriod)} className="input !w-auto !py-1.5 max-w-full">
              <option value="auto">Matches the schedule — {AUTO_COVERS[f.frequency]}</option>
              {PERIODS.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
            </select>
            {f.period === 'hours' && f.frequency !== 'hours' && (
              <>
                <input type="number" min={1} max={168} value={f.periodHours}
                  onChange={(e) => set('periodHours', Math.min(168, Math.max(1, Number(e.target.value) || 1)))} className="input !w-20 !py-1.5" />
                hours before each email
              </>
            )}
          </Inline>
          <MachinePicker value={f.machines} onChange={(v) => set('machines', v)} />
        </div>
      </Section>

      <Section title="The email">
        <div className="space-y-3">
          <div>
            <div className="label mb-1.5">Subject</div>
            <input value={f.subject} onChange={(e) => set('subject', e.target.value)} maxLength={150} className="input"
              placeholder={preview?.subject || 'EKC SmartFactory — {window}'} />
            <div className="text-[11px] text-steel mt-1">Leave it empty for the default. You can use {'{window}'} (the period), {'{scope}'} (the machines), {'{name}'} and {'{date}'}.</div>
          </div>
          <div>
            <div className="label mb-1.5">A note at the top <span className="normal-case tracking-normal">(optional)</span></div>
            <textarea value={f.message} onChange={(e) => set('message', e.target.value)} maxLength={2000} rows={2} className="input resize-y"
              placeholder="e.g. Please review the downtime reasons before the morning meeting." />
          </div>
          <div className="grid sm:grid-cols-3 gap-2">
            <Check on={f.includeSummary} onChange={(v) => set('includeSummary', v)} title="Summary in the email" sub="Pieces, targets, availability and downtime, by section" />
            <Check on={f.attachWorkbook} onChange={(v) => set('attachWorkbook', v)} title="Attach the Excel workbook" sub="The same file as Export Excel" />
            <Check on={f.skipIfIdle} onChange={(v) => set('skipIfIdle', v)} title="Skip when nothing ran" sub="No email for a period with no production at all" />
          </div>
        </div>
      </Section>

      {/* What it will do, in the server's own words */}
      <div className="rounded-xl border border-accent/25 bg-accent/5 px-4 py-3">
        <div className="flex items-center gap-2">
          <div className="label !text-accent">Next emails</div>
          {previewing && <Loader2 size={12} className="animate-spin text-accent" />}
        </div>
        {previewError ? (
          <div className="text-xs text-stopped mt-1.5">{errText(previewError, 'Could not work out the timing')}</div>
        ) : preview ? (
          <div className="mt-1.5 space-y-1">
            <div className="text-xs text-primary">{preview.describe.when} · {preview.describe.covers}</div>
            {preview.next.map((n) => (
              <div key={n.at} className="flex flex-wrap gap-x-3 text-xs">
                <span className="data font-medium text-primary w-36 shrink-0">{whenText(n.at)}</span>
                <span className="text-steel min-w-0">{n.window.label}</span>
              </div>
            ))}
            {!preview.next.length && <div className="text-xs text-steel">No send time — check the shift settings.</div>}
            {preview.subject && <div className="text-[11px] text-steel pt-1 truncate" title={preview.subject}>Subject: <span className="text-primary">{preview.subject}</span></div>}
          </div>
        ) : <div className="text-xs text-steel mt-1.5">Working it out…</div>}
      </div>

      <div className="flex flex-wrap items-center gap-2 pt-1 border-t border-line">
        <label className="inline-flex items-center gap-2 text-xs text-primary mt-3 mr-auto cursor-pointer">
          <Switch on={f.enabled} onChange={() => set('enabled', !f.enabled)} label={f.enabled ? 'On — it will be sent' : 'Paused'} />
          {f.enabled ? 'On — it will be sent' : 'Paused — saved, not sent'}
        </label>
        {problems.length > 0 && <span className="text-xs text-steel mt-3">{problems[0]}</span>}
        <button type="button" onClick={onDone} className="mt-3 rounded-lg border border-line px-3 py-1.5 text-sm font-medium text-steel hover:text-primary">Cancel</button>
        <button type="submit" disabled={!!problems.length || save.isPending}
          className="mt-3 inline-flex items-center gap-1.5 rounded-lg bg-accent text-white px-4 py-1.5 text-sm font-medium disabled:opacity-50">
          {save.isPending && <Loader2 size={14} className="animate-spin" />} {schedule ? 'Save changes' : 'Set it up'}
        </button>
      </div>
    </form>
  );
}

function Section({ title, hint, children }: { title: string; hint?: string; children: ReactNode }): JSX.Element {
  return (
    <section>
      <div className="flex items-baseline gap-2 mb-2">
        <h3 className="text-sm font-semibold text-primary">{title}</h3>
        {hint && <span className="text-[11px] text-steel">{hint}</span>}
      </div>
      {children}
    </section>
  );
}

const Inline = ({ children }: { children: ReactNode }): JSX.Element => (
  <div className="flex flex-wrap items-center gap-2 text-sm text-primary">{children}</div>
);

function Chip({ on, onClick, children }: { on: boolean; onClick: () => void; children: ReactNode }): JSX.Element {
  return (
    <button type="button" onClick={onClick} aria-pressed={on}
      className={`rounded-full border px-3 py-1 text-xs font-medium transition-colors ${on ? 'border-accent bg-accent/10 text-accent' : 'border-line text-steel hover:text-primary'}`}>
      {children}
    </button>
  );
}

function Check({ on, onChange, title, sub }: { on: boolean; onChange: (v: boolean) => void; title: string; sub: string }): JSX.Element {
  return (
    <label className={`rounded-xl border px-3 py-2.5 cursor-pointer transition-colors flex items-start gap-2.5 ${on ? 'border-accent/40 bg-accent/5' : 'border-line hover:border-accent/25'}`}>
      <input type="checkbox" checked={on} onChange={(e) => onChange(e.target.checked)} className="mt-0.5 accent-accent" />
      <span className="min-w-0">
        <span className="block text-xs font-medium text-primary">{title}</span>
        <span className="block text-[11px] text-steel mt-0.5">{sub}</span>
      </span>
    </label>
  );
}

/** Addresses as chips: Enter, comma, semicolon or a paste of a whole list. */
function EmailField({ label, value, onChange, placeholder }: { label: string; value: string[]; onChange: (v: string[]) => void; placeholder: string }): JSX.Element {
  const [draft, setDraft] = useState('');
  const add = (raw: string): void => {
    const parts = raw.split(/[\s,;]+/).map((x) => x.trim().replace(/^<|>$/g, '')).filter(Boolean);
    if (!parts.length) { setDraft(''); return; }
    const next = [...value];
    for (const p of parts) if (!next.some((x) => x.toLowerCase() === p.toLowerCase())) next.push(p);
    onChange(next);
    setDraft('');
  };
  return (
    <div>
      <div className="label mb-1.5">{label}</div>
      <div className="flex flex-wrap items-center gap-1.5 bg-base border border-line rounded-lg px-2 py-1.5 min-h-[40px] focus-within:border-accent">
        {value.map((a) => {
          const ok = isEmail(a);
          return (
            <span key={a} className={`pill !text-xs ${ok ? 'bg-accent/10 text-accent' : 'bg-stopped/10 text-stopped'}`} title={ok ? a : 'Not an email address'}>
              {a}
              <button type="button" onClick={() => onChange(value.filter((x) => x !== a))} aria-label={`Remove ${a}`} className="hover:opacity-70"><X size={11} /></button>
            </span>
          );
        })}
        <input value={draft} type="email" placeholder={value.length ? '' : placeholder}
          onChange={(e) => { const v = e.target.value; if (/[,;\s]$/.test(v)) add(v); else setDraft(v); }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && draft.trim()) { e.preventDefault(); add(draft); }
            if (e.key === 'Backspace' && !draft && value.length) onChange(value.slice(0, -1));
          }}
          onPaste={(e) => { const t = e.clipboardData.getData('text'); if (/[,;\s]/.test(t.trim())) { e.preventDefault(); add(t); } }}
          onBlur={() => { if (draft.trim()) add(draft); }}
          className="flex-1 min-w-[180px] bg-transparent outline-none text-sm text-primary py-0.5 placeholder:text-steel/60" />
      </div>
    </div>
  );
}

/** Someone from the employee list, by name — their address goes into To. */
function EmployeePicker({ taken, onPick }: { taken: string[]; onPick: (email: string) => void }): JSX.Element | null {
  const { data } = useQuery({
    queryKey: ['users', 'with-email'],
    queryFn: () => userApi.list({ limit: 500 }).then((r) => r.data),
    staleTime: 5 * 60_000,
  });
  const options = useMemo(() => (data || [])
    .filter((u) => u.email && isEmail(u.email) && !taken.some((t) => t.toLowerCase() === u.email.toLowerCase()))
    .sort((a, b) => (a.name || '').localeCompare(b.name || '')), [data, taken]);
  if (!options.length) return null;
  return (
    <select value="" onChange={(e) => { if (e.target.value) onPick(e.target.value); }} className="input !w-auto !py-1.5 text-steel">
      <option value="">+ Add an employee…</option>
      {options.map((u) => <option key={u.id || u.email} value={u.email}>{u.name} — {u.email}</option>)}
    </select>
  );
}

/** All machines, or the ones ticked — grouped the way the Dashboard groups them. */
function MachinePicker({ value, onChange }: { value: string[]; onChange: (v: string[]) => void }): JSX.Element {
  const mName = useMachineName();
  const [some, setSome] = useState(value.length > 0);
  const [q, setQ] = useState('');
  const { data } = useQuery({
    queryKey: ['machines', 'list'],
    queryFn: () => machineApi.list({ limit: 200 }).then((r) => r.data),
    staleTime: 60_000,
  });
  const groups = useMemo(() => groupMachines(data || []), [data]);
  const picked = new Set(value.map((v) => v.toUpperCase()));
  const match = (code: string): boolean => !q.trim() || `${code} ${mName(code)}`.toLowerCase().includes(q.trim().toLowerCase());
  const flip = (code: string): void => {
    const c = code.toUpperCase();
    onChange(picked.has(c) ? value.filter((v) => v.toUpperCase() !== c) : [...value, c]);
  };
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2">
        <Chip on={!some} onClick={() => { setSome(false); onChange([]); }}>All machines</Chip>
        <Chip on={some} onClick={() => setSome(true)}>Only some machines{value.length ? ` (${value.length})` : ''}</Chip>
      </div>
      {some && (
        <div className="rounded-xl border border-line p-3 space-y-2.5">
          <div className="relative">
            <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-steel" />
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find a machine" className="input !pl-8 !py-1.5" />
          </div>
          <div className="max-h-56 overflow-y-auto space-y-2.5 pr-1">
            {groups.map((g) => {
              const codes = g.machines.map((m) => String(m.code || m.machineId || '').toUpperCase()).filter(Boolean).filter(match);
              if (!codes.length) return null;
              const all = codes.every((c) => picked.has(c));
              return (
                <div key={g.key}>
                  <button type="button" className="label hover:text-accent mb-1"
                    onClick={() => onChange(all ? value.filter((v) => !codes.includes(v.toUpperCase())) : [...new Set([...value.map((v) => v.toUpperCase()), ...codes])])}>
                    {g.label} {all ? '· untick all' : '· tick all'}
                  </button>
                  <div className="flex flex-wrap gap-1.5">
                    {codes.map((c) => (
                      <Chip key={c} on={picked.has(c)} onClick={() => flip(c)}>{mName(c)}</Chip>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
          {!value.length && <div className="text-[11px] text-idle">Tick at least one — with none ticked, it covers all machines.</div>}
        </div>
      )}
    </div>
  );
}

// ── the history ──────────────────────────────────────────────────────────────
const TRIGGER: Record<ReportMailRun['trigger'], string> = { schedule: 'Scheduled', manual: 'Sent by hand', test: 'Test' };

function RunHistory({ schedule, onBack }: { schedule: ReportSchedule | null; onBack: () => void }): JSX.Element {
  const { data, isLoading } = useQuery({
    queryKey: ['report-mails', 'runs', schedule?._id || 'all'],
    queryFn: () => reportMailApi.runs({ scheduleId: schedule?._id, limit: 100 }).then((r) => r.data),
    refetchInterval: 30_000,
  });
  const rows = data || [];
  return (
    <div className="space-y-3">
      <button type="button" onClick={onBack} className="inline-flex items-center gap-1.5 text-xs font-medium text-steel hover:text-accent">
        <ArrowLeft size={13} /> All scheduled emails
      </button>
      {isLoading && !data ? (
        <div className="py-10 flex justify-center text-steel"><Loader2 size={18} className="animate-spin" /></div>
      ) : !rows.length ? (
        <div className="rounded-xl border border-dashed border-line px-6 py-8 text-center text-sm text-steel">Nothing has been sent yet.</div>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-line">
          <table className="w-full text-xs">
            <thead className="bg-base text-steel">
              <tr>
                <th className="text-left font-medium px-3 py-2">When</th>
                {!schedule && <th className="text-left font-medium px-3 py-2">Email</th>}
                <th className="text-left font-medium px-3 py-2">Covered</th>
                <th className="text-left font-medium px-3 py-2">Result</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const t = STATUS_TONE[r.status];
                return (
                  <tr key={r._id} className="border-t border-line align-top">
                    <td className="px-3 py-2 whitespace-nowrap">
                      <div className="data text-primary">{stampText(r.at)}</div>
                      <div className="text-steel">{TRIGGER[r.trigger]}{r.by?.name && r.trigger !== 'schedule' ? ` · ${r.by.name}` : ''}</div>
                    </td>
                    {!schedule && <td className="px-3 py-2 text-primary">{r.name}</td>}
                    <td className="px-3 py-2 text-steel">{r.window?.label || '—'}</td>
                    <td className="px-3 py-2">
                      <div className={`inline-flex items-center gap-1 font-medium ${t.cls}`}><t.icon size={12} /> {t.word}</div>
                      <div className="text-steel mt-0.5 break-words">{r.detail}</div>
                      {r.file && <div className="text-steel/80 mt-0.5 inline-flex items-center gap-1"><Paperclip size={11} /> {r.file}</div>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
