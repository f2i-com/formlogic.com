import { create } from 'zustand';

export type ToastType = 'success' | 'error' | 'warning' | 'info';

export interface Toast {
  id: string;
  type: ToastType;
  title: string;
  message?: string;
  duration?: number;
}

interface ToastState {
  toasts: Toast[];
  addToast: (toast: Omit<Toast, 'id'>) => void;
  removeToast: (id: string) => void;
  clearToasts: () => void;
}

let toastId = 0;

// Track timeout IDs for cleanup
const timeoutMap = new Map<string, ReturnType<typeof setTimeout>>();

export const useToastStore = create<ToastState>((set) => ({
  toasts: [],

  addToast: (toast) => {
    const id = `toast-${++toastId}`;
    const newToast: Toast = {
      ...toast,
      id,
      duration: toast.duration ?? 5000,
    };

    set((state) => ({
      toasts: [...state.toasts, newToast],
    }));

    // Auto-remove after duration + animation buffer (150ms)
    // The Toast component also has its own timer that triggers the exit animation,
    // so this acts as a fallback cleanup in case the component unmounts without cleanup.
    if (newToast.duration && newToast.duration > 0) {
      const timeoutId = setTimeout(() => {
        timeoutMap.delete(id);
        set((state) => ({
          toasts: state.toasts.filter((t) => t.id !== id),
        }));
      }, newToast.duration + 200);
      timeoutMap.set(id, timeoutId);
    }
  },

  removeToast: (id) => {
    // Clear any pending timeout for this toast
    const timeoutId = timeoutMap.get(id);
    if (timeoutId) {
      clearTimeout(timeoutId);
      timeoutMap.delete(id);
    }
    set((state) => ({
      toasts: state.toasts.filter((t) => t.id !== id),
    }));
  },

  clearToasts: () => {
    // Clear all pending timeouts
    timeoutMap.forEach((timeoutId) => clearTimeout(timeoutId));
    timeoutMap.clear();
    set({ toasts: [] });
  },
}));

// Convenience functions for direct usage
export const toast = {
  success: (title: string, message?: string) => {
    useToastStore.getState().addToast({ type: 'success', title, message });
  },
  error: (title: string, message?: string) => {
    useToastStore.getState().addToast({ type: 'error', title, message, duration: 7000 });
  },
  warning: (title: string, message?: string) => {
    useToastStore.getState().addToast({ type: 'warning', title, message });
  },
  info: (title: string, message?: string) => {
    useToastStore.getState().addToast({ type: 'info', title, message });
  },
};
