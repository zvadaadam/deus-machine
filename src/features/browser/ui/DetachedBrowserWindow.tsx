/**
 * Standalone layout for the detached browser window.
 *
 * Loaded when App.tsx detects `?window=browser-detached` in the URL.
 * Renders BrowserPanel full-screen and syncs workspace changes from the
 * main window via Tauri events.
 */

import { useState, useEffect } from "react";
import { BrowserPanel } from "./BrowserPanel";
import { isTauriEnv, listen } from "@/platform/tauri";
import type { DetachedBrowserWorkspaceContext } from "@/features/browser/store";

interface WorkspaceChangePayload {
  workspaceId: string;
  directoryName?: string | null;
  repoName?: string | null;
  branch?: string | null;
}

function parseInitialContext(): DetachedBrowserWorkspaceContext | null {
  const params = new URLSearchParams(window.location.search);
  const workspaceId = params.get("workspaceId");
  if (!workspaceId) return null;
  return {
    workspaceId,
    directoryName: params.get("directoryName"),
    repoName: params.get("repoName"),
    branch: params.get("branch"),
  };
}

function buildWindowTitle(context: DetachedBrowserWorkspaceContext | null): string {
  if (!context) return "Browser";
  const repo = context.repoName ?? context.directoryName ?? "Workspace";
  const branch = context.branch ? ` / ${context.branch}` : "";
  return `Browser - ${repo}${branch}`;
}

export function DetachedBrowserWindow() {
  const [workspaceContext, setWorkspaceContext] = useState<DetachedBrowserWorkspaceContext | null>(
    parseInitialContext
  );

  const workspaceId = workspaceContext?.workspaceId ?? null;

  // Listen for workspace changes from the main window
  useEffect(() => {
    const unlistenPromise = listen<WorkspaceChangePayload>(
      "browser-window:workspace-change",
      (event) => {
        setWorkspaceContext((prev) => ({
          workspaceId: event.payload.workspaceId,
          directoryName: event.payload.directoryName ?? prev?.directoryName ?? null,
          repoName: event.payload.repoName ?? prev?.repoName ?? null,
          branch: event.payload.branch ?? prev?.branch ?? null,
        }));
      }
    );

    return () => {
      unlistenPromise.then((unlisten) => unlisten());
    };
  }, []);

  // Keep detached window title in sync with workspace context.
  useEffect(() => {
    if (!isTauriEnv) return;
    const nextTitle = buildWindowTitle(workspaceContext);
    let canceled = false;

    import("@tauri-apps/api/window").then(({ getCurrentWindow }) => {
      if (canceled) return;
      getCurrentWindow()
        .setTitle(nextTitle)
        .catch(() => {});
    });

    return () => {
      canceled = true;
    };
  }, [workspaceContext]);

  const primaryTitle = workspaceContext?.directoryName ?? "Workspace";
  const secondaryTitle = [workspaceContext?.repoName, workspaceContext?.branch]
    .filter(Boolean)
    .join(" / ");

  return (
    <div className="bg-background flex h-screen w-screen flex-col overflow-hidden">
      <div className="bg-bg-elevated border-border-subtle flex h-9 flex-shrink-0 items-center border-b px-3">
        <span
          className="text-foreground max-w-[240px] truncate text-xs font-medium"
          title={primaryTitle}
        >
          {primaryTitle}
        </span>
        {secondaryTitle && (
          <span
            className="text-text-subtle ml-2 truncate text-xs font-medium"
            title={secondaryTitle}
          >
            {secondaryTitle}
          </span>
        )}
      </div>

      <div className="min-h-0 flex-1">
        <BrowserPanel
          workspaceId={workspaceId}
          panelVisible={true}
          windowLabel="browser-detached"
        />
      </div>
    </div>
  );
}
