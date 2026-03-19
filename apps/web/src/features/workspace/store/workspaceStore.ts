/**
 * Workspace Store
 * Global state management for workspace selection
 */

import { create } from "zustand";
import { devtools } from "zustand/middleware";

interface WorkspaceState {
  // Selected workspace ID (derive full object from React Query data via useMemo)
  selectedWorkspaceId: string | null;

  // Actions
  selectWorkspace: (workspaceId: string | null) => void;
}

export const useWorkspaceStore = create<WorkspaceState>()(
  devtools(
    (set) => ({
      selectedWorkspaceId: null,

      selectWorkspace: (workspaceId) => {
        set({ selectedWorkspaceId: workspaceId }, false, "workspace/select");
      },
    }),
    {
      name: "workspace-store",
      enabled: import.meta.env.DEV,
    }
  )
);
