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
 *   rightSideTab,
 *   rightPanelTab,
 *   rightPanelExpanded,
 *   selectedFilePath,
 *   setRightSideTab,
 *   setRightPanelTab,
 *   setRightPanelExpanded,
 *   setSelectedFilePath,
 * } = useWorkspaceLayout(workspaceId);
 * ```
 */

import { useCallback } from "react";
import { useShallow } from "zustand/react/shallow";
import {
  useWorkspaceLayoutStore,
  workspaceLayoutActions,
  defaultLayout,
} from "../store/workspaceLayoutStore";
import type { RightPanelTab, RightSideTab } from "../store/workspaceLayoutStore";

interface UseWorkspaceLayoutResult {
  /** Current code panel tab (changes, files) */
  rightPanelTab: RightPanelTab;
  /** Current right side panel tab (code, config, terminal, design, browser) */
  rightSideTab: RightSideTab;
  /** Whether right panel is expanded (showing diff viewer) */
  rightPanelExpanded: boolean;
  /** Currently selected file path (for highlighting in tree) */
  selectedFilePath: string | null;
  /** Whether sidebar is collapsed */
  sidebarCollapsed: boolean;
  /** User-set right panel width in pixels, or null for auto */
  rightPanelWidth: number | null;

  /** Set the active right panel tab */
  setRightPanelTab: (tab: RightPanelTab) => void;
  /** Set the active right side panel tab */
  setRightSideTab: (tab: RightSideTab) => void;
  /** Set right panel expanded state */
  setRightPanelExpanded: (expanded: boolean) => void;
  /** Set selected file path */
  setSelectedFilePath: (path: string | null, source?: "changes" | "files") => void;
  /** Set sidebar collapsed state */
  setSidebarCollapsed: (collapsed: boolean) => void;
  /** Set right panel width (null = auto) */
  setRightPanelWidth: (width: number | null) => void;
  /** Update multiple layout properties at once */
  updateLayout: (updates: {
    rightPanelTab?: RightPanelTab;
    rightSideTab?: RightSideTab;
    rightPanelExpanded?: boolean;
    selectedFilePath?: string | null;
    sidebarCollapsed?: boolean;
  }) => void;
}

export function useWorkspaceLayout(workspaceId: string | null): UseWorkspaceLayoutResult {
  // Subscribe directly to store state - this triggers re-renders when layout changes.
  // useShallow prevents re-renders when setLayout creates a new object via spread
  // but no field values actually changed (e.g., setRightPanelExpanded(true) when already true).
  const layout = useWorkspaceLayoutStore(
    useShallow((state) =>
      workspaceId ? (state.layouts[workspaceId] ?? defaultLayout) : defaultLayout
    )
  );
  // Use stable module-level actions instead of subscribing to store actions via selectors.
  // This prevents unstable references from cascading through useCallback/useEffect chains.
  const { setLayout } = workspaceLayoutActions;

  // Stable callbacks - only depend on workspaceId (setLayout is module-level stable)
  const setRightPanelTab = useCallback(
    (tab: RightPanelTab) => {
      if (workspaceId) {
        setLayout(workspaceId, { activeRightTab: tab });
      }
    },
    [workspaceId, setLayout]
  );

  const setRightSideTab = useCallback(
    (tab: RightSideTab) => {
      if (workspaceId) {
        setLayout(workspaceId, { activeRightSideTab: tab });
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

  const setRightPanelWidth = useCallback(
    (width: number | null) => {
      if (workspaceId) {
        const sideTab = layout.activeRightSideTab ?? defaultLayout.activeRightSideTab;
        if (sideTab === "browser") {
          setLayout(workspaceId, { rightPanelWidthBrowser: width });
        } else {
          setLayout(workspaceId, { rightPanelWidth: width });
        }
      }
    },
    [workspaceId, setLayout, layout.activeRightSideTab]
  );

  const updateLayout = useCallback(
    (updates: {
      rightPanelTab?: RightPanelTab;
      rightSideTab?: RightSideTab;
      rightPanelExpanded?: boolean;
      selectedFilePath?: string | null;
      sidebarCollapsed?: boolean;
    }) => {
      if (!workspaceId) return;

      const layoutUpdates: Parameters<typeof setLayout>[1] = {};

      if (updates.rightPanelTab !== undefined) {
        layoutUpdates.activeRightTab = updates.rightPanelTab;
      }
      if (updates.rightSideTab !== undefined) {
        layoutUpdates.activeRightSideTab = updates.rightSideTab;
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

  const normalizedRightPanelTab =
    layout.activeRightTab === "files" ? "files" : ("changes" as RightPanelTab);

  return {
    // State (derived from store)
    rightPanelTab: normalizedRightPanelTab,
    rightSideTab: layout.activeRightSideTab ?? defaultLayout.activeRightSideTab,
    rightPanelExpanded: layout.rightPanelExpanded,
    selectedFilePath: layout.selectedFile?.path ?? null,
    sidebarCollapsed: layout.sidebarCollapsed,
    rightPanelWidth:
      layout.activeRightSideTab === "browser"
        ? (layout.rightPanelWidthBrowser ?? null)
        : (layout.rightPanelWidth ?? null),

    // Stable callbacks
    setRightPanelTab,
    setRightSideTab,
    setRightPanelExpanded,
    setSelectedFilePath,
    setSidebarCollapsed,
    setRightPanelWidth,
    updateLayout,
  };
}
