// client/src/lib/settings.ts
// Application settings — a pure CLIENT-SIDE preference layer. Like machineConfig,
// it NEVER writes to the database; everything lives in localStorage and is applied
// in the browser. The app reads real data (machines, plants, roles, products) to
// seed sensible defaults, but the database is only ever read, never mutated.
//
// Grounded in Everest Kanto Cylinder (everestkanto.com): multi-plant seamless
// gas-cylinder manufacturing (Tarapur, KASEZ, Dubai, Tianjin, Pittsburgh).
import { useEffect, useReducer } from 'react';
import { EKC_PLANTS, PROCESS_STAGES, CYLINDER_PRODUCTS } from './machineConfig';

export type ThemeMode = 'light' | 'dark' | 'system';
export type Density = 'comfortable' | 'compact';
export type Severity = 'info' | 'warning' | 'critical';

export interface ShiftTiming { name: string; start: string; end: string }

export interface Settings {
  // 1 · Profile & Account — personal preferences (identity itself comes from auth/DB).
  // displayName / photo are LOCAL overrides; the real account in the DB is untouched.
  account: {
    displayName: string;   // local alias shown to this user (falls back to account name)
    photoDataUrl: string;  // compressed avatar stored locally ('' → default icon)
  };
  locale: {
    language: string;        // UI language preference
    region: string;          // Intl locale for date/number formatting
    timeFormat: '12h' | '24h';
    timezone: string;        // 'auto' or an IANA zone
  };
  appearance: {
    theme: ThemeMode;
    density: Density;
  };
  notifications: {
    inApp: boolean;
    email: boolean;
    sms: boolean;
    whatsapp: boolean;
    teams: boolean;
    sound: boolean;
  };
  // 2 · Company & Plants
  company: {
    appName: string;         // brand shown in the sidebar
    legalName: string;
    tagline: string;
    defaultPlant: string;    // pre-selected plant for new employees
  };
  shifts: ShiftTiming[];
  // 4 · Alerts & Downtime
  alerts: {
    tempWarn: number; tempCrit: number;          // °C
    pressureWarn: number; pressureCrit: number;  // bar
    minSeverity: Severity;                        // lowest severity that notifies
    escalation: boolean;                          // operator → supervisor → manager
    quietHours: { enabled: boolean; from: string; to: string };
  };
  downtime: { reasons: string[] };
  // 5 · Security & Access (preferences; real enforcement is server-side)
  security: {
    passwordMinLength: number;
    requireUppercase: boolean;
    requireNumber: boolean;
    requireSymbol: boolean;
    passwordExpiryDays: number;
    sessionTimeoutMin: number;
    twoFactor: boolean;
  };
  // 6 · Production & Quality (EKC-specific)
  production: {
    products: string[];
    processStages: string[];
    standards: string[];
    oee: { availability: number; performance: number; quality: number };
    batchFormat: string;
  };
  // 7 · Reports & Compliance
  reports: {
    defaultFormat: 'csv' | 'pdf' | 'xlsx';
    retentionDays: number;
    schedule: { enabled: boolean; frequency: 'daily' | 'weekly' | 'shift'; time: string; recipients: string };
  };
  // 8 · System / Units
  units: {
    temperature: 'C' | 'F';
    pressure: 'bar' | 'psi' | 'kPa';
  };
}

export const APP_VERSION = '1.0.0';

export const LANGUAGES = [
  { code: 'en', label: 'English' },
  { code: 'hi', label: 'हिन्दी (Hindi)' },
];
export const REGIONS = [
  { code: 'en-IN', label: 'India (en-IN)' },
  { code: 'en-AE', label: 'UAE (en-AE)' },
  { code: 'en-US', label: 'USA (en-US)' },
];
export const STANDARD_OPTIONS = ['ISO 11439', 'ISO 9809', 'PESO (India)', 'DOT (USA)', 'TPED (EU)', 'GB (China)'];

// EKC plant timezones — used to suggest a sensible timezone per plant.
export const PLANT_TIMEZONES: Record<string, string> = {
  'Tarapur': 'Asia/Kolkata',
  'KASEZ (Gandhidham)': 'Asia/Kolkata',
  'Dubai – Plant I': 'Asia/Dubai',
  'Dubai – Plant II': 'Asia/Dubai',
  'Tianjin (China)': 'Asia/Shanghai',
  'Pittsburgh (USA)': 'America/New_York',
};

function defaults(): Settings {
  return {
    account: { displayName: '', photoDataUrl: '' },
    locale: { language: 'en', region: 'en-IN', timeFormat: '12h', timezone: 'auto' },
    appearance: { theme: 'light', density: 'comfortable' },
    notifications: { inApp: true, email: false, sms: false, whatsapp: false, teams: false, sound: true },
    company: {
      appName: 'EKC SmartFactory',
      legalName: 'Everest Kanto Cylinder Ltd.',
      tagline: 'Production Monitor',
      defaultPlant: 'KASEZ (Gandhidham)',
    },
    shifts: [
      { name: 'Shift A', start: '06:00', end: '14:00' },
      { name: 'Shift B', start: '14:00', end: '22:00' },
      { name: 'Shift C', start: '22:00', end: '06:00' },
      { name: 'General', start: '09:00', end: '18:00' },
    ],
    alerts: {
      tempWarn: 850, tempCrit: 950,
      pressureWarn: 200, pressureCrit: 250,
      minSeverity: 'warning',
      escalation: true,
      quietHours: { enabled: false, from: '22:00', to: '06:00' },
    },
    downtime: {
      reasons: ['Planned Maintenance', 'Breakdown', 'Tool Change', 'Material Shortage', 'No Operator', 'Quality Hold', 'Power Failure', 'Changeover'],
    },
    security: {
      passwordMinLength: 8,
      requireUppercase: true,
      requireNumber: true,
      requireSymbol: false,
      passwordExpiryDays: 90,
      sessionTimeoutMin: 30,
      twoFactor: false,
    },
    production: {
      products: [...CYLINDER_PRODUCTS],
      processStages: [...PROCESS_STAGES],
      standards: ['ISO 11439', 'PESO (India)', 'DOT (USA)'],
      oee: { availability: 90, performance: 85, quality: 99 },
      batchFormat: 'EKC-{PLANT}-{YYYYMMDD}-{SEQ}',
    },
    reports: {
      defaultFormat: 'csv',
      retentionDays: 365,
      schedule: { enabled: false, frequency: 'daily', time: '07:00', recipients: '' },
    },
    units: { temperature: 'C', pressure: 'bar' },
  };
}

// Merge stored prefs over defaults so older saved blobs stay valid as the schema grows.
function withDefaults(raw: Partial<Settings> | null): Settings {
  const d = defaults();
  if (!raw) return d;
  return {
    account: { ...d.account, ...raw.account },
    locale: { ...d.locale, ...raw.locale },
    appearance: { ...d.appearance, ...raw.appearance },
    notifications: { ...d.notifications, ...raw.notifications },
    company: { ...d.company, ...raw.company },
    shifts: raw.shifts?.length ? raw.shifts : d.shifts,
    alerts: { ...d.alerts, ...raw.alerts, quietHours: { ...d.alerts.quietHours, ...raw.alerts?.quietHours } },
    downtime: { reasons: raw.downtime?.reasons?.length ? raw.downtime.reasons : d.downtime.reasons },
    security: { ...d.security, ...raw.security },
    production: { ...d.production, ...raw.production, oee: { ...d.production.oee, ...raw.production?.oee } },
    reports: { ...d.reports, ...raw.reports, schedule: { ...d.reports.schedule, ...raw.reports?.schedule } },
    units: { ...d.units, ...raw.units },
  };
}

// ── localStorage store + pub/sub (mirrors machineConfig's pattern) ─────────────
const STORE_KEY = 'ekc.settings.v1';
// Other client-only display stores wiped by "Reset local data".
const MACHINE_CONFIG_KEY = 'ekc.machine.config.v1';
const CUSTOM_DEPARTMENTS_KEY = 'ekc.custom.departments.v1';

const listeners = new Set<() => void>();

export function getSettings(): Settings {
  try { return withDefaults(JSON.parse(localStorage.getItem(STORE_KEY) || 'null')); }
  catch { return defaults(); }
}

export function saveSettings(next: Settings): void {
  localStorage.setItem(STORE_KEY, JSON.stringify(next));
  listeners.forEach((fn) => fn());
}

// Ergonomic mutator — clone, mutate in place, persist. Settings are plain JSON.
export function patchSettings(mutate: (draft: Settings) => void): void {
  const next = JSON.parse(JSON.stringify(getSettings())) as Settings;
  mutate(next);
  saveSettings(next);
}

export function resetSettings(): void {
  localStorage.removeItem(STORE_KEY);
  listeners.forEach((fn) => fn());
}

// Wipe every client-side display store (settings + machine config + custom depts),
// then hard-reload so all open views reflect the cleared state. The DB is untouched.
export function resetAllLocalData(): void {
  [STORE_KEY, MACHINE_CONFIG_KEY, CUSTOM_DEPARTMENTS_KEY].forEach((k) => localStorage.removeItem(k));
  listeners.forEach((fn) => fn());
  window.location.reload();
}

export function defaultSettings(): Settings { return defaults(); }

// React hook — live settings, re-rendering on every save.
export function useSettings(): Settings {
  const [, force] = useReducer((c: number) => c + 1, 0);
  useEffect(() => { listeners.add(force); return () => { listeners.delete(force); }; }, []);
  return getSettings();
}

// ── Theme application ─────────────────────────────────────────────────────────
function prefersDark(): boolean {
  return typeof window !== 'undefined' && window.matchMedia?.('(prefers-color-scheme: dark)').matches;
}

export function applyTheme(): void {
  const mode = getSettings().appearance.theme;
  const dark = mode === 'dark' || (mode === 'system' && prefersDark());
  document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
}

// Call once at startup: apply the saved theme, re-apply on every settings change,
// and follow the OS theme while in "system" mode.
export function initTheme(): void {
  applyTheme();
  listeners.add(applyTheme);
  window.matchMedia?.('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (getSettings().appearance.theme === 'system') applyTheme();
  });
}

// Re-export the EKC option lists so the Settings UI can build selects from one place.
export { EKC_PLANTS, PROCESS_STAGES, CYLINDER_PRODUCTS };
