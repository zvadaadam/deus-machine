import { useSyncExternalStore } from "react";
import { appHistory } from "@/shared/lib/appHistory";

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
