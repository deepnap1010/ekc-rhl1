// server/src/utils/session.ts
// Who stays signed in forever, and who does not.
//
// An operator's account IS a machine terminal: a tablet at the machine, showing
// that machine, which nobody should have to sign back into mid-shift. Everyone
// else — admins, plant heads, supervisors — keeps an ordinary session that
// expires, because those logins can change production settings and delete data,
// and a forgotten browser should not stay able to do that.
//
// Derived from the role rather than a flag on the user, so it needs no checkbox
// to remember and cannot drift: give someone the Operator role and their
// terminal stops logging out; take it away and it does not.
import type { AuthRole } from '../types/auth.js';

export const OPERATOR_ROLE_KEY = 'operator';

/** True when this account's session should never expire. */
export function sessionNeverExpires(
  role: AuthRole | null | undefined, isSuperAdmin?: boolean,
): boolean {
  if (isSuperAdmin) return false;           // never for an account that can do everything
  return String(role?.key || '').toLowerCase() === OPERATOR_ROLE_KEY;
}
