/**
 * Lightweight store that exposes the simulator phase per workspace.
 * SimulatorPanel writes to it; ContentTabBar reads from it to show
 * a status dot on the simulator tab.
 */

import { create } from "zustand";

export type SimPhaseLabel = "idle" | "booting" | "streaming" | "building" | "running" | "error";

interface SimulatorStatusStore {
  /** workspaceId → current phase */
  phases: Record<string, SimPhaseLabel>;
  setPhase: (workspaceId: string, phase: SimPhaseLabel) => void;
  clearPhase: (workspaceId: string) => void;
}

export const useSimulatorStatusStore = create<SimulatorStatusStore>()((set) => ({
  phases: {},
  setPhase: (workspaceId, phase) =>
    set((s) => ({ phases: { ...s.phases, [workspaceId]: phase } })),
  clearPhase: (workspaceId) =>
    set((s) => {
      const { [workspaceId]: _, ...rest } = s.phases;
      return { phases: rest };
    }),
}));
