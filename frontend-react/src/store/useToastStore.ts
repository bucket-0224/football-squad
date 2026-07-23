import { create } from 'zustand';

interface ToastState {
  message: string | null;
  show: (msg: string) => void;
}

let timer: ReturnType<typeof setTimeout> | null = null;

export const useToastStore = create<ToastState>((set) => ({
  message: null,
  show: (msg) => {
    if (timer) clearTimeout(timer);
    set({ message: msg });
    timer = setTimeout(() => set({ message: null }), 2200);
  },
}));

// Convenience for non-component call sites (event handlers, catch blocks).
export function toast(msg: string) {
  useToastStore.getState().show(msg);
}
