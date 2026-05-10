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
  /** Optional caller-owned tab id, used when a remote browser stream needs
   *  the native Electron tab to register under the hosted tab's id. */
  tabId?: string;
  /** True when the tab is a desktop backing surface for a hosted-web canvas. */
  streamToRemote?: boolean;
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

/** Queue-style payload for requesting a specific Browser tab be closed.
 *  Used by hosted relay browser sessions to clean up the Electron <webview>
 *  that was created on the desktop side for pixel streaming. */
export interface PendingCloseTabByIdRequest {
  requestId: string;
  tabId: string;
  workspaceId?: string;
}

interface BrowserWindowState {
  pendingNewTab: PendingNewTabRequest | null;
  pendingNewTabQueue: PendingNewTabRequest[];
  pendingCloseTab: PendingCloseTabRequest | null;
  pendingCloseTabQueue: PendingCloseTabRequest[];
  pendingCloseTabById: PendingCloseTabByIdRequest | null;
  pendingCloseTabByIdQueue: PendingCloseTabByIdRequest[];
  /** Focus mode per workspace — boolean toggle for the Codex-style overlay.
   *  Not persisted (transient UI state); on app reload it resets to off. */
  focusModeByWorkspace: Record<string, boolean>;

  requestNewTab: (
    workspaceId: string,
    url: string,
    tabId?: string,
    streamToRemote?: boolean
  ) => void;
  consumePendingNewTab: () => void;
  requestCloseTabByUrlPrefix: (workspaceId: string, urlPrefix: string) => void;
  consumePendingCloseTab: () => void;
  requestCloseTabById: (tabId: string, workspaceId?: string) => void;
  consumePendingCloseTabById: () => void;
  setFocusMode: (workspaceId: string, enabled: boolean) => void;
}

export const useBrowserWindowStore = create<BrowserWindowState>()(
  devtools(
    (set) => ({
      pendingNewTab: null,
      pendingNewTabQueue: [],
      pendingCloseTab: null,
      pendingCloseTabQueue: [],
      pendingCloseTabById: null,
      pendingCloseTabByIdQueue: [],
      focusModeByWorkspace: {},

      requestNewTab: (workspaceId, url, tabId, streamToRemote) =>
        set(
          (state) => {
            const request: PendingNewTabRequest = {
              requestId: crypto.randomUUID(),
              workspaceId,
              url,
              tabId,
              ...(streamToRemote === true ? { streamToRemote: true } : {}),
            };
            const queue = [...state.pendingNewTabQueue, request];
            return {
              pendingNewTabQueue: queue,
              pendingNewTab: state.pendingNewTab ?? request,
            };
          },
          false,
          "browserWindow/requestNewTab"
        ),

      consumePendingNewTab: () =>
        set(
          (state) => {
            const [, ...queue] = state.pendingNewTabQueue;
            return {
              pendingNewTabQueue: queue,
              pendingNewTab: queue[0] ?? null,
            };
          },
          false,
          "browserWindow/consumePendingNewTab"
        ),

      requestCloseTabByUrlPrefix: (workspaceId, urlPrefix) =>
        set(
          (state) => {
            const request: PendingCloseTabRequest = {
              requestId: crypto.randomUUID(),
              workspaceId,
              urlPrefix,
            };
            const queue = [...state.pendingCloseTabQueue, request];
            return {
              pendingCloseTabQueue: queue,
              pendingCloseTab: state.pendingCloseTab ?? request,
            };
          },
          false,
          "browserWindow/requestCloseTabByUrlPrefix"
        ),

      consumePendingCloseTab: () =>
        set(
          (state) => {
            const [, ...queue] = state.pendingCloseTabQueue;
            return {
              pendingCloseTabQueue: queue,
              pendingCloseTab: queue[0] ?? null,
            };
          },
          false,
          "browserWindow/consumePendingCloseTab"
        ),

      requestCloseTabById: (tabId, workspaceId) =>
        set(
          (state) => {
            const request: PendingCloseTabByIdRequest = {
              requestId: crypto.randomUUID(),
              tabId,
              workspaceId,
            };
            const queue = [...state.pendingCloseTabByIdQueue, request];
            return {
              pendingCloseTabByIdQueue: queue,
              pendingCloseTabById: state.pendingCloseTabById ?? request,
            };
          },
          false,
          "browserWindow/requestCloseTabById"
        ),

      consumePendingCloseTabById: () =>
        set(
          (state) => {
            const [, ...queue] = state.pendingCloseTabByIdQueue;
            return {
              pendingCloseTabByIdQueue: queue,
              pendingCloseTabById: queue[0] ?? null,
            };
          },
          false,
          "browserWindow/consumePendingCloseTabById"
        ),

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
  requestNewTab: (workspaceId: string, url: string, tabId?: string, streamToRemote?: boolean) =>
    useBrowserWindowStore.getState().requestNewTab(workspaceId, url, tabId, streamToRemote),
  consumePendingNewTab: () => useBrowserWindowStore.getState().consumePendingNewTab(),
  requestCloseTabByUrlPrefix: (workspaceId: string, urlPrefix: string) =>
    useBrowserWindowStore.getState().requestCloseTabByUrlPrefix(workspaceId, urlPrefix),
  consumePendingCloseTab: () => useBrowserWindowStore.getState().consumePendingCloseTab(),
  requestCloseTabById: (tabId: string, workspaceId?: string) =>
    useBrowserWindowStore.getState().requestCloseTabById(tabId, workspaceId),
  consumePendingCloseTabById: () => useBrowserWindowStore.getState().consumePendingCloseTabById(),
  setFocusMode: (workspaceId: string, enabled: boolean) =>
    useBrowserWindowStore.getState().setFocusMode(workspaceId, enabled),
  toggleFocusMode: (workspaceId: string) => {
    const current = useBrowserWindowStore.getState().focusModeByWorkspace[workspaceId] ?? false;
    useBrowserWindowStore.getState().setFocusMode(workspaceId, !current);
  },
  isFocusMode: (workspaceId: string) =>
    useBrowserWindowStore.getState().focusModeByWorkspace[workspaceId] ?? false,
};
