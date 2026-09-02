// client/src/api/client.ts
import axios, { type AxiosError, type InternalAxiosRequestConfig } from 'axios';
import { useAuthStore } from '../store/auth';
import type { ApiError } from '../types/api';

export const api = axios.create({ baseURL: '/api/v1' });

// Attach bearer token to every request
api.interceptors.request.use((config: InternalAxiosRequestConfig) => {
  const token = useAuthStore.getState().accessToken;
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

// Unwrap { success, data, meta } and bubble clean errors
api.interceptors.response.use(
  (res) => res.data,
  (err: AxiosError<{ error?: ApiError }>) => {
    // What keeps an operator signed in is that their token never expires
    // (utils/session), not anything here. A 401 is the server saying it will
    // not accept this token AT ALL — the account was switched off, the secret
    // changed, or the token predates the no-expiry rule — and in every one of
    // those cases the only way forward is to sign in again. Refusing to clear
    // the session would strand the tablet on a screen where every request
    // fails and the sign-in form is unreachable, which is worse than the
    // logout it was trying to avoid.
    if (err.response?.status === 401) {
      useAuthStore.getState().logout();
    }
    const message = err.response?.data?.error?.message || err.message;
    return Promise.reject(new Error(message));
  }
);
