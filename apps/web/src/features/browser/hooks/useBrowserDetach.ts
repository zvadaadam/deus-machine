/**
 * Hook to manage detaching/reattaching the browser into a separate OS window.
 *
 * In Electron, uses window.electronAPI.invoke to create a new BrowserWindow
 * that loads the same React app with a query param (?window=browser-detached).
 * Detached window state is tracked globally (runtime only) because there is
 * only one physical detached browser window across all workspaces.
 */

import { useCallback, useEffect } from "react";
import { native } from "@/platform";
import { BROWSER_WORKSPACE_CHANGE } from "@shared/events";
import {
  browserWindowActions,
  useBrowserWindowStore,
  type DetachedBrowserWorkspaceContext,
} from "@/features/browser/store";

function buildDetachUrl(context: DetachedBrowserWorkspaceContext): string {
  const params = new URLSearchParams({
    window: "browser-detached",
    workspaceId: context.workspaceId,
  });
  if (context.directoryName) params.set("directoryName", context.directoryName);
  if (context.repoName) params.set("repoName", context.repoName);
  if (context.branch) params.set("branch", context.branch);
  return `/?${params.toString()}`;
}

function buildWindowTitle(context: DetachedBrowserWorkspaceContext): string {
  const repo = context.repoName ?? context.directoryName ?? "Workspace";
  const branch = context.branch ? ` / ${context.branch}` : "";
  return `Browser - ${repo}${branch}`;
}

export function useBrowserDetach(context: DetachedBrowserWorkspaceContext | null) {
  const isDetached = useBrowserWindowStore((s) => s.detachedWindowOpen);

  const detach = useCallback(async () => {
    if (!context) return;

    // Mark as detached before creating the window so the main UI updates immediately.
    browserWindowActions.setDetachedWindowOpen(context);

    try {
      await native.browserViews.createDetachedWindow({
        url: buildDetachUrl(context),
        title: buildWindowTitle(context),
        width: 960,
        height: 700,
        minWidth: 820,
        minHeight: 560,
      });

      await native.events.send(BROWSER_WORKSPACE_CHANGE, context);
    } catch (e) {
      console.error("[BrowserDetach] Failed to create detached window:", e);
      browserWindowActions.clearDetachedWindow();
    }
  }, [context]);

  const reattach = useCallback(async () => {
    browserWindowActions.clearDetachedWindow();

    // Close the detached window if it exists
    try {
      await native.browserViews.closeDetachedWindow();
    } catch {
      // Window may already be closed
    }
  }, []);

  // When the user closes the detached OS window directly (via title bar X),
  // the main process sends "browser:detached-closed" — reset our store so
  // the main window UI reflects the reattached state.
  useEffect(() => {
    // native.events.on handles the capability check internally — no-op in web mode
    const unlisten = native.events.on("browser:detached-closed" as any, () => {
      browserWindowActions.clearDetachedWindow();
    });

    return unlisten;
  }, []);

  return { isDetached, detach, reattach };
}
