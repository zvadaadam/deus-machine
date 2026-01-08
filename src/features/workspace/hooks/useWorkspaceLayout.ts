/**
 * Workspace Layout Hook
 * Provides workspace-specific layout state with proper store synchronization
 *
 * This hook eliminates the bidirectional sync anti-pattern by:
 * 1. Reading layout state directly from the store
 * 2. Providing stable callbacks that update the store
 * 3. Keeping transient diff data local (not persisted)
 *
 * Usage:
 * ```typescript
 * const {
 *   rightPanelTab,
 *   rightPanelExpanded,
 *   selectedFilePath,
 *   setRightPanelTab,
 *   setRightPanelExpanded,
 *   setSelectedFilePath,
 * } = useWorkspaceLayout(workspaceId);
 * ```
 */

import { useCallback } from "react";
import { useWorkspaceLayoutStore } from "../store/workspaceLayoutStore";
import type { RightPanelTab } from "../store/workspaceLayoutStore";

interface UseWorkspaceLayoutResult {
  /** Current right panel tab (changes, files, browser) */
  rightPanelTab: RightPanelTab;
  /** Whether right panel is expanded (showing diff viewer) */
  rightPanelExpanded: boolean;
  /** Currently selected file path (for highlighting in tree) */
  selectedFilePath: string | null;
  /** Whether sidebar is collapsed */
  sidebarCollapsed: boolean;

  /** Set the active right panel tab */
  setRightPanelTab: (tab: RightPanelTab) => void;
  /** Set right panel expanded state */
  setRightPanelExpanded: (expanded: boolean) => void;
  /** Set selected file path */
  setSelectedFilePath: (path: string | null, source?: "changes" | "files") => void;
  /** Set sidebar collapsed state */
  setSidebarCollapsed: (collapsed: boolean) => void;
  /** Update multiple layout properties at once */
  updateLayout: (updates: {
    rightPanelTab?: RightPanelTab;
    rightPanelExpanded?: boolean;
    selectedFilePath?: string | null;
    sidebarCollapsed?: boolean;
  }) => void;
}

const defaultLayout = {
  rightPanelExpanded: false,
  activeRightTab: "changes" as RightPanelTab,
  selectedFile: null,
  sidebarCollapsed: false,
};

export function useWorkspaceLayout(workspaceId: string | null): UseWorkspaceLayoutResult {
  // Subscribe directly to store state - this triggers re-renders when layout changes
  // Note: Using a selector that accesses state.layouts[workspaceId] ensures proper reactivity
  const layout = useWorkspaceLayoutStore((state) =>
    workspaceId ? (state.layouts[workspaceId] ?? defaultLayout) : defaultLayout
  );
  const setLayout = useWorkspaceLayoutStore((state) => state.setLayout);

  // Stable callbacks for updating state
  const setRightPanelTab = useCallback(
    (tab: RightPanelTab) => {
      if (workspaceId) {
        setLayout(workspaceId, { activeRightTab: tab });
      }
    },
    [workspaceId, setLayout]
  );

  const setRightPanelExpanded = useCallback(
    (expanded: boolean) => {
      if (workspaceId) {
        setLayout(workspaceId, { rightPanelExpanded: expanded });
      }
    },
    [workspaceId, setLayout]
  );

  const setSelectedFilePath = useCallback(
    (path: string | null, source: "changes" | "files" = "changes") => {
      if (workspaceId) {
        setLayout(workspaceId, {
          selectedFile: path ? { path, source } : null,
        });
      }
    },
    [workspaceId, setLayout]
  );

  const setSidebarCollapsed = useCallback(
    (collapsed: boolean) => {
      if (workspaceId) {
        setLayout(workspaceId, { sidebarCollapsed: collapsed });
      }
    },
    [workspaceId, setLayout]
  );

  const updateLayout = useCallback(
    (updates: {
      rightPanelTab?: RightPanelTab;
      rightPanelExpanded?: boolean;
      selectedFilePath?: string | null;
      sidebarCollapsed?: boolean;
    }) => {
      if (!workspaceId) return;

      const layoutUpdates: Parameters<typeof setLayout>[1] = {};

      if (updates.rightPanelTab !== undefined) {
        layoutUpdates.activeRightTab = updates.rightPanelTab;
      }
      if (updates.rightPanelExpanded !== undefined) {
        layoutUpdates.rightPanelExpanded = updates.rightPanelExpanded;
      }
      if (updates.selectedFilePath !== undefined) {
        layoutUpdates.selectedFile = updates.selectedFilePath
          ? { path: updates.selectedFilePath, source: "changes" }
          : null;
      }
      if (updates.sidebarCollapsed !== undefined) {
        layoutUpdates.sidebarCollapsed = updates.sidebarCollapsed;
      }

      setLayout(workspaceId, layoutUpdates);
    },
    [workspaceId, setLayout]
  );

  return {
    // State (derived from store)
    rightPanelTab: layout.activeRightTab,
    rightPanelExpanded: layout.rightPanelExpanded,
    selectedFilePath: layout.selectedFile?.path ?? null,
    sidebarCollapsed: layout.sidebarCollapsed,

    // Stable callbacks
    setRightPanelTab,
    setRightPanelExpanded,
    setSelectedFilePath,
    setSidebarCollapsed,
    updateLayout,
  };
}
