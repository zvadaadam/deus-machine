import { create } from "zustand";
import { api } from "../lib/api";

export interface Ref {
  ref: string;
  label?: string;
  type?: string;
  identifier?: string;
}

interface RefsState {
  refs: Ref[];
  loading: boolean;
  foreground: string | null;
  refresh: () => Promise<void>;
  /** Debounced refresh — many taps in quick succession collapse into one. */
  scheduleRefresh: (delayMs?: number) => void;
}

let scheduleTimer: ReturnType<typeof setTimeout> | undefined;

export const useRefsStore = create<RefsState>((set, get) => ({
  refs: [],
  loading: false,
  foreground: null,
  refresh: async () => {
    if (get().loading) return;
    set({ loading: true });
    try {
      const res = await api.snapshot();
      if (res.success && res.result) {
        const tree = res.result.tree as Array<{ label?: string }> | undefined;
        set({
          refs: res.result.refs as Ref[],
          foreground: tree?.[0]?.label ?? null,
        });
      }
    } finally {
      set({ loading: false });
    }
  },
  scheduleRefresh: (delayMs = 400) => {
    if (scheduleTimer) clearTimeout(scheduleTimer);
    scheduleTimer = setTimeout(() => {
      scheduleTimer = undefined;
      void get().refresh();
    }, delayMs);
  },
}));
