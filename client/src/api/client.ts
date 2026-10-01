// client/src/api/client.ts
import axios, { type AxiosError, type InternalAxiosRequestConfig } from 'axios';
import { useAuthStore } from '../store/auth';
import { refreshSocketAuth } from '../lib/socket';
import type { ApiError, LoginResponse } from '../types/api';

export const api = axios.create({ baseURL: '/api/v1' });

// Attach bearer token to every request
api.interceptors.request.use((config: InternalAxiosRequestConfig) => {
  const token = useAuthStore.getState().accessToken;
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

// ── Session renewal ───────────────────────────────────────────────────────────
// Everyone but an operator holds a 12-hour access token and a 7-day refresh
// token. The session renews itself: a 401 on any call trades the refresh
// token for a new pair (once, in flight for every caller at the same time)
// and retries the call; hooks/useSessionRenewal does the same ten minutes
// BEFORE the access token runs out, so a supervisor's screen left open over
// a shift never falls to the sign-in page. Only a refusal — the refresh token
// itself expired, the account switched off, the secret changed — signs the
// person out; a server that is merely restarting (a deploy) is not a refusal,
// and the call simply fails until the next poll.
type Renewal = 'ok' | 'denied' | 'offline';
let renewing: Promise<Renewal> | null = null;
export function renewSession(): Promise<Renewal> {
  const { refreshToken, user } = useAuthStore.getState();
  if (!refreshToken) return Promise.resolve('denied');
  if (!renewing) {
    // A bare client: no bearer, no interceptor — a 401 here must not recurse.
    renewing = axios.post<{ data?: LoginResponse }>('/api/v1/auth/refresh', { refreshToken })
      .then((r): Renewal => {
        const d = r.data?.data;
        if (!d?.accessToken) return 'denied';
        useAuthStore.getState().setSession({ accessToken: d.accessToken, refreshToken: d.refreshToken, user: d.user ?? user! });
        refreshSocketAuth(d.accessToken);
        return 'ok';
      })
      .catch((e: AxiosError): Renewal => (e.response ? 'denied' : 'offline'))
      .finally(() => { renewing = null; });
  }
  return renewing;
}

type Retried = InternalAxiosRequestConfig & { _retried?: boolean };

// Unwrap { success, data, meta } and bubble clean errors
api.interceptors.response.use(
  (res) => res.data,
  async (err: AxiosError<{ error?: ApiError }>) => {
    const cfg = err.config as Retried | undefined;
    const url = cfg?.url || '';
    if (err.response?.status === 401 && cfg && !cfg._retried && !url.includes('/auth/login') && !url.includes('/auth/refresh')) {
      const r = await renewSession();
      if (r === 'ok') { cfg._retried = true; return api(cfg); }
      // A 401 the refresh could not answer is the server saying it will not
      // accept this session at all — the only way forward is to sign in
      // again. Refusing to clear the session would strand the screen where
      // every request fails and the sign-in form is unreachable.
      if (r === 'denied') useAuthStore.getState().logout();
    }
    const message = err.response?.data?.error?.message || err.message;
    return Promise.reject(new Error(message));
  }
);
