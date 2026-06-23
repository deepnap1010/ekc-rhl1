// server/src/controllers/auth.controller.ts
import { User } from '../models/User.js';
import { signAccessToken, signRefreshToken } from '../utils/jwt.js';
import { ok, fail, asyncHandler } from '../utils/http.js';
import { env } from '../config/env.js';
import { BOOTSTRAP_SUB, isBootstrapMode, bootstrapUser } from '../utils/bootstrap.js';
import type { JwtPayload, AuthRole } from '../types/auth.js';

// Structural view of whatever sanitize() is handed: a hydrated/lean User doc or
// the synthetic bootstrap user. role is the populated role (or null).
interface SanitizableUser {
  _id: unknown;
  name?: string;
  email?: string;
  plant?: string;
  isSuperAdmin?: boolean;
  role?: AuthRole | null;
  assignedMachines?: string[];
}

export const login = asyncHandler(async (req, res) => {
  const { email, password } = req.body as { email?: string; password?: string };
  if (!email || !password) return fail(res, 400, 'Email and password required');
  const lcEmail = email.toLowerCase();

  // ── Bootstrap: no users in the DB yet. Validate against env creds, persist nothing ──
  if (await isBootstrapMode()) {
    if (lcEmail === env.adminEmail && password === env.adminPassword) {
      const payload: JwtPayload = { sub: BOOTSTRAP_SUB, sa: true };
      return ok(res, {
        accessToken:  signAccessToken(payload),
        refreshToken: signRefreshToken(payload),
        user:         sanitize(bootstrapUser()),
        bootstrap:    true,
      });
    }
    return fail(res, 401, 'Invalid credentials');
  }

  // ── Normal DB-backed login ──
  const user = await User.findOne({ email: lcEmail }).select('+passwordHash').populate('role');
  if (!user || !user.active) return fail(res, 401, 'Invalid credentials');

  const valid = await user.verifyPassword(password);
  if (!valid) return fail(res, 401, 'Invalid credentials');

  user.lastLoginAt = new Date();
  await user.save();

  // role is populated here, so it carries the AuthRole fields (key, etc.).
  const role = user.role as unknown as AuthRole | null;
  const payload: JwtPayload = { sub: user._id.toString(), role: role?.key, sa: user.isSuperAdmin };
  return ok(res, {
    accessToken:  signAccessToken(payload),
    refreshToken: signRefreshToken(payload),
    user:         sanitize(user as unknown as SanitizableUser),
  });
});

export const me = asyncHandler(async (req, res) => {
  if (req.user?.bootstrap) return ok(res, sanitize(bootstrapUser()));
  const user = await User.findById(req.user?._id).populate('role').lean();
  return ok(res, sanitize(user as unknown as SanitizableUser));
});

function sanitize(user: SanitizableUser) {
  return {
    id: user._id,
    name: user.name,
    email: user.email,
    plant: user.plant,
    isSuperAdmin: user.isSuperAdmin,
    role: user.role
      ? {
          id: user.role._id,
          name: user.role.name,
          key: user.role.key,
          permissions: user.role.permissions instanceof Map
            ? Object.fromEntries(user.role.permissions)
            : user.role.permissions,
        }
      : null,
    assignedMachines: user.assignedMachines || [],
  };
}
