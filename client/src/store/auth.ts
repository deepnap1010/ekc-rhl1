// client/src/store/auth.ts
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { User, LoginResponse } from '../types/api';

export interface AuthState {
  accessToken: string | null;
  refreshToken: string | null;
  user: User | null;

  setSession: (session: Pick<LoginResponse, 'accessToken' | 'refreshToken' | 'user'>) => void;
  setUser: (user: User | null) => void;
  logout: () => void;

  // Permission check mirrors the backend authorize() logic.
  can: (module: string, action?: string) => boolean;
}

// Permission check mirrors the backend authorize() logic
const makeCan = (get: () => AuthState): AuthState['can'] => (module, action = 'view') => {
  const user = get().user;
  if (!user) return false;
  if (user.isSuperAdmin) return true;
  const allowed = user.role?.permissions?.[module] || [];
  return allowed.includes(action) || allowed.includes('admin');
};

// What a person may do, as one comparable string. Screens subscribe to `can`
// itself, so when this changes — the admin ticked or unticked a box for their
// role — `can` becomes a new function and every one of them re-renders.
const permSig = (u: User | null): string => JSON.stringify([!!u?.isSuperAdmin, u?.role?.permissions || null]);

export const useAuthStore = create<AuthState>()(
  persist(
    (set, get) => {
      const withCan = (prev: User | null, next: User | null): Partial<AuthState> =>
        (permSig(prev) === permSig(next) ? {} : { can: makeCan(get) });
      return {
        accessToken: null,
        refreshToken: null,
        user: null,

        setSession: ({ accessToken, refreshToken, user }) =>
          set((s) => ({ accessToken, refreshToken, user, ...withCan(s.user, user) })),

        setUser: (user) => set((s) => ({ user, ...withCan(s.user, user) })),

        logout: () => set((s) => ({ accessToken: null, refreshToken: null, user: null, ...withCan(s.user, null) })),

        can: makeCan(get),
      };
    },
    { name: 'ekc-auth' }
  )
);
