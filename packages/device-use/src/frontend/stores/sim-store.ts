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

/** True iff two stream infos describe the same underlying stream + metadata. */
function sameStream(a: StreamInfo | null, b: StreamInfo | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  if (a.udid !== b.udid || a.port !== b.port || a.url !== b.url) return false;
  // size is optional; compare structurally
  const as = a.size;
  const bs = b.size;
  if (!as && !bs) return true;
  if (!as || !bs) return false;
  return as.pxW === bs.pxW && as.pxH === bs.pxH && as.ptW === bs.ptW && as.ptH === bs.ptH;
}

/** True iff two sim arrays have the same entries in the same states. */
function sameSims(a: Simulator[], b: Simulator[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    if (!x || !y) return false;
    if (x.udid !== y.udid || x.state !== y.state || x.name !== y.name || x.runtime !== y.runtime) {
      return false;
    }
  }
  return true;
}

export const useSimStore = create<SimState>((set, get) => ({
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
      const prev = get();
      const newSims: Simulator[] = list.success ? (list.result?.devices ?? []) : [];
      const newUdid = state.simulator?.udid ?? null;
      // Preserve identity when nothing materially changed — any field we
      // overwrite with a new reference will re-fire downstream effects.
      set({
        sims: sameSims(prev.sims, newSims) ? prev.sims : newSims,
        pinnedUdid: prev.pinnedUdid === newUdid ? prev.pinnedUdid : newUdid,
        streamInfo: sameStream(prev.streamInfo, stream) ? prev.streamInfo : stream,
        loading: false,
        error: list.success ? null : (list.error ?? "failed to list devices"),
      });
    } catch (err) {
      set({ loading: false, error: (err as Error).message });
    }
  },
  setPinned: async (udid) => {
    const res = await api.setActiveSimulator(udid);
    if (!res.success) {
      set({ error: res.error ?? "failed to pin simulator" });
      return;
    }
    set({ pinnedUdid: udid, error: null });
  },
}));
