/**
 * Hook to manage detaching/reattaching the browser into a separate OS window.
 *
 * Uses Tauri v2 WebviewWindow API to create a new native window that loads
 * the same React app with a query param (`?window=browser-detached`).
 * Detached window state is tracked globally (runtime only) because there is
 * only one physical detached browser window across all workspaces.
 */

import { useCallback } from "react";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { emit, isTauriEnv, BROWSER_WORKSPACE_CHANGE } from "@/platform/tauri";
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

let hasAttachedDestroyListener = false;
let destroyUnlisten: (() => void) | null = null;

function attachDestroyListener(window: WebviewWindow) {
  if (hasAttachedDestroyListener) return;
  hasAttachedDestroyListener = true;
  // Capture the unlisten function so the error handler can clean up the
  // orphaned IPC listener when window creation fails.
  window
    .once("tauri://destroyed", () => {
      hasAttachedDestroyListener = false;
      destroyUnlisten = null;
      browserWindowActions.clearDetachedWindow();
    })
    .then((fn) => {
      destroyUnlisten = fn;
    });
}

function cleanupDestroyListener() {
  if (destroyUnlisten) {
    destroyUnlisten();
    destroyUnlisten = null;
  }
  hasAttachedDestroyListener = false;
}

export function useBrowserDetach(context: DetachedBrowserWorkspaceContext | null) {
  const isDetached = useBrowserWindowStore((s) => s.detachedWindowOpen);

  const detach = useCallback(async () => {
    if (!context || !isTauriEnv) return;

    // Check if window already exists — focus it instead of creating a duplicate.
    const existing = await WebviewWindow.getByLabel("browser-detached");
    if (existing) {
      browserWindowActions.setDetachedWorkspace(context);
      attachDestroyListener(existing);
      await emit(BROWSER_WORKSPACE_CHANGE, context);
      await existing.setFocus();
      return;
    }

    // Mark as detached before creating the window so the main UI updates immediately.
    browserWindowActions.setDetachedWindowOpen(context);

    const detachedWindow = new WebviewWindow("browser-detached", {
      url: buildDetachUrl(context),
      title: buildWindowTitle(context),
      width: 960,
      height: 700,
      minWidth: 820,
      minHeight: 560,
      decorations: true,
      transparent: false,
    });

    detachedWindow.once("tauri://error", (e) => {
      console.error("[BrowserDetach] Failed to create detached window:", e);
      cleanupDestroyListener();
      browserWindowActions.clearDetachedWindow();
    });

    attachDestroyListener(detachedWindow);
  }, [context]);

  const reattach = useCallback(async () => {
    browserWindowActions.clearDetachedWindow();

    // Close the detached window if it exists
    try {
      const win = await WebviewWindow.getByLabel("browser-detached");
      if (win) await win.close();
    } catch {
      // Window may already be closed
    }
  }, []);

  return { isDetached, detach, reattach };
}
