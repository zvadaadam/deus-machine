import { useLayoutEffect, useSyncExternalStore } from "react";
import { appHistory } from "@/shared/lib/appHistory";
import { workspaceLayoutActions } from "../store/workspaceLayoutStore";

declare module "@tanstack/react-router" {
  interface HistoryState {
    workspaceFile?: { workspaceId: string; path: string };
  }
}

/** A phone file has its own history entry. Back and Forward close and open the same File tab. */
export function visitFile(workspaceId: string, path: string) {
  const history = appHistory();
  history.push(history.location.href, { workspaceFile: { workspaceId, path } });
}

const subscribe = (notify: () => void) => appHistory().subscribe(notify);
const current = () => appHistory().location.state.workspaceFile;
export function useFileVisit(workspaceId: string | null) {
  const visit = useSyncExternalStore(subscribe, current, () => undefined);
  const path = visit?.workspaceId === workspaceId ? visit?.path : undefined;
  useLayoutEffect(() => {
    if (!workspaceId || !path) return;
    const tab = workspaceLayoutActions.openFileInContent(workspaceId, path, "files");
    return () => {
      if (tab) workspaceLayoutActions.closeWorkspaceTab(workspaceId, tab);
    };
  }, [workspaceId, path]);
}
