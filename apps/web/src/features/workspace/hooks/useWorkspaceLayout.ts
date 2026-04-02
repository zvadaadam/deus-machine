/**
 * Workspace Layout Hook
 * Provides workspace-specific layout state with proper store synchronization.
 *
 * Reads directly from the store and provides stable callbacks that update it.
 *
 * Usage:
 * ```typescript
 * const {
 *   contentTab,
 *   selectedFilePath,
 *   setContentTab,
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
import type { ContentTab } from "../store/workspaceLayoutStore";

interface UseWorkspaceLayoutResult {
  /** Current content panel tab (changes, files, terminal, browser, config, etc.) */
  contentTab: ContentTab;
  /** Currently selected file path (for highlighting in tree) */
  selectedFilePath: string | null;
  /** Whether sidebar is collapsed */
  sidebarCollapsed: boolean;
  /** Whether chat panel is collapsed */
  chatPanelCollapsed: boolean;
  /** Whether content panel is collapsed */
  contentPanelCollapsed: boolean;
  /** Whether file tree is pinned open (vs minimap mode) */
  fileTreePinned: boolean;

  /** Set the active content tab */
  setContentTab: (tab: ContentTab) => void;
  /** Set selected file path */
  setSelectedFilePath: (path: string | null) => void;
  /** Set sidebar collapsed state */
  setSidebarCollapsed: (collapsed: boolean) => void;
  /** Set chat panel collapsed state */
  setChatPanelCollapsed: (collapsed: boolean) => void;
  /** Set content panel collapsed state */
  setContentPanelCollapsed: (collapsed: boolean) => void;
  /** Set file tree pinned state */
  setFileTreePinned: (pinned: boolean) => void;
  /** Update multiple layout properties at once */
  updateLayout: (updates: {
    contentTab?: ContentTab;
    selectedFilePath?: string | null;
    sidebarCollapsed?: boolean;
  }) => void;
}

export function useWorkspaceLayout(workspaceId: string | null): UseWorkspaceLayoutResult {
  const layout = useWorkspaceLayoutStore(
    useShallow((state) =>
      workspaceId ? (state.layouts[workspaceId] ?? defaultLayout) : defaultLayout
    )
  );
  const { setLayout } = workspaceLayoutActions;

  const setContentTab = useCallback(
    (tab: ContentTab) => {
      if (workspaceId) {
        setLayout(workspaceId, { activeContentTab: tab });
      }
    },
    [workspaceId, setLayout]
  );

  const setSelectedFilePath = useCallback(
    (path: string | null) => {
      if (workspaceId) {
        setLayout(workspaceId, { selectedFilePath: path });
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

  const setChatPanelCollapsed = useCallback(
    (collapsed: boolean) => {
      if (workspaceId) {
        setLayout(workspaceId, { chatPanelCollapsed: collapsed });
      }
    },
    [workspaceId, setLayout]
  );

  const setContentPanelCollapsed = useCallback(
    (collapsed: boolean) => {
      if (workspaceId) {
        setLayout(workspaceId, { contentPanelCollapsed: collapsed });
      }
    },
    [workspaceId, setLayout]
  );

  const setFileTreePinned = useCallback(
    (pinned: boolean) => {
      if (workspaceId) {
        setLayout(workspaceId, { fileTreePinned: pinned });
      }
    },
    [workspaceId, setLayout]
  );

  const updateLayout = useCallback(
    (updates: {
      contentTab?: ContentTab;
      selectedFilePath?: string | null;
      sidebarCollapsed?: boolean;
    }) => {
      if (!workspaceId) return;

      const layoutUpdates: Parameters<typeof setLayout>[1] = {};

      if (updates.contentTab !== undefined) {
        layoutUpdates.activeContentTab = updates.contentTab;
      }
      if (updates.selectedFilePath !== undefined) {
        layoutUpdates.selectedFilePath = updates.selectedFilePath;
      }
      if (updates.sidebarCollapsed !== undefined) {
        layoutUpdates.sidebarCollapsed = updates.sidebarCollapsed;
      }

      setLayout(workspaceId, layoutUpdates);
    },
    [workspaceId, setLayout]
  );

  return {
    contentTab: layout.activeContentTab ?? defaultLayout.activeContentTab,
    selectedFilePath: layout.selectedFilePath ?? null,
    sidebarCollapsed: layout.sidebarCollapsed,
    chatPanelCollapsed: layout.chatPanelCollapsed ?? false,
    contentPanelCollapsed: layout.contentPanelCollapsed ?? false,
    fileTreePinned: layout.fileTreePinned ?? defaultLayout.fileTreePinned,

    setContentTab,
    setSelectedFilePath,
    setSidebarCollapsed,
    setChatPanelCollapsed,
    setContentPanelCollapsed,
    setFileTreePinned,
    updateLayout,
  };
}
