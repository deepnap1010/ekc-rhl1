// client/src/pages/Settings.tsx
// A single, professional Settings console. Every control here is a CLIENT-SIDE
// preference persisted to localStorage (lib/settings) — the database is only read,
// never written. Items that genuinely need a secure backend (password change, 2FA
// enforcement, audit logs, API keys, scheduled email) are shown honestly as
// server-managed rather than faked.
import { useMemo, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  User as UserIcon, Building2, Bell, Shield, Factory, FileBarChart, Palette,
  Check, Plus, X, Sun, Moon, Monitor, RotateCcw, Info, Lock, ArrowRight,
  Mail, MessageSquare, KeyRound, ScrollText, Clock, ExternalLink, Pencil, Camera,
  type LucideIcon,
} from 'lucide-react';
import PageHeader from '../components/PageHeader';
import Modal from '../components/Modal';
import { useT } from '../lib/i18n';
import { useAuthStore } from '../store/auth';
import { toast } from '../store/toast';
import { machineApi, authApi } from '../api/endpoints';
import { resizeImage } from '../lib/image';
import { Avatar } from '../components/ui';
import {
  useSettings, patchSettings, resetSettings, resetAllLocalData, APP_VERSION,
  LANGUAGES, REGIONS, STANDARD_OPTIONS, PLANT_TIMEZONES, EKC_PLANTS,
  type Settings, type ThemeMode, type Severity,
} from '../lib/settings';

type SectionId = 'profile' | 'company' | 'alerts' | 'security' | 'production' | 'reports' | 'system';

const SECTIONS: { id: SectionId; label: string; icon: LucideIcon; emoji: string }[] = [
  { id: 'profile',    label: 'Profile & Account',   icon: UserIcon,     emoji: '👤' },
  { id: 'company',    label: 'Company & Plants',     icon: Building2,    emoji: '🏭' },
  { id: 'alerts',     label: 'Alerts & Downtime',    icon: Bell,        emoji: '🔔' },
  { id: 'security',   label: 'Security & Access',    icon: Shield,      emoji: '🔐' },
  { id: 'production',  label: 'Production & Quality', icon: Factory,     emoji: '🛢️' },
  { id: 'reports',    label: 'Reports & Compliance', icon: FileBarChart,emoji: '📊' },
  { id: 'system',     label: 'System & Appearance',  icon: Palette,     emoji: '🎨' },
];

export default function Settings() {
  const s = useSettings();
  const t = useT();
  const [section, setSection] = useState<SectionId>('profile');

  return (
    <div>
      <PageHeader title="Settings" subtitle="Preferences & configuration — saved on this device, never to the database" />

      <div className="px-4 sm:px-6 pb-10 pt-5 grid lg:grid-cols-[230px_1fr] gap-5">
        {/* Section nav — vertical on desktop, horizontal scroller on mobile */}
        <nav className="panel p-2 h-fit lg:sticky lg:top-20 flex lg:flex-col gap-1 overflow-x-auto">
          {SECTIONS.map((sec) => {
            const active = section === sec.id;
            return (
              <button
                key={sec.id}
                onClick={() => setSection(sec.id)}
                className={`flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm whitespace-nowrap transition-colors shrink-0 ${
                  active ? 'bg-accent/10 text-accent font-medium' : 'text-steel hover:text-primary hover:bg-line/50'
                }`}
              >
                <sec.icon size={16} className="shrink-0" />
                <span className="lg:inline">{t(sec.label)}</span>
              </button>
            );
          })}
        </nav>

        {/* Active section */}
        <div className="min-w-0 space-y-5">
          {section === 'profile'    && <ProfileSection s={s} />}
          {section === 'company'    && <CompanySection s={s} />}
          {section === 'alerts'     && <AlertsSection s={s} />}
          {section === 'security'   && <SecuritySection s={s} />}
          {section === 'production' && <ProductionSection s={s} />}
          {section === 'reports'    && <ReportsSection s={s} />}
          {section === 'system'     && <SystemSection s={s} />}
        </div>
      </div>
    </div>
  );
}

// ── Reusable building blocks ───────────────────────────────────────────────────
function Section({ title, desc, icon: Icon, children, action }: { title: string; desc?: string; icon?: LucideIcon; children: ReactNode; action?: ReactNode }) {
  const t = useT();
  return (
    <div className="panel p-5">
      <div className="flex items-start gap-3 mb-4">
        {Icon && <span className="w-8 h-8 rounded-lg bg-accent/10 flex items-center justify-center shrink-0"><Icon size={16} className="text-accent" /></span>}
        <div className="flex-1 min-w-0">
          <h2 className="font-semibold text-sm text-primary">{t(title)}</h2>
          {desc && <p className="text-xs text-steel mt-0.5">{t(desc)}</p>}
        </div>
        {action}
      </div>
      {children}
    </div>
  );
}

// label + control in a responsive two-column row
function Row({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  const t = useT();
  return (
    <div className="flex flex-col sm:flex-row sm:items-center gap-1.5 sm:gap-4 py-2.5 border-b border-line last:border-0">
      <div className="sm:w-1/2 min-w-0">
        <div className="text-sm text-primary font-medium">{t(label)}</div>
        {hint && <div className="text-xs text-steel mt-0.5">{t(hint)}</div>}
      </div>
      <div className="sm:w-1/2 sm:flex sm:justify-end">{children}</div>
    </div>
  );
}

function Toggle({ on, onChange, disabled }: { on: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      disabled={disabled}
      onClick={() => !disabled && onChange(!on)}
      className={`relative w-10 h-6 rounded-full transition-colors shrink-0 ${on ? 'bg-accent' : 'bg-line'} ${disabled ? 'opacity-50 cursor-not-allowed' : ''}`}
    >
      <span className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform ${on ? 'translate-x-4' : ''}`} />
    </button>
  );
}

const fieldCls = 'bg-base border border-line rounded-lg px-3 py-2 text-sm text-primary outline-none focus:border-accent w-full sm:w-56';

function Select({ value, onChange, options, width }: { value: string; onChange: (v: string) => void; options: { value: string; label: string }[]; width?: string }) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)} className={`${fieldCls} ${width || ''}`}>
      {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  );
}

function NumberField({ value, onChange, min, max, suffix, width }: { value: number; onChange: (v: number) => void; min?: number; max?: number; suffix?: string; width?: string }) {
  return (
    <div className="flex items-center gap-2 justify-end">
      <input
        type="number" value={value} min={min} max={max}
        onChange={(e) => onChange(Number(e.target.value))}
        className={`${fieldCls} ${width || 'sm:w-28'} text-right data`}
      />
      {suffix && <span className="text-xs text-steel w-8">{suffix}</span>}
    </div>
  );
}

// Segmented control (e.g. theme picker)
function Segmented<T extends string>({ value, onChange, options }: { value: T; onChange: (v: T) => void; options: { value: T; label: string; icon?: LucideIcon }[] }) {
  const t = useT();
  return (
    <div className="inline-flex bg-base border border-line rounded-lg p-0.5">
      {options.map((o) => {
        const active = value === o.value;
        return (
          <button key={o.value} onClick={() => onChange(o.value)}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${active ? 'bg-surface text-accent shadow-sm' : 'text-steel hover:text-primary'}`}>
            {o.icon && <o.icon size={14} />}{t(o.label)}
          </button>
        );
      })}
    </div>
  );
}

// Editable chip list (products, stages, standards, downtime reasons)
function TagEditor({ tags, onChange, placeholder }: { tags: string[]; onChange: (next: string[]) => void; placeholder?: string }) {
  const [draft, setDraft] = useState('');
  const add = () => {
    const v = draft.trim();
    if (v && !tags.includes(v)) onChange([...tags, v]);
    setDraft('');
  };
  return (
    <div>
      <div className="flex flex-wrap gap-1.5 mb-2">
        {tags.length === 0 && <span className="text-xs text-steel">None yet.</span>}
        {tags.map((t) => (
          <span key={t} className="inline-flex items-center gap-1 pill bg-line text-primary">
            {t}
            <button onClick={() => onChange(tags.filter((x) => x !== t))} className="text-steel hover:text-stopped" aria-label={`Remove ${t}`}><X size={12} /></button>
          </span>
        ))}
      </div>
      <div className="flex gap-2">
        <input
          value={draft} onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } }}
          placeholder={placeholder || 'Add…'} className="bg-base border border-line rounded-lg px-3 py-1.5 text-sm text-primary outline-none focus:border-accent flex-1"
        />
        <button onClick={add} className="flex items-center gap-1 text-sm px-3 py-1.5 rounded-lg border border-accent/30 text-accent bg-accent/5 hover:bg-accent/10"><Plus size={14} /> Add</button>
      </div>
    </div>
  );
}

// Honest "this lives on the server" notice for actions we can't (and shouldn't) fake.
function ServerNote({ children }: { children: ReactNode }) {
  return (
    <div className="flex items-start gap-2 text-xs text-steel bg-base border border-line rounded-lg px-3 py-2">
      <Info size={13} className="shrink-0 mt-0.5 text-accent" />
      <span>{children}</span>
    </div>
  );
}

const savedToast = () => toast.success('Settings saved');

// ── 1 · Profile & Account ──────────────────────────────────────────────────────
// Avatar: uploaded photo, else a clean person icon in a tinted circle.
function ProfileAvatar({ photo, name, size = 56 }: { photo?: string; name?: string | null; size?: number }) {
  const box = { width: size, height: size };
  if (photo) return <img src={photo} alt={name || 'Profile photo'} className="rounded-full object-cover shrink-0 border border-line" style={box} />;
  return (
    <span className="rounded-full bg-accent/15 text-accent flex items-center justify-center shrink-0" style={box}>
      <UserIcon size={Math.round(size * 0.5)} />
    </span>
  );
}

function EditProfileModal({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const user = useAuthStore((st) => st.user);
  const setUser = useAuthStore((st) => st.setUser);
  const [name, setName] = useState(user?.name || '');
  const [email, setEmail] = useState(user?.email || '');
  const [photo, setPhoto] = useState(user?.avatar || '');
  const [busy, setBusy] = useState(false);   // image processing
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const onFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    e.target.value = ''; // allow re-selecting the same file
    if (!f) return;
    if (!f.type.startsWith('image/')) { toast.error('Please choose an image file'); return; }
    setBusy(true);
    try { setPhoto(await resizeImage(f)); }
    catch { toast.error('Could not read that image'); }
    finally { setBusy(false); }
  };

  // Name, email AND photo all persist to the DB (User fields) so they update
  // everywhere this person appears — Employees, Org Chart, Departments, Reports-To,
  // sidebar — and the photo is per-user, not shared across the device.
  const save = async () => {
    setError('');
    if (!name.trim()) return setError('Name is required.');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) return setError('Please enter a valid email address.');
    setSaving(true);
    try {
      const res = await authApi.updateMe({ name: name.trim(), email: email.trim().toLowerCase(), avatar: photo });
      setUser(res.data);                                  // refresh sidebar + profile instantly
      qc.invalidateQueries({ queryKey: ['users'] });      // Employees + manager pickers refetch
      qc.invalidateQueries({ queryKey: ['orgchart'] });   // Org Chart + Departments refetch
      toast.success('Profile updated');
      onClose();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Could not update profile');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal title="Edit profile" subtitle="Name & email save to your account and update everywhere" icon={UserIcon} onClose={onClose} maxW="max-w-md">
      <div className="space-y-5">
        <div className="flex items-center gap-4">
          <ProfileAvatar photo={photo} name={name} size={72} />
          <div className="flex flex-wrap gap-2">
            <label className="cursor-pointer flex items-center gap-1.5 text-sm px-3 py-2 rounded-lg border border-accent/30 text-accent bg-accent/5 hover:bg-accent/10 transition-colors">
              <Camera size={14} /> {busy ? 'Processing…' : photo ? 'Change photo' : 'Upload photo'}
              <input type="file" accept="image/*" className="hidden" onChange={onFile} />
            </label>
            {photo && (
              <button onClick={() => setPhoto('')} className="text-sm px-3 py-2 rounded-lg border border-line text-steel hover:text-stopped hover:border-stopped/40 transition-colors">
                Remove
              </button>
            )}
          </div>
        </div>
        <div>
          <label className="label block mb-1.5">Full name</label>
          <input value={name} onChange={(e) => setName(e.target.value)} className="input" placeholder="Your name" autoFocus />
        </div>
        <div>
          <label className="label block mb-1.5">Email</label>
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} className="input" placeholder="you@everestkanto.com" />
          <p className="text-xs text-steel mt-1.5">Used to sign in. Name, email and photo update everywhere you appear — Employees, Org Chart, Departments.</p>
        </div>
        {error && <div className="text-sm text-stopped bg-stopped/8 border border-stopped/15 rounded-lg px-3 py-2">{error}</div>}
        <div className="flex justify-end gap-2 pt-1">
          <button onClick={onClose} className="px-4 py-2 rounded-lg border border-line text-sm text-steel hover:bg-base transition-colors">Cancel</button>
          <button onClick={save} disabled={busy || saving} className="px-4 py-2 rounded-lg bg-accent text-white text-sm font-medium hover:bg-accent/90 disabled:opacity-60 transition-colors">{saving ? 'Saving…' : 'Save changes'}</button>
        </div>
      </div>
    </Modal>
  );
}

function ProfileSection({ s }: { s: Settings }) {
  const user = useAuthStore((st) => st.user);
  const t = useT();
  const [editing, setEditing] = useState(false);
  const displayName = user?.name || '—';
  return (
    <>
      <Section
        title="My profile"
        desc="Personalise how you appear here. Your underlying account is managed centrally."
        icon={UserIcon}
        action={(
          <button onClick={() => setEditing(true)} className="flex items-center gap-1.5 text-sm px-3 py-1.5 rounded-lg border border-accent/30 text-accent bg-accent/5 hover:bg-accent/10 transition-colors shrink-0">
            <Pencil size={14} /> {t('Edit Profile')}
          </button>
        )}
      >
        <div className="flex items-center gap-4">
          <Avatar src={user?.avatar} name={displayName} size={56} fallback="icon" />
          <div className="min-w-0 grid sm:grid-cols-2 gap-x-8 gap-y-1 text-sm flex-1">
            <Info2 label="Name" value={displayName} />
            <Info2 label="Email" value={user?.email || '—'} />
            <Info2 label="Role" value={user?.role?.name || (user?.isSuperAdmin ? 'Super Admin' : '—')} />
            <Info2 label="Plant" value={user?.plant || '—'} />
            <Info2 label="Last login" value={user?.lastLoginAt ? new Date(user.lastLoginAt).toLocaleString(s.locale.region) : '—'} />
          </div>
        </div>
      </Section>
      {editing && <EditProfileModal onClose={() => setEditing(false)} />}

      <Section title="Language & format" desc="How dates, numbers and the interface read for you." icon={Monitor}>
        <Row label="Language" hint="Interface language">
          <Select value={s.locale.language} onChange={(v) => { patchSettings((d) => { d.locale.language = v; }); }} options={LANGUAGES.map((l) => ({ value: l.code, label: l.label }))} />
        </Row>
        <Row label="Region / format" hint="Date & number formatting locale">
          <Select value={s.locale.region} onChange={(v) => { patchSettings((d) => { d.locale.region = v; }); }} options={REGIONS.map((r) => ({ value: r.code, label: r.label }))} />
        </Row>
        <Row label="Time format">
          <Segmented value={s.locale.timeFormat} onChange={(v) => patchSettings((d) => { d.locale.timeFormat = v; })} options={[{ value: '12h', label: '12-hour' }, { value: '24h', label: '24-hour' }]} />
        </Row>
        <Row label="Timezone" hint="Plants span IST · GST · CST · EST">
          <Select value={s.locale.timezone} onChange={(v) => patchSettings((d) => { d.locale.timezone = v; })}
            options={[{ value: 'auto', label: 'Auto (this device)' }, ...[...new Set(Object.values(PLANT_TIMEZONES))].map((z) => ({ value: z, label: z }))]} />
        </Row>
      </Section>

      <Section title="Notifications" desc="Where you'd like to be notified. Channels other than in-app are delivered by the server." icon={Bell}>
        <Row label="In-app toasts"><Toggle on={s.notifications.inApp} onChange={(v) => patchSettings((d) => { d.notifications.inApp = v; })} /></Row>
        <Row label="Sound on alert"><Toggle on={s.notifications.sound} onChange={(v) => patchSettings((d) => { d.notifications.sound = v; })} /></Row>
        <Row label="Email" hint="Daily digests & critical alerts"><Toggle on={s.notifications.email} onChange={(v) => patchSettings((d) => { d.notifications.email = v; })} /></Row>
        <Row label="SMS"><Toggle on={s.notifications.sms} onChange={(v) => patchSettings((d) => { d.notifications.sms = v; })} /></Row>
        <Row label="WhatsApp"><Toggle on={s.notifications.whatsapp} onChange={(v) => patchSettings((d) => { d.notifications.whatsapp = v; })} /></Row>
        <Row label="Microsoft Teams"><Toggle on={s.notifications.teams} onChange={(v) => patchSettings((d) => { d.notifications.teams = v; })} /></Row>
        <div className="mt-3"><ServerNote>Email / SMS / WhatsApp / Teams require channel credentials configured on the server. These toggles record your preference.</ServerNote></div>
      </Section>
    </>
  );
}

function Info2({ label, value }: { label: string; value: ReactNode }) {
  const t = useT();
  return (
    <div className="flex items-center justify-between gap-3 py-1 border-b border-line/60 last:border-0">
      <span className="label">{t(label)}</span>
      <span className="text-primary font-medium truncate text-right">{value}</span>
    </div>
  );
}

// ── 2 · Company & Plants ───────────────────────────────────────────────────────
function CompanySection({ s }: { s: Settings }) {
  const navigate = useNavigate();
  const { data: machineList } = useQuery({ queryKey: ['machines', 'settings'], queryFn: () => machineApi.list({ limit: 200 }).then((r) => r.data) });

  // Read-only: how many machines actually report per plant (purely informational).
  const plantCounts = useMemo(() => {
    const m = new Map<string, number>();
    (machineList || []).forEach((mc) => { const p = mc.plant?.name; if (p) m.set(p, (m.get(p) || 0) + 1); });
    return m;
  }, [machineList]);

  return (
    <>
      <Section title="Company profile" desc="Branding shown across the app. Updating the app name changes the sidebar instantly." icon={Building2}>
        <Row label="App name" hint="Shown in the sidebar header">
          <input className={fieldCls} value={s.company.appName} onChange={(e) => patchSettings((d) => { d.company.appName = e.target.value; })} />
        </Row>
        <Row label="Tagline">
          <input className={fieldCls} value={s.company.tagline} onChange={(e) => patchSettings((d) => { d.company.tagline = e.target.value; })} />
        </Row>
        <Row label="Legal name">
          <input className={fieldCls} value={s.company.legalName} onChange={(e) => patchSettings((d) => { d.company.legalName = e.target.value; })} />
        </Row>
        <Row label="Default plant" hint="Pre-selected when adding a new employee">
          <Select value={s.company.defaultPlant} onChange={(v) => { patchSettings((d) => { d.company.defaultPlant = v; }); savedToast(); }} options={EKC_PLANTS.map((p) => ({ value: p, label: p }))} />
        </Row>
      </Section>

      <Section title="Plants" desc="Everest Kanto's manufacturing footprint. Counts are read live from the machine data." icon={Factory}>
        <div className="grid sm:grid-cols-2 gap-2.5">
          {EKC_PLANTS.map((p) => (
            <div key={p} className="card p-3 flex items-center justify-between gap-2">
              <div className="min-w-0">
                <div className="text-sm font-medium text-primary truncate">{p}</div>
                <div className="text-[11px] text-steel">{PLANT_TIMEZONES[p] || 'Asia/Kolkata'}</div>
              </div>
              <span className="pill bg-accent/10 text-accent shrink-0">{plantCounts.get(p) || 0} mc</span>
            </div>
          ))}
        </div>
        <div className="mt-3"><ServerNote>Plants come from the company structure. To add or rename a plant in the live data, an administrator updates it on the server.</ServerNote></div>
      </Section>

      <Section title="Shift timings" desc="Used for shift-based reporting and quiet hours." icon={Clock}>
        <div className="space-y-2">
          {s.shifts.map((sh, i) => (
            <div key={i} className="flex items-center gap-3 flex-wrap">
              <span className="text-sm font-medium text-primary w-20">{sh.name}</span>
              <input type="time" value={sh.start} onChange={(e) => patchSettings((d) => { d.shifts[i].start = e.target.value; })} className="bg-base border border-line rounded-lg px-2 py-1.5 text-sm text-primary outline-none focus:border-accent" />
              <ArrowRight size={14} className="text-steel" />
              <input type="time" value={sh.end} onChange={(e) => patchSettings((d) => { d.shifts[i].end = e.target.value; })} className="bg-base border border-line rounded-lg px-2 py-1.5 text-sm text-primary outline-none focus:border-accent" />
            </div>
          ))}
        </div>
      </Section>

      <Section title="Organisation" desc="Departments and role access are managed on their own pages." icon={Building2}>
        <div className="flex flex-wrap gap-2">
          <LinkBtn onClick={() => navigate('/departments')} icon={Building2}>Departments</LinkBtn>
          <LinkBtn onClick={() => navigate('/roles')} icon={Shield}>Roles & Permissions</LinkBtn>
          <LinkBtn onClick={() => navigate('/orgchart')} icon={UserIcon}>Org Chart</LinkBtn>
        </div>
      </Section>
    </>
  );
}

function LinkBtn({ onClick, icon: Icon, children }: { onClick: () => void; icon: LucideIcon; children: ReactNode }) {
  const t = useT();
  return (
    <button onClick={onClick} className="flex items-center gap-2 text-sm px-3 py-2 rounded-lg border border-line text-primary hover:border-accent hover:text-accent transition-colors">
      <Icon size={15} /> {typeof children === 'string' ? t(children) : children} <ArrowRight size={14} className="text-steel" />
    </button>
  );
}

// ── 4 · Alerts & Downtime ──────────────────────────────────────────────────────
function AlertsSection({ s }: { s: Settings }) {
  const tUnit = s.units.temperature === 'C' ? '°C' : '°F';
  const pUnit = s.units.pressure;
  return (
    <>
      <Section title="Alert thresholds" desc="Planning limits for pressure-vessel safety. The live alert engine runs server-side; these guide display & review." icon={Bell}>
        <Row label="Temperature — warning"><NumberField value={s.alerts.tempWarn} onChange={(v) => patchSettings((d) => { d.alerts.tempWarn = v; })} suffix={tUnit} /></Row>
        <Row label="Temperature — critical"><NumberField value={s.alerts.tempCrit} onChange={(v) => patchSettings((d) => { d.alerts.tempCrit = v; })} suffix={tUnit} /></Row>
        <Row label="Pressure — warning"><NumberField value={s.alerts.pressureWarn} onChange={(v) => patchSettings((d) => { d.alerts.pressureWarn = v; })} suffix={pUnit} /></Row>
        <Row label="Pressure — critical"><NumberField value={s.alerts.pressureCrit} onChange={(v) => patchSettings((d) => { d.alerts.pressureCrit = v; })} suffix={pUnit} /></Row>
      </Section>

      <Section title="Routing & escalation" desc="Who hears about what, and when." icon={MessageSquare}>
        <Row label="Minimum severity to notify">
          <Segmented<Severity> value={s.alerts.minSeverity} onChange={(v) => patchSettings((d) => { d.alerts.minSeverity = v; })}
            options={[{ value: 'info', label: 'Info' }, { value: 'warning', label: 'Warning' }, { value: 'critical', label: 'Critical' }]} />
        </Row>
        <Row label="Escalation chain" hint="Operator → Supervisor → Manager if unacknowledged"><Toggle on={s.alerts.escalation} onChange={(v) => patchSettings((d) => { d.alerts.escalation = v; })} /></Row>
        <Row label="Quiet hours"><Toggle on={s.alerts.quietHours.enabled} onChange={(v) => patchSettings((d) => { d.alerts.quietHours.enabled = v; })} /></Row>
        {s.alerts.quietHours.enabled && (
          <Row label="Quiet window" hint="Non-critical alerts held during this window">
            <div className="flex items-center gap-2 justify-end">
              <input type="time" value={s.alerts.quietHours.from} onChange={(e) => patchSettings((d) => { d.alerts.quietHours.from = e.target.value; })} className="bg-base border border-line rounded-lg px-2 py-1.5 text-sm text-primary outline-none focus:border-accent" />
              <ArrowRight size={14} className="text-steel" />
              <input type="time" value={s.alerts.quietHours.to} onChange={(e) => patchSettings((d) => { d.alerts.quietHours.to = e.target.value; })} className="bg-base border border-line rounded-lg px-2 py-1.5 text-sm text-primary outline-none focus:border-accent" />
            </div>
          </Row>
        )}
      </Section>

      <Section title="Downtime reasons" desc="The categories operators can pick when logging downtime." icon={Clock}>
        <TagEditor tags={s.downtime.reasons} onChange={(next) => patchSettings((d) => { d.downtime.reasons = next; })} placeholder="e.g. Compressor Trip" />
      </Section>
    </>
  );
}

// ── 5 · Security & Access ──────────────────────────────────────────────────────
function SecuritySection({ s }: { s: Settings }) {
  const navigate = useNavigate();
  return (
    <>
      <Section title="Password policy" desc="Recommended rules for new and changed passwords." icon={KeyRound}>
        <Row label="Minimum length"><NumberField value={s.security.passwordMinLength} min={6} max={32} onChange={(v) => patchSettings((d) => { d.security.passwordMinLength = v; })} suffix="chars" /></Row>
        <Row label="Require uppercase"><Toggle on={s.security.requireUppercase} onChange={(v) => patchSettings((d) => { d.security.requireUppercase = v; })} /></Row>
        <Row label="Require a number"><Toggle on={s.security.requireNumber} onChange={(v) => patchSettings((d) => { d.security.requireNumber = v; })} /></Row>
        <Row label="Require a symbol"><Toggle on={s.security.requireSymbol} onChange={(v) => patchSettings((d) => { d.security.requireSymbol = v; })} /></Row>
        <Row label="Password expiry"><NumberField value={s.security.passwordExpiryDays} min={0} max={365} onChange={(v) => patchSettings((d) => { d.security.passwordExpiryDays = v; })} suffix="days" /></Row>
      </Section>

      <Section title="Session" desc="Auto sign-out after inactivity." icon={Lock}>
        <Row label="Session timeout"><NumberField value={s.security.sessionTimeoutMin} min={5} max={480} onChange={(v) => patchSettings((d) => { d.security.sessionTimeoutMin = v; })} suffix="min" /></Row>
      </Section>

      <Section title="Two-factor authentication" desc="Adds a second step at sign-in." icon={Shield}>
        <Row label="Require 2FA"><Toggle on={s.security.twoFactor} onChange={(v) => patchSettings((d) => { d.security.twoFactor = v; })} /></Row>
        <div className="mt-2"><ServerNote>Enabling 2FA enforcement, issuing recovery codes and verifying OTPs is handled by the authentication server. This records the policy preference.</ServerNote></div>
      </Section>

      <Section title="Change password" icon={KeyRound}>
        <ServerNote>For security, passwords are changed through the authentication backend — not stored or edited in the browser. Ask an administrator or use the official password-reset flow.</ServerNote>
      </Section>

      <Section title="Access & audit" desc="Login history and API access are recorded on the server." icon={ScrollText}>
        <div className="flex flex-wrap gap-2 mb-3">
          <LinkBtn onClick={() => navigate('/roles')} icon={Shield}>Roles & Permissions</LinkBtn>
        </div>
        <div className="grid sm:grid-cols-2 gap-3">
          <div className="card p-3">
            <div className="flex items-center gap-2 text-sm font-medium text-primary mb-1"><ScrollText size={15} className="text-accent" /> Login / access audit log</div>
            <p className="text-xs text-steel">Authentication events are written server-side. A read-only viewer can be surfaced here once the audit endpoint is exposed.</p>
          </div>
          <div className="card p-3">
            <div className="flex items-center gap-2 text-sm font-medium text-primary mb-1"><KeyRound size={15} className="text-accent" /> API keys / integration tokens</div>
            <p className="text-xs text-steel">No integration tokens are configured. Tokens are minted and revoked by an administrator on the server.</p>
          </div>
        </div>
      </Section>
    </>
  );
}

// ── 6 · Production & Quality ───────────────────────────────────────────────────
function ProductionSection({ s }: { s: Settings }) {
  return (
    <>
      <Section title="Product catalog" desc="Cylinder products manufactured across EKC plants." icon={Factory}>
        <TagEditor tags={s.production.products} onChange={(next) => patchSettings((d) => { d.production.products = next; })} placeholder="e.g. Type-3 Composite" />
      </Section>

      <Section title="Process stages" desc="The cylinder manufacturing flow, in order." icon={Factory}>
        <TagEditor tags={s.production.processStages} onChange={(next) => patchSettings((d) => { d.production.processStages = next; })} placeholder="e.g. Shot Blasting" />
      </Section>

      <Section title="Standards & compliance" desc="Regulatory standards the products are certified against." icon={Shield}>
        <div className="flex flex-wrap gap-1.5 mb-3">
          {STANDARD_OPTIONS.map((std) => {
            const on = s.production.standards.includes(std);
            return (
              <button key={std} onClick={() => patchSettings((d) => { d.production.standards = on ? d.production.standards.filter((x) => x !== std) : [...d.production.standards, std]; })}
                className={`pill border transition-colors ${on ? 'bg-accent/10 text-accent border-accent/30' : 'border-line text-steel hover:text-primary'}`}>
                {on && <Check size={12} />} {std}
              </button>
            );
          })}
        </div>
      </Section>

      <Section title="OEE targets" desc="Plant-wide targets used as reference on dashboards & reports." icon={FileBarChart}>
        <Row label="Availability target"><NumberField value={s.production.oee.availability} min={0} max={100} onChange={(v) => patchSettings((d) => { d.production.oee.availability = v; })} suffix="%" /></Row>
        <Row label="Performance target"><NumberField value={s.production.oee.performance} min={0} max={100} onChange={(v) => patchSettings((d) => { d.production.oee.performance = v; })} suffix="%" /></Row>
        <Row label="Quality target"><NumberField value={s.production.oee.quality} min={0} max={100} onChange={(v) => patchSettings((d) => { d.production.oee.quality = v; })} suffix="%" /></Row>
        <Row label="Target OEE" hint="Availability × Performance × Quality">
          <span className="data text-lg font-bold text-accent">{Math.round((s.production.oee.availability * s.production.oee.performance * s.production.oee.quality) / 10000)}%</span>
        </Row>
      </Section>

      <Section title="Batch / heat-number format" desc="Template for traceability codes. Tokens: {PLANT} {YYYYMMDD} {SEQ}." icon={Factory}>
        <input className={`${fieldCls} sm:w-full data`} value={s.production.batchFormat} onChange={(e) => patchSettings((d) => { d.production.batchFormat = e.target.value; })} />
        <p className="text-xs text-steel mt-2">Preview: <span className="data text-primary">{s.production.batchFormat.replace('{PLANT}', 'KASEZ').replace('{YYYYMMDD}', '20260624').replace('{SEQ}', '0042')}</span></p>
      </Section>
    </>
  );
}

// ── 7 · Reports & Compliance ───────────────────────────────────────────────────
function ReportsSection({ s }: { s: Settings }) {
  return (
    <>
      <Section title="Export defaults" desc="Default format when exporting reports & history." icon={FileBarChart}>
        <Row label="Default export format">
          <Segmented value={s.reports.defaultFormat} onChange={(v) => patchSettings((d) => { d.reports.defaultFormat = v; })}
            options={[{ value: 'csv', label: 'CSV' }, { value: 'pdf', label: 'PDF' }, { value: 'xlsx', label: 'Excel' }]} />
        </Row>
        <Row label="Telemetry retention" hint="How long to keep history in views"><NumberField value={s.reports.retentionDays} min={30} max={1825} onChange={(v) => patchSettings((d) => { d.reports.retentionDays = v; })} suffix="days" /></Row>
      </Section>

      <Section title="Scheduled reports" desc="Auto-email shift/daily summaries to managers." icon={Mail}>
        <Row label="Enable scheduling"><Toggle on={s.reports.schedule.enabled} onChange={(v) => patchSettings((d) => { d.reports.schedule.enabled = v; })} /></Row>
        {s.reports.schedule.enabled && (
          <>
            <Row label="Frequency">
              <Select value={s.reports.schedule.frequency} onChange={(v) => patchSettings((d) => { d.reports.schedule.frequency = v as Settings['reports']['schedule']['frequency']; })}
                options={[{ value: 'shift', label: 'Every shift' }, { value: 'daily', label: 'Daily' }, { value: 'weekly', label: 'Weekly' }]} />
            </Row>
            <Row label="Send at">
              <input type="time" value={s.reports.schedule.time} onChange={(e) => patchSettings((d) => { d.reports.schedule.time = e.target.value; })} className="bg-base border border-line rounded-lg px-2 py-1.5 text-sm text-primary outline-none focus:border-accent" />
            </Row>
            <Row label="Recipients" hint="Comma-separated emails">
              <input className={fieldCls} placeholder="ops@everestkanto.com, plant.head@…" value={s.reports.schedule.recipients} onChange={(e) => patchSettings((d) => { d.reports.schedule.recipients = e.target.value; })} />
            </Row>
          </>
        )}
        <div className="mt-3"><ServerNote>Actual delivery runs on the server's scheduler/mailer. These settings define what would be sent.</ServerNote></div>
      </Section>

      <Section title="Compliance & maintenance" desc="Regulated-industry essentials for cylinder manufacturing." icon={Shield}>
        <div className="grid sm:grid-cols-2 gap-3">
          <div className="card p-3">
            <div className="text-sm font-medium text-primary mb-1">Compliance / audit reports</div>
            <p className="text-xs text-steel">PESO, ISO & hydro-test certificate exports. Generated from production records on the server.</p>
          </div>
          <div className="card p-3">
            <div className="text-sm font-medium text-primary mb-1">Maintenance schedule</div>
            <p className="text-xs text-steel">Preventive-maintenance calendar per machine. Plan here once the maintenance module is enabled.</p>
          </div>
        </div>
      </Section>
    </>
  );
}

// ── 8 · System & Appearance ────────────────────────────────────────────────────
function SystemSection({ s }: { s: Settings }) {
  const t = useT();
  const [confirming, setConfirming] = useState<null | 'all'>(null);
  return (
    <>
      <Section title="Appearance" desc="Theme applies instantly across the whole app." icon={Palette}>
        <Row label="Theme">
          <Segmented<ThemeMode> value={s.appearance.theme} onChange={(v) => patchSettings((d) => { d.appearance.theme = v; })}
            options={[{ value: 'light', label: 'Light', icon: Sun }, { value: 'dark', label: 'Dark', icon: Moon }, { value: 'system', label: 'System', icon: Monitor }]} />
        </Row>
        <Row label="Density" hint="Spacing of tables & lists">
          <Segmented<Settings['appearance']['density']> value={s.appearance.density} onChange={(v) => patchSettings((d) => { d.appearance.density = v; })}
            options={[{ value: 'comfortable', label: 'Comfortable' }, { value: 'compact', label: 'Compact' }]} />
        </Row>
      </Section>

      <Section title="Units" desc="Measurement units shown across the app." icon={Monitor}>
        <Row label="Temperature">
          <Segmented value={s.units.temperature} onChange={(v) => patchSettings((d) => { d.units.temperature = v; })} options={[{ value: 'C', label: '°C' }, { value: 'F', label: '°F' }]} />
        </Row>
        <Row label="Pressure">
          <Segmented value={s.units.pressure} onChange={(v) => patchSettings((d) => { d.units.pressure = v; })} options={[{ value: 'bar', label: 'bar' }, { value: 'psi', label: 'psi' }, { value: 'kPa', label: 'kPa' }]} />
        </Row>
      </Section>

      <Section title="Reset" desc="Restore settings or clear all local display data on this device." icon={RotateCcw}>
        {confirming === null && (
          <div className="flex flex-wrap gap-2">
            <button onClick={() => { resetSettings(); toast.success('Settings restored to defaults'); }} className="flex items-center gap-1.5 text-sm px-3 py-2 rounded-lg border border-line text-steel hover:text-primary hover:border-steel transition-colors">
              <RotateCcw size={14} /> {t('Reset settings to defaults')}
            </button>
            <button onClick={() => setConfirming('all')} className="flex items-center gap-1.5 text-sm px-3 py-2 rounded-lg border border-stopped/30 text-stopped bg-stopped/5 hover:bg-stopped/10 transition-colors">
              <RotateCcw size={14} /> {t('Reset all local data')}
            </button>
          </div>
        )}
        {confirming === 'all' && (
          <div className="bg-stopped/5 border border-stopped/20 rounded-lg p-3">
            <p className="text-sm text-primary mb-1 font-medium">Clear all local display data?</p>
            <p className="text-xs text-steel mb-3">This wipes your settings, per-machine card configs and any custom departments saved in this browser, then reloads. <strong>The database is not touched.</strong></p>
            <div className="flex gap-2">
              <button onClick={() => resetAllLocalData()} className="text-sm px-3 py-1.5 rounded-lg bg-stopped text-white hover:bg-stopped/90">Yes, clear & reload</button>
              <button onClick={() => setConfirming(null)} className="text-sm px-3 py-1.5 rounded-lg border border-line text-steel hover:bg-base">Cancel</button>
            </div>
          </div>
        )}
      </Section>

      <Section title="About" icon={Info}>
        <div className="grid sm:grid-cols-2 gap-x-8 gap-y-1 text-sm">
          <Info2 label="Application" value={s.company.appName} />
          <Info2 label="Version" value={APP_VERSION} />
          <Info2 label="Company" value={s.company.legalName} />
          <Info2 label="Storage" value="Local (no DB writes)" />
        </div>
        <div className="flex flex-wrap gap-2 mt-3">
          <a href="https://everestkanto.com/" target="_blank" rel="noreferrer" className="flex items-center gap-1.5 text-sm px-3 py-2 rounded-lg border border-line text-primary hover:border-accent hover:text-accent transition-colors">
            <ExternalLink size={14} /> everestkanto.com
          </a>
        </div>
      </Section>
    </>
  );
}
