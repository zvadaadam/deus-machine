/**
 * Workspace Store
 * Global state management for workspace selection and workspace-related data
 */

import { create } from "zustand";
import { devtools } from "zustand/middleware";
import type { DiffStats } from "../types";

interface WorkspaceState {
  // Selected workspace ID (derive full object from React Query data via useMemo)
  selectedWorkspaceId: string | null;

  // Diff stats cache (by workspace ID)
  diffStats: Record<string, DiffStats>;

  // Actions
  selectWorkspace: (workspaceId: string | null) => void;
  clearSelection: () => void;
  setDiffStats: (workspaceId: string, stats: DiffStats) => void;
  setMultipleDiffStats: (stats: Record<string, DiffStats>) => void;
}

export const useWorkspaceStore = create<WorkspaceState>()(
  devtools(
    (set) => ({
      // Initial state
      selectedWorkspaceId: null,
      diffStats: {},

      // Actions
      selectWorkspace: (workspaceId) => {
        set({ selectedWorkspaceId: workspaceId }, false, "workspace/select");
      },

      clearSelection: () => {
        set({ selectedWorkspaceId: null }, false, "workspace/clearSelection");
      },

      setDiffStats: (workspaceId, stats) =>
        set(
          (state) => ({
            diffStats: {
              ...state.diffStats,
              [workspaceId]: stats,
            },
          }),
          false,
          "workspace/setDiffStats"
        ),

      setMultipleDiffStats: (stats) =>
        set(
          (state) => ({
            diffStats: {
              ...state.diffStats,
              ...stats,
            },
          }),
          false,
          "workspace/setMultipleDiffStats"
        ),
    }),
    {
      name: "workspace-store",
      enabled: import.meta.env.DEV,
    }
  )
);

/**
 * Stable Actions - Call from anywhere without causing re-renders
 */
export const workspaceActions = {
  selectWorkspace: (workspaceId: string | null) =>
    useWorkspaceStore.getState().selectWorkspace(workspaceId),
  clearSelection: () => useWorkspaceStore.getState().clearSelection(),
  setDiffStats: (workspaceId: string, stats: DiffStats) =>
    useWorkspaceStore.getState().setDiffStats(workspaceId, stats),
  setMultipleDiffStats: (stats: Record<string, DiffStats>) =>
    useWorkspaceStore.getState().setMultipleDiffStats(stats),
};
