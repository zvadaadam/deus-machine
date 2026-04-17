import { create } from "zustand";

export interface ToolLog {
  type: "tool-log";
  id: string;
  stream: "stdout" | "stderr";
  text: string;
}

interface LogsState {
  lines: ToolLog[];
  append: (log: ToolLog) => void;
  clear: () => void;
}

const MAX_LINES = 500;

export const useLogsStore = create<LogsState>((set, get) => ({
  lines: [],
  append: (log) => set({ lines: [...get().lines, log].slice(-MAX_LINES) }),
  clear: () => set({ lines: [] }),
}));
