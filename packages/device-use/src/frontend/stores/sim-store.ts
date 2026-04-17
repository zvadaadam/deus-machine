import { create } from "zustand";
import { api, type Simulator, type StreamInfo } from "../lib/api";

interface SimState {
  sims: Simulator[];
  pinnedUdid: string | null;
  streamInfo: StreamInfo | null;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  setPinned: (udid: string) => Promise<void>;
}

export const useSimStore = create<SimState>((set) => ({
  sims: [],
  pinnedUdid: null,
  streamInfo: null,
  loading: false,
  error: null,
  refresh: async () => {
    set({ loading: true, error: null });
    try {
      const [list, state, stream] = await Promise.all([
        api.listDevices(),
        api.getState(),
        api.getStream(),
      ]);
      set({
        sims: list.success ? (list.result?.devices ?? []) : [],
        pinnedUdid: state.simulator?.udid ?? null,
        streamInfo: stream,
        loading: false,
        error: list.success ? null : (list.error ?? "failed to list devices"),
      });
    } catch (err) {
      set({ loading: false, error: (err as Error).message });
    }
  },
  setPinned: async (udid) => {
    await api.setActiveSimulator(udid);
    set({ pinnedUdid: udid });
  },
}));
