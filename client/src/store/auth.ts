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

export const useAuthStore = create<AuthState>()(
  persist(
    (set, get) => ({
      accessToken: null,
      refreshToken: null,
      user: null,

      setSession: ({ accessToken, refreshToken, user }) =>
        set({ accessToken, refreshToken, user }),

      setUser: (user) => set({ user }),

      logout: () => set({ accessToken: null, refreshToken: null, user: null }),

      // Permission check mirrors the backend authorize() logic
      can: (module, action = 'view') => {
        const user = get().user;
        if (!user) return false;
        if (user.isSuperAdmin) return true;
        const allowed = user.role?.permissions?.[module] || [];
        return allowed.includes(action) || allowed.includes('admin');
      },
    }),
    { name: 'ekc-auth' }
  )
);
