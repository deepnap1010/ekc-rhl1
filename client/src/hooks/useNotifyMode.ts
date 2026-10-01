// client/src/hooks/useNotifyMode.ts
// How THIS user hears about an event — popup, a quiet notice, or nothing —
// by the admin's notification workflow (Settings → Alerts & Downtime). The
// same three-step rule the server applies to the queues and the answers
// (server/src/utils/notifyFlow.ts): the admin's explicit rule for the role,
// else the convention that a role calling itself an operator is asked and
// nobody else is. The event's own master switch (classification popup on/off,
// downtime popup on/off) stays with the popup that owns it.
//
// Returns null while /config is still in flight: a popup must not open on a
// guess and then vanish, and a notice must not fire for a role about to be
// read as 'off'. On the review copy a popup is a notice — nothing there can
// take an answer.
import { useAppConfig } from './useAppConfig';
import { useAuthStore } from '../store/auth';
import type { NotifyEventKey, NotifyFlowConfig, NotifyMode } from '../types/api';

// "Opr" is the plant's own abbreviation (its downtime reasons say "No Opr").
const OPERATOR_RE = /operator|\bopr\b/i;
const roleKeyOf = (key: unknown): string => String(key ?? '').trim().toLowerCase();
/** A role that calls itself an operator is the machine's TERMINAL: the one
 *  screen whose countdown running out means "nobody answered". Any other
 *  popup screen that runs out just dismisses locally — a plant head's office
 *  browser must not take the ask away from the operator at the machine. */
export const isOperatorRole = (role: { key?: string | null; name?: string | null } | null | undefined): boolean =>
  OPERATOR_RE.test(`${role?.key || ''} ${role?.name || ''}`.replace(/[._/-]+/g, ' '));

/** Pure rule — shared with the Settings matrix, which shows the EFFECTIVE mode
 *  of every role before the admin has chosen anything. An account with no
 *  role has no row there, so it keeps the rule that held before the workflow:
 *  asked for the machines assigned to it, nothing otherwise. */
export function notifyModeFor(
  flow: Pick<NotifyFlowConfig, 'rules'>, event: NotifyEventKey,
  role: { key?: string | null; name?: string | null } | null | undefined, hasMachines = false,
): NotifyMode {
  if (!role) return hasMachines ? 'popup' : 'off';
  // An own-property read: a role keyed "constructor" must find no rule.
  const byRole = flow.rules[event];
  const k = roleKeyOf(role.key);
  const explicit = byRole && Object.prototype.hasOwnProperty.call(byRole, k) ? byRole[k] : undefined;
  if (explicit) return explicit;
  return isOperatorRole(role) ? 'popup' : 'off';
}

export function useNotifyMode(event: NotifyEventKey): NotifyMode | null {
  const user = useAuthStore((s) => s.user);
  const { notifyFlow, fromServer, readOnly } = useAppConfig();
  if (!fromServer) return null;
  // A server from before the workflow sends no rules: the default rule is
  // then exactly what it did — operators asked, nobody else.
  const mode = notifyModeFor(notifyFlow ?? { rules: {} }, event, user?.role, (user?.assignedMachines?.length ?? 0) > 0);
  return readOnly && mode === 'popup' ? 'notify' : mode;
}
