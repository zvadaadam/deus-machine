import { create } from "zustand";
import { devtools } from "zustand/middleware";

export interface DetachedBrowserWorkspaceContext {
  workspaceId: string;
  directoryName: string | null;
  repoName: string | null;
  branch: string | null;
}

interface BrowserWindowState {
  detachedWindowOpen: boolean;
  detachedWorkspace: DetachedBrowserWorkspaceContext | null;
  setDetachedWindowOpen: (context: DetachedBrowserWorkspaceContext) => void;
  setDetachedWorkspace: (context: DetachedBrowserWorkspaceContext) => void;
  clearDetachedWindow: () => void;
}

export const useBrowserWindowStore = create<BrowserWindowState>()(
  devtools(
    (set) => ({
      detachedWindowOpen: false,
      detachedWorkspace: null,

      setDetachedWindowOpen: (context) =>
        set(
          {
            detachedWindowOpen: true,
            detachedWorkspace: context,
          },
          false,
          "browserWindow/setDetachedWindowOpen"
        ),

      setDetachedWorkspace: (context) =>
        set(
          (state) =>
            state.detachedWindowOpen
              ? { detachedWorkspace: context }
              : {
                  detachedWindowOpen: true,
                  detachedWorkspace: context,
                },
          false,
          "browserWindow/setDetachedWorkspace"
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
  setDetachedWorkspace: (context: DetachedBrowserWorkspaceContext) =>
    useBrowserWindowStore.getState().setDetachedWorkspace(context),
  clearDetachedWindow: () => useBrowserWindowStore.getState().clearDetachedWindow(),
};
