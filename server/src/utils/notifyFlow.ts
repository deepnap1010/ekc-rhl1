// server/src/utils/notifyFlow.ts
// Who is told what, and how — the admin's notification workflow.
//
// Two things happen on the floor that someone must answer for: a counter
// advanced (which class is this piece?) and a machine stood idle or stopped
// past the ask-after mark (why?). Each used to reach whoever had machines
// assigned — which doubles as the VISIBILITY scope, so a plant head given
// machines to watch was being popped like an operator. The workflow here
// routes every such event by ROLE, in one of three ways:
//   popup  — the full-screen ask with the answer buttons (the operator's screen);
//   notify — a quiet in-app notice, nothing to answer, nothing written;
//   off    — silence.
// Which machines a person hears about is still their scope (utils/scope):
// the machines assigned to them, or every machine when none are.
//
// The events are code-owned (one entry here, one consumer each); the rules are
// the admin's and live in the app_config singleton under `notifyFlow`, like
// prodClass and downtimeAsk. Only explicit choices are stored: a role with no
// rule falls back to the plant's convention that whoever calls themselves an
// operator is asked, and nobody else is — the same convention the
// never-expiring operator session keys on (utils/session).
import { AppConfig } from '../models/AppConfig.js';
import { env } from '../config/env.js';
import { refIn } from './machineRef.js';
import type { AuthUser } from '../types/auth.js';

export const NOTIFY_MODES = ['popup', 'notify', 'off'] as const;
export type NotifyMode = (typeof NOTIFY_MODES)[number];
export type NotifyEventKey = 'productionClass' | 'downtimeReason' | 'diaInstruction';

export interface NotifyEvent {
  key: NotifyEventKey;
  label: string;    // what the admin sees in the matrix
  ask: string;      // what the popup asks
  master: string;   // the switch that turns the whole event off, named for the admin ('' = none)
}
export const NOTIFY_EVENTS: readonly NotifyEvent[] = [
  { key: 'productionClass', label: 'Production count increased', ask: 'What was this production?', master: 'Production classification popup' },
  { key: 'downtimeReason', label: 'Machine idle or stopped for too long', ask: 'What was the reason?', master: 'Downtime reason popup' },
  { key: 'diaInstruction', label: 'Dia instruction set for a machine', ask: 'Got it?', master: '' },
];

/** event key → role key (lower-cased) → mode. Absent = the default rule. */
export interface NotifyFlowConfig {
  rules: Partial<Record<NotifyEventKey, Record<string, NotifyMode>>>;
}
export const DEFAULT_NOTIFY_FLOW: NotifyFlowConfig = { rules: {} };
export const MAX_RULES = 200;

// Role keys are whatever the admin typed on the Roles page (nothing lower-
// cases them), so every comparison goes through this.
export const roleKeyOf = (key: unknown): string => String(key ?? '').trim().toLowerCase();
/** The default when no rule names the role: a role that calls itself an
 *  operator is asked, every other role is not. "Opr" is the plant's own
 *  abbreviation (its downtime reasons say "No Opr"). */
export const OPERATOR_RE = /operator|\bopr\b/i;
/** A role that calls itself an operator IS the machine's terminal — the one
 *  screen whose countdown running out means "nobody answered", and the one
 *  whose answers need no audit beyond the row itself. Wider than the exact
 *  key utils/session keeps the never-expiring login on: a login that never
 *  expires is a bigger grant than a popup. Key and name, with the usual
 *  separators as spaces so "cnc_opr" reads as "cnc opr". */
export const isOperatorRole = (role: { key?: string | null; name?: string | null } | null | undefined): boolean =>
  OPERATOR_RE.test(`${role?.key || ''} ${role?.name || ''}`.replace(/[._/-]+/g, ' '));

const isMode = (v: unknown): v is NotifyMode => typeof v === 'string' && (NOTIFY_MODES as readonly string[]).includes(v);
const isEventKey = (v: string): v is NotifyEventKey => NOTIFY_EVENTS.some((e) => e.key === v);

/** Validate + normalize a stored or admin-submitted workflow. Returns the clean
 *  config, or a human-readable error. null/undefined = nothing stored = defaults. */
export function normalizeNotifyFlow(raw: unknown): NotifyFlowConfig | string {
  if (raw == null) return { rules: {} };
  if (typeof raw !== 'object' || Array.isArray(raw)) return 'notification workflow must be an object';
  const r = (raw as { rules?: unknown }).rules;
  if (r == null) return { rules: {} };
  if (typeof r !== 'object' || Array.isArray(r)) return 'notification rules must be an object of event → role → mode';
  const rules: NotifyFlowConfig['rules'] = {};
  let n = 0;
  for (const [ev, byRole] of Object.entries(r as Record<string, unknown>)) {
    // An event this build no longer registers is dropped, not fatal: one
    // stale key must not throw away every rule the admin did set.
    if (!isEventKey(ev)) continue;
    if (!byRole || typeof byRole !== 'object' || Array.isArray(byRole)) return `rules for "${ev}" must be an object of role → mode`;
    const out: Record<string, NotifyMode> = {};
    for (const [role, mode] of Object.entries(byRole as Record<string, unknown>)) {
      const k = roleKeyOf(role);
      // Keys become field names of the stored document: no dots, no dollars.
      if (!k || k.length > 64 || /[.$]/.test(k)) return 'a role key must be 1–64 characters, without . or $';
      if (!isMode(mode)) return `"${String(mode)}" is not a notification mode (popup, notify or off)`;
      if (++n > MAX_RULES) return `at most ${MAX_RULES} notification rules`;
      out[k] = mode;
    }
    if (Object.keys(out).length) rules[ev] = out;
  }
  return { rules };
}

/** How this role hears about this event: the admin's rule, else the default.
 *  An account with no role (a super admin's, typically) has no row in the
 *  matrix, so it keeps the rule that held before the workflow existed: asked
 *  for the machines assigned to it, nothing otherwise. The event's own master
 *  switch (prodClass.enabled / downtimeAsk.enabled) is the caller's check, as
 *  it was before the workflow existed. */
export function notifyModeFor(
  cfg: NotifyFlowConfig, event: NotifyEventKey, role: { key?: string | null; name?: string | null } | null | undefined,
  hasMachines = false,
): NotifyMode {
  if (!role) return hasMachines ? 'popup' : 'off';
  // An own-property read: a role keyed "constructor" must find no rule, not
  // Object's constructor.
  const byRole = cfg.rules[event];
  const k = roleKeyOf(role.key);
  const explicit = byRole && Object.prototype.hasOwnProperty.call(byRole, k) ? byRole[k] : undefined;
  if (explicit) return explicit;
  return isOperatorRole(role) ? 'popup' : 'off';
}

// ── cached read ──────────────────────────────────────────────────────────────
// One config lookup per TTL instead of one per queue poll. Never throws: a
// corrupt or unreachable document reads as the defaults.
const CACHE_MS = 30_000;
let cache: { at: number; cfg: NotifyFlowConfig } | null = null;

export async function getNotifyFlowConfig(): Promise<NotifyFlowConfig> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.cfg;
  let cfg = DEFAULT_NOTIFY_FLOW;
  try {
    const doc = await AppConfig.findOne({ key: 'global' }).select({ notifyFlow: 1 }).lean();
    const norm = normalizeNotifyFlow(doc?.notifyFlow);
    if (typeof norm !== 'string') cfg = norm;
  } catch { /* DB hiccup → defaults */ }
  cache = { at: Date.now(), cfg };
  return cfg;
}
export function invalidateNotifyFlowCache(): void { cache = null; }

/** Drop every rule naming this role — for a role being deleted. Fails soft:
 *  an orphan rule is harmless (nothing resolves to a key no role carries),
 *  and the next Save from the matrix rewrites the rules without it anyway. */
export async function forgetRoleRules(roleKey: unknown): Promise<void> {
  const k = roleKeyOf(roleKey);
  if (!k || /[.$]/.test(k)) return;
  try {
    await AppConfig.updateOne({ key: 'global' }, { $unset: Object.fromEntries(NOTIFY_EVENTS.map((e) => [`notifyFlow.rules.${e.key}.${k}`, 1])) });
    cache = null;
  } catch { /* see above */ }
}

/** How this user hears about this event, as THIS deployment can deliver it:
 *  the review copy (READ_ONLY) cannot take an answer, so its popups are
 *  notices. Super admins get no special treatment here — routing is the
 *  admin's rule for everyone, and the audited PATCH endpoints remain theirs. */
export async function notifyModeOf(user: AuthUser | undefined, event: NotifyEventKey): Promise<NotifyMode> {
  const mode = notifyModeFor(await getNotifyFlowConfig(), event, user?.role, popupMachines(user).length > 0);
  return env.readOnly && mode === 'popup' ? 'notify' : mode;
}

/** The machines a POPUP covers: the ones assigned to the person, exactly —
 *  never "everything". A popup can be answered, and an answer (or a terminal's
 *  countdown running out) takes the ask away from every other screen, so
 *  "no machines assigned" must mean no popups, not the whole plant's. A
 *  NOTICE writes nothing and may cover everything the person can see
 *  (utils/scope). */
export const popupMachines = (user: AuthUser | undefined): string[] =>
  (Array.isArray(user?.assignedMachines) ? user.assignedMachines : []).filter(Boolean);

/** Whether this event's POPUP reaches this user for this machine — the rule
 *  behind every popup answer: the workflow routes the role to 'popup' (a
 *  notice-only role reads, an unrouted role sees nothing) and the machine is
 *  one of theirs. */
export async function popupReaches(user: AuthUser | undefined, event: NotifyEventKey, machineId: string): Promise<boolean> {
  if (!user) return false;
  if ((await notifyModeOf(user, event)) !== 'popup') return false;
  return refIn(popupMachines(user), machineId);
}
