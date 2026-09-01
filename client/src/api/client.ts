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
    // A 401 normally means the session ended, so we clear it. An operator's
    // session has no end — its token never expires — so a 401 there can only be
    // a server restart mid-request or an account someone switched off. Neither
    // should drop the tablet on the shop floor to a login screen by itself: the
    // request fails, the error shows, and it keeps working the moment the
    // server answers again.
    const me = useAuthStore.getState().user;
    const isOperator = String(me?.role?.key || '').toLowerCase() === 'operator' && !me?.isSuperAdmin;
    if (err.response?.status === 401 && !isOperator) {
      useAuthStore.getState().logout();
    }
    const message = err.response?.data?.error?.message || err.message;
    return Promise.reject(new Error(message));
  }
);
