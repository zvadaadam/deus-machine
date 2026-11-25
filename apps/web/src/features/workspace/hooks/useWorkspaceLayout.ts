import { useCallback, useMemo } from "react";
import {
  useWorkspaceLayoutStore,
  workspaceLayoutActions,
  defaultLayout,
  resolveWorkspaceTabs,
  type WorkspacePanelMode,
} from "../store/workspaceLayoutStore";
import type { WorkspaceTab } from "@/features/workspace-tabs/types";

const EMPTY_TABS: WorkspaceTab[] = [];

/** Narrow subscription for just the panel mode (avoids re-rendering MainContent on tab/title churn). */
export function useWorkspacePanelMode(workspaceId: string | null) {
  const panelMode = useWorkspaceLayoutStore((state) =>
    workspaceId
      ? (state.layouts[workspaceId]?.panelMode ?? defaultLayout.panelMode)
      : defaultLayout.panelMode
  );
  const setPanelMode = useCallback(
    (mode: WorkspacePanelMode) => {
      if (workspaceId) workspaceLayoutActions.setPanelMode(workspaceId, mode);
    },
    [workspaceId]
  );
  return { panelMode, setPanelMode };
}

/** Narrow subscription for the workspace tab strip & active tab only. */
export function useWorkspaceTabsState(workspaceId: string | null) {
  const rawTabs = useWorkspaceLayoutStore((state) =>
    workspaceId ? (state.layouts[workspaceId]?.workspaceTabs ?? EMPTY_TABS) : EMPTY_TABS
  );
  const rawActiveTabId = useWorkspaceLayoutStore((state) =>
    workspaceId ? (state.layouts[workspaceId]?.activeWorkspaceTabId ?? null) : null
  );
  const migratedActiveTool = useWorkspaceLayoutStore((state) =>
    workspaceId ? (state.layouts[workspaceId]?.migratedActiveTool ?? null) : null
  );

  const { tabs, activeTabId, activeTab } = useMemo(
    () => resolveWorkspaceTabs({ workspaceTabs: rawTabs, activeWorkspaceTabId: rawActiveTabId }),
    [rawTabs, rawActiveTabId]
  );

  const selectTab = useCallback(
    (tabId: string) => {
      if (workspaceId) workspaceLayoutActions.selectWorkspaceTab(workspaceId, tabId);
    },
    [workspaceId]
  );
  const addNewTab = useCallback(() => {
    if (workspaceId) workspaceLayoutActions.addNewTab(workspaceId);
  }, [workspaceId]);
  const closeTab = useCallback(
    (tabId: string) => {
      if (workspaceId) workspaceLayoutActions.closeWorkspaceTab(workspaceId, tabId);
    },
    [workspaceId]
  );
  const reorderTabs = useCallback(
    (draggedId: string, targetId: string) => {
      if (workspaceId)
        workspaceLayoutActions.reorderWorkspaceTabs(workspaceId, draggedId, targetId);
    },
    [workspaceId]
  );

  return {
    workspaceTabs: tabs,
    activeTabId,
    activeTab,
    migratedActiveTool,
    selectTab,
    addNewTab,
    closeTab,
    reorderTabs,
  };
}

/** Narrow subscription for file selection and diff tree pinning (ChangesView / FilesView). */
export function useWorkspaceLayout(workspaceId: string | null) {
  const selectedFilePath = useWorkspaceLayoutStore((state) =>
    workspaceId
      ? (state.layouts[workspaceId]?.selectedFilePath ?? defaultLayout.selectedFilePath)
      : defaultLayout.selectedFilePath
  );
  const fileTreePinned = useWorkspaceLayoutStore((state) =>
    workspaceId
      ? (state.layouts[workspaceId]?.fileTreePinned ?? defaultLayout.fileTreePinned)
      : defaultLayout.fileTreePinned
  );

  const setSelectedFilePath = useCallback(
    (path: string | null) => {
      if (workspaceId) workspaceLayoutActions.setSelectedFilePath(workspaceId, path);
    },
    [workspaceId]
  );
  const setFileTreePinned = useCallback(
    (pinned: boolean) => {
      if (workspaceId) workspaceLayoutActions.setLayout(workspaceId, { fileTreePinned: pinned });
    },
    [workspaceId]
  );

  return {
    selectedFilePath,
    fileTreePinned,
    setSelectedFilePath,
    setFileTreePinned,
  };
}
