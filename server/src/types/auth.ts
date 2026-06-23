// Shared shapes for authentication: JWT payloads and the `req.user` value.
import type { Types } from 'mongoose';

// The signed JWT payload. `sub` is the user id (or the bootstrap sentinel),
// `sa` mirrors isSuperAdmin, `role` carries the role key when present.
export interface JwtPayload {
  sub: string;
  sa?: boolean;
  role?: string;
}

// A role as it travels on `req.user` (lean, populated). `permissions` is either
// a Mongoose Map (live document) or a plain object (lean), so authorize() handles both.
export interface AuthRole {
  _id?: Types.ObjectId | string;
  name?: string;
  key?: string;
  permissions?: Map<string, string[]> | Record<string, string[]>;
}

// The user attached to the request by `authenticate`. This unifies the lean
// User document (with populated role) and the synthetic bootstrap user, so
// only the fields the auth layer actually reads are required here.
export interface AuthUser {
  _id: Types.ObjectId | string;
  name?: string;
  email?: string;
  plant?: string;
  isSuperAdmin?: boolean;
  role?: AuthRole | null;
  assignedMachines?: string[];
  active?: boolean;
  bootstrap?: boolean;
  [key: string]: unknown;
}
