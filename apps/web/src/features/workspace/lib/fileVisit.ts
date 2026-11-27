import { useLayoutEffect, useSyncExternalStore } from "react";
import { appHistory } from "@/shared/lib/appHistory";
import { workspaceLayoutActions } from "../store/workspaceLayoutStore";

declare module "@tanstack/react-router" {
  interface HistoryState {
    workspaceFile?: { workspaceId: string; path: string };
  }
}

/** A full-screen file gets its own entry. Back returns to the chat or board at the same address. */
export function visitFile(workspaceId: string, path: string) {
  const history = appHistory();
  // A workspace selected by the same click must get its own Back destination first.
  history.flush();
  history.push(history.location.href, { workspaceFile: { workspaceId, path } });
}

const subscribe = (notify: () => void) => appHistory().subscribe(notify);
const current = () => appHistory().location.state.workspaceFile;
export function useCurrentFileVisit() {
  return useSyncExternalStore(subscribe, current, () => undefined);
}

export function useFileVisit(workspaceId: string | null) {
  const visit = useCurrentFileVisit();
  const path = visit?.workspaceId === workspaceId ? visit?.path : undefined;
  useLayoutEffect(() => {
    if (!workspaceId || !path) return;
    const previous = workspaceLayoutActions.getLayout(workspaceId);
    const tab = workspaceLayoutActions.openFileInContent(workspaceId, path, "files");
    return () => {
      if (!tab) return;
      const active = workspaceLayoutActions.getLayout(workspaceId).activeWorkspaceTabId === tab;
      const previousTab = previous.activeWorkspaceTabId ?? undefined;
      if (!previous.workspaceTabs.some((t) => t.id === tab)) {
        workspaceLayoutActions.closeWorkspaceTab(workspaceId, tab, {
          nextActiveTabId: previousTab,
        });
      } else if (active && previousTab) {
        workspaceLayoutActions.selectWorkspaceTab(workspaceId, previousTab);
      }
      if (active)
        workspaceLayoutActions.setLayout(workspaceId, {
          selectedFilePath: previous.selectedFilePath,
          panelMode: previous.panelMode,
          pendingFileNavigation: null,
        });
    };
  }, [workspaceId, path]);
}
