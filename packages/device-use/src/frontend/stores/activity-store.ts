import { create } from "zustand";

export interface ToolEvent {
  type: "tool-event";
  id: string;
  at: number;
  tool: string;
  params: unknown;
  status: "started" | "completed" | "failed";
  result?: unknown;
  error?: string;
}

interface ActivityState {
  events: ToolEvent[];
  toasts: Array<{ id: string; at: number; tool: string; status: string; error?: string }>;
  push: (event: ToolEvent) => void;
  clear: () => void;
}

const MAX = 100;
const TOAST_MS = 2500;

export const useActivityStore = create<ActivityState>((set, get) => ({
  events: [],
  toasts: [],
  push: (event) => {
    // Keep a rolling window; dedupe by id+status so started and completed
    // both appear.
    const events = [...get().events, event].slice(-MAX);
    set({ events });

    // Surface a toast only for terminal states of interesting tools.
    if (event.status === "completed" || event.status === "failed") {
      if (["build", "install", "launch_app"].includes(event.tool) || event.status === "failed") {
        const toast = {
          id: event.id,
          at: Date.now(),
          tool: event.tool,
          status: event.status,
          ...(event.error && { error: event.error }),
        };
        set({ toasts: [...get().toasts, toast] });
        setTimeout(() => {
          set({ toasts: get().toasts.filter((t) => t.id !== toast.id) });
        }, TOAST_MS);
      }
    }
  },
  clear: () => set({ events: [], toasts: [] }),
}));
