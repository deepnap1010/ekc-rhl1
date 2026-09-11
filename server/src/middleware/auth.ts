// server/src/middleware/auth.ts
import type { Request, Response, NextFunction, RequestHandler } from 'express';
import { verifyToken } from '../utils/jwt.js';
import { fail } from '../utils/http.js';
import { User } from '../models/User.js';
import { BOOTSTRAP_SUB, isBootstrapMode, bootstrapUser } from '../utils/bootstrap.js';
import type { AuthUser, AuthRole } from '../types/auth.js';

// Verifies the bearer token, loads user + role into req.user
export async function authenticate(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void | Response> {
  try {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) return fail(res, 401, 'Authentication required');

    const decoded = verifyToken(token);

    // Bootstrap session — valid only while no real users exist.
    if (decoded.sub === BOOTSTRAP_SUB) {
      if (await isBootstrapMode()) { req.user = bootstrapUser(); return next(); }
      return fail(res, 401, 'Bootstrap session expired — please sign in');
    }

    const user = await User.findById(decoded.sub).populate('role').lean();
    if (!user || !user.active) return fail(res, 401, 'Invalid or inactive account');

    // The populated, lean document carries the user + its role; surface it on the
    // request as our unified AuthUser shape (role is populated here, not an ObjectId).
    req.user = user as unknown as AuthUser;
    next();
  } catch (err) {
    return fail(res, 401, 'Session expired or invalid token');
  }
}

// Guards a route by module + action. Super admin bypasses everything.
/** The same rule authorize() enforces, as a plain predicate — for handlers
 *  whose access is a COMBINATION (e.g. "history editors, or the machine's own
 *  operator") that a single route-level module/action cannot express. */
export function userCan(user: AuthUser | undefined, module: string, action = 'view'): boolean {
  if (!user) return false;
  if (user.isSuperAdmin) return true;
  const perms: AuthRole['permissions'] = user.role?.permissions || {};
  const allowed = perms instanceof Map ? (perms.get(module) || []) : (perms[module] || []);
  return allowed.includes(action) || allowed.includes('admin');
}

export function authorize(module: string, action = 'view'): RequestHandler {
  return (req, res, next) => {
    const user = req.user;
    if (!user) return fail(res, 401, 'Authentication required');
    if (userCan(user, module, action)) return next();
    return fail(res, 403, `Not allowed to ${action} ${module}`);
  };
}
