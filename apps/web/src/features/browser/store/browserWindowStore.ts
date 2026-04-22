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
  pendingNewTab: PendingNewTabRequest | null;
  pendingCloseTab: PendingCloseTabRequest | null;
  /** Focus mode per workspace — boolean toggle for the Codex-style overlay.
   *  Not persisted (transient UI state); on app reload it resets to off. */
  focusModeByWorkspace: Record<string, boolean>;

  requestNewTab: (workspaceId: string, url: string) => void;
  consumePendingNewTab: () => void;
  requestCloseTabByUrlPrefix: (workspaceId: string, urlPrefix: string) => void;
  consumePendingCloseTab: () => void;
  setFocusMode: (workspaceId: string, enabled: boolean) => void;
}

export const useBrowserWindowStore = create<BrowserWindowState>()(
  devtools(
    (set) => ({
      pendingNewTab: null,
      pendingCloseTab: null,
      focusModeByWorkspace: {},

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

      setFocusMode: (workspaceId, enabled) =>
        set(
          (s) => ({
            focusModeByWorkspace: { ...s.focusModeByWorkspace, [workspaceId]: enabled },
          }),
          false,
          "browserWindow/setFocusMode"
        ),
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
  requestCloseTabByUrlPrefix: (workspaceId: string, urlPrefix: string) =>
    useBrowserWindowStore.getState().requestCloseTabByUrlPrefix(workspaceId, urlPrefix),
  consumePendingCloseTab: () => useBrowserWindowStore.getState().consumePendingCloseTab(),
  setFocusMode: (workspaceId: string, enabled: boolean) =>
    useBrowserWindowStore.getState().setFocusMode(workspaceId, enabled),
  toggleFocusMode: (workspaceId: string) => {
    const current = useBrowserWindowStore.getState().focusModeByWorkspace[workspaceId] ?? false;
    useBrowserWindowStore.getState().setFocusMode(workspaceId, !current);
  },
  isFocusMode: (workspaceId: string) =>
    useBrowserWindowStore.getState().focusModeByWorkspace[workspaceId] ?? false,
};
