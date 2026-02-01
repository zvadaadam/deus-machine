/**
 * Workspace Store
 * Global state management for workspace selection and workspace-related data
 */

import { create } from "zustand";
import { devtools } from "zustand/middleware";
import type { Workspace, DiffStats } from "../types";

interface WorkspaceState {
  // Selected workspace
  selectedWorkspace: Workspace | null;

  // Diff stats cache (by workspace ID)
  diffStats: Record<string, DiffStats>;

  // Actions
  selectWorkspace: (workspace: Workspace | null) => void;
  clearSelection: () => void;
  setDiffStats: (workspaceId: string, stats: DiffStats) => void;
  setMultipleDiffStats: (stats: Record<string, DiffStats>) => void;
}

export const useWorkspaceStore = create<WorkspaceState>()(
  devtools(
    (set) => ({
      // Initial state
      selectedWorkspace: null,
      diffStats: {},

      // Actions
      selectWorkspace: (workspace) => {
        set({ selectedWorkspace: workspace }, false, "workspace/select");
      },

      clearSelection: () => {
        set({ selectedWorkspace: null }, false, "workspace/clearSelection");
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
  selectWorkspace: (workspace: Workspace | null) =>
    useWorkspaceStore.getState().selectWorkspace(workspace),
  clearSelection: () => useWorkspaceStore.getState().clearSelection(),
  setDiffStats: (workspaceId: string, stats: DiffStats) =>
    useWorkspaceStore.getState().setDiffStats(workspaceId, stats),
  setMultipleDiffStats: (stats: Record<string, DiffStats>) =>
    useWorkspaceStore.getState().setMultipleDiffStats(stats),
};
