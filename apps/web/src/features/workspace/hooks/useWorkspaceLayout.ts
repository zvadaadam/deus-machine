import { useCallback } from "react";
import {
  useWorkspaceLayoutStore,
  workspaceLayoutActions,
  defaultLayout,
  type ContentTab,
  type WorkspacePanelMode,
} from "../store/workspaceLayoutStore";

export function useWorkspaceLayout(workspaceId: string | null) {
  const layout = useWorkspaceLayoutStore((state) =>
    workspaceId ? (state.layouts[workspaceId] ?? defaultLayout) : defaultLayout
  );

  const setContentTab = useCallback(
    (tab: ContentTab) => {
      if (workspaceId) workspaceLayoutActions.openContentTab(workspaceId, tab);
    },
    [workspaceId]
  );
  const setPanelMode = useCallback(
    (mode: WorkspacePanelMode) => {
      if (workspaceId) workspaceLayoutActions.setPanelMode(workspaceId, mode);
    },
    [workspaceId]
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
    contentTab: layout.activeContentTab,
    panelMode: layout.panelMode,
    selectedFilePath: layout.selectedFilePath,
    fileTreePinned: layout.fileTreePinned,
    setContentTab,
    setPanelMode,
    setSelectedFilePath,
    setFileTreePinned,
  };
}
