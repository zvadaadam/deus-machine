import { create } from "zustand";
import { devtools } from "zustand/middleware";

/** Queue-style payload for requesting a Browser tab open with a pre-set URL.
 *  Workspace-scoped so a stale request from a different workspace can't
 *  open a tab in the current one. Pattern mirrors chatInsertStore — producer
 *  dispatches, BrowserPanel consumes + clears. */
export interface PendingNewTabRequest {
  /** Unique per-request so consumers can react to successive identical URLs. */
  requestId: string;
  workspaceId: string;
  url: string;
}

interface BrowserWindowState {
  pendingNewTab: PendingNewTabRequest | null;
  requestNewTab: (workspaceId: string, url: string) => void;
  consumePendingNewTab: () => void;
}

export const useBrowserWindowStore = create<BrowserWindowState>()(
  devtools(
    (set) => ({
      pendingNewTab: null,

      requestNewTab: (workspaceId, url) =>
        set(
          {
            pendingNewTab: { requestId: crypto.randomUUID(), workspaceId, url },
          },
          false,
          "browserWindow/requestNewTab"
        ),

      consumePendingNewTab: () =>
        set({ pendingNewTab: null }, false, "browserWindow/consumePendingNewTab"),
    }),
    {
      name: "browser-window-store",
      enabled: import.meta.env.DEV,
    }
  )
);

export const browserWindowActions = {
  requestNewTab: (workspaceId: string, url: string) =>
    useBrowserWindowStore.getState().requestNewTab(workspaceId, url),
  consumePendingNewTab: () => useBrowserWindowStore.getState().consumePendingNewTab(),
};
