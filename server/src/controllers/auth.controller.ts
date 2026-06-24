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
  avatar?: string;
  lastLoginAt?: Date | null;
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

// Self-service profile edit — the authenticated user updates their OWN name / email.
// Only touches existing fields (no schema change). Any logged-in user may edit their
// own profile, so it deliberately has no module-permission gate.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const updateMe = asyncHandler(async (req, res) => {
  if (req.user?.bootstrap) {
    return fail(res, 400, 'Profile editing is not available for the bootstrap admin — create a real user first.');
  }
  const { name, email, avatar } = req.body as { name?: string; email?: string; avatar?: string };
  const update: { name?: string; email?: string; avatar?: string } = {};
  if (typeof name === 'string' && name.trim()) update.name = name.trim();
  if (typeof email === 'string' && email.trim()) {
    const lc = email.trim().toLowerCase();
    if (!EMAIL_RE.test(lc)) return fail(res, 400, 'Please enter a valid email address');
    update.email = lc;
  }
  if (typeof avatar === 'string') update.avatar = avatar; // '' clears the photo
  if (!Object.keys(update).length) return fail(res, 400, 'Nothing to update');

  try {
    const user = await User
      .findByIdAndUpdate(req.user?._id, { $set: update }, { new: true, runValidators: true })
      .populate('role')
      .lean();
    if (!user) return fail(res, 404, 'User not found');
    return ok(res, sanitize(user as unknown as SanitizableUser));
  } catch (e: unknown) {
    if (e && typeof e === 'object' && (e as { code?: number }).code === 11000) {
      return fail(res, 409, 'That email is already in use by another account');
    }
    throw e;
  }
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
    avatar: user.avatar || '',
    lastLoginAt: user.lastLoginAt ?? null,
  };
}
