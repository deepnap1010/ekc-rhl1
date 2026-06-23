// client/src/lib/orgRole.ts
// Role → colour + ordering rank for the org chart. Pure presentation, inferred
// from the role key/name we already store; nothing here is persisted.
import type { User } from '../types/api';
import { displayRoleName } from './departments';

export interface RoleStyle { color: string; label: string; rank: number; }

export function roleStyle(u: Pick<User, 'isSuperAdmin' | 'role'>): RoleStyle {
  if (u.isSuperAdmin) return { color: '#0D9488', label: 'Super Admin', rank: 0 };
  const k = `${u.role?.key || ''} ${u.role?.name || ''}`.toLowerCase();
  const label = displayRoleName(u.role);
  if (k.includes('head') || k.includes('plant')) return { color: '#7C3AED', label: label || 'Head', rank: 1 };
  if (k.includes('manager'))  return { color: '#0D9488', label: label || 'Manager', rank: 2 };
  if (k.includes('supervis')) return { color: '#D97706', label: label || 'Supervisor', rank: 3 };
  if (k.includes('operator')) return { color: '#059669', label: label || 'Operator', rank: 4 };
  return { color: '#64748B', label: label || '—', rank: 5 };
}
