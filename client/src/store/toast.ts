// client/src/store/toast.ts
// Tiny global toast/notification store. Use the `toast` helper anywhere
// (even outside React components, e.g. event handlers): toast.success('Saved').
import { create } from 'zustand';

export type ToastType = 'success' | 'error' | 'info';

export interface Toast {
  id: number;
  type: ToastType;
  message: string;
  duration: number;
}

interface ToastState {
  toasts: Toast[];
  add: (message: string, type?: ToastType, duration?: number) => void;
  remove: (id: number) => void;
}

let counter = 0;

export const useToastStore = create<ToastState>((set) => ({
  toasts: [],
  add: (message, type = 'success', duration = 3000) =>
    set((s) => ({ toasts: [...s.toasts, { id: ++counter, type, message, duration }] })),
  remove: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
}));

// Convenience helper usable outside React components.
export const toast = {
  success: (message: string, duration?: number) => useToastStore.getState().add(message, 'success', duration),
  error: (message: string, duration?: number) => useToastStore.getState().add(message, 'error', duration),
  info: (message: string, duration?: number) => useToastStore.getState().add(message, 'info', duration),
};
