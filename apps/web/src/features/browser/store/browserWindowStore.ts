import { create } from "zustand";
import { devtools } from "zustand/middleware";

export interface DetachedBrowserWorkspaceContext {
  workspaceId: string;
  directoryName: string | null;
  repoName: string | null;
  branch: string | null;
}

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

/** Queue-style payload for requesting any Browser tabs whose currentUrl
 *  starts with `urlPrefix` be closed. Used by the AAP stop flow: when an
 *  app exits, its port is dead and any open tabs pointing at it are now
 *  broken — we close them so the user doesn't have to refresh into an
 *  error. Workspace-scoped for the same reason as `PendingNewTabRequest`. */
export interface PendingCloseTabRequest {
  requestId: string;
  workspaceId: string;
  urlPrefix: string;
}

interface BrowserWindowState {
  detachedWindowOpen: boolean;
  detachedWorkspace: DetachedBrowserWorkspaceContext | null;
  pendingNewTab: PendingNewTabRequest | null;
  pendingCloseTab: PendingCloseTabRequest | null;
  setDetachedWindowOpen: (context: DetachedBrowserWorkspaceContext) => void;
  clearDetachedWindow: () => void;
  requestNewTab: (workspaceId: string, url: string) => void;
  consumePendingNewTab: () => void;
  requestCloseTabByUrlPrefix: (workspaceId: string, urlPrefix: string) => void;
  consumePendingCloseTab: () => void;
}

export const useBrowserWindowStore = create<BrowserWindowState>()(
  devtools(
    (set) => ({
      detachedWindowOpen: false,
      detachedWorkspace: null,
      pendingNewTab: null,
      pendingCloseTab: null,

      setDetachedWindowOpen: (context) =>
        set(
          {
            detachedWindowOpen: true,
            detachedWorkspace: context,
          },
          false,
          "browserWindow/setDetachedWindowOpen"
        ),

      clearDetachedWindow: () =>
        set(
          {
            detachedWindowOpen: false,
            detachedWorkspace: null,
          },
          false,
          "browserWindow/clearDetachedWindow"
        ),

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

      requestCloseTabByUrlPrefix: (workspaceId, urlPrefix) =>
        set(
          {
            pendingCloseTab: { requestId: crypto.randomUUID(), workspaceId, urlPrefix },
          },
          false,
          "browserWindow/requestCloseTabByUrlPrefix"
        ),

      consumePendingCloseTab: () =>
        set({ pendingCloseTab: null }, false, "browserWindow/consumePendingCloseTab"),
    }),
    {
      name: "browser-window-store",
      enabled: import.meta.env.DEV,
    }
  )
);

export const browserWindowActions = {
  setDetachedWindowOpen: (context: DetachedBrowserWorkspaceContext) =>
    useBrowserWindowStore.getState().setDetachedWindowOpen(context),
  clearDetachedWindow: () => useBrowserWindowStore.getState().clearDetachedWindow(),
  requestNewTab: (workspaceId: string, url: string) =>
    useBrowserWindowStore.getState().requestNewTab(workspaceId, url),
  consumePendingNewTab: () => useBrowserWindowStore.getState().consumePendingNewTab(),
  requestCloseTabByUrlPrefix: (workspaceId: string, urlPrefix: string) =>
    useBrowserWindowStore.getState().requestCloseTabByUrlPrefix(workspaceId, urlPrefix),
  consumePendingCloseTab: () => useBrowserWindowStore.getState().consumePendingCloseTab(),
};
