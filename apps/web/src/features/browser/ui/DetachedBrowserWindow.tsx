/**
 * Standalone layout for the detached browser window.
 *
 * Loaded when App.tsx detects `?window=browser-detached` in the URL.
 * Renders BrowserPanel full-screen and syncs workspace changes from the
 * main window via IPC events.
 *
 * Insert-to-chat payloads are bridged back to the main window over an IPC
 * event because detached windows run in a separate JS runtime.
 */

import { useState, useEffect } from "react";
import { BrowserPanel } from "./BrowserPanel";
import { native } from "@/platform";
import { BROWSER_WORKSPACE_CHANGE, CHAT_INSERT } from "@shared/events";
import type { DetachedBrowserWorkspaceContext } from "@/features/browser/store";
import {
  useChatInsertStore,
  chatInsertActions,
  serializeChatInsertPayload,
} from "@/shared/stores/chatInsertStore";

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

  useEffect(() => {
    const unsubscribe = useChatInsertStore.subscribe((state, prevState) => {
      if (!state.pending || state.pending === prevState.pending) return;

      const payload = state.pending;
      void serializeChatInsertPayload(payload)
        .then((serialized) => native.events.send(CHAT_INSERT, serialized))
        .catch((error) => {
          console.error("[DetachedBrowserWindow] Failed to bridge chat insert:", error);
        })
        .finally(() => {
          chatInsertActions.consume();
        });
    });

    return unsubscribe;
  }, []);

  // Listen for workspace changes from the main window
  useEffect(() => {
    const unlisten = native.events.on(BROWSER_WORKSPACE_CHANGE, (data) => {
      setWorkspaceContext((prev) => ({
        workspaceId: data.workspaceId,
        directoryName: data.directoryName ?? prev?.directoryName ?? null,
        repoName: data.repoName ?? prev?.repoName ?? null,
        branch: data.branch ?? prev?.branch ?? null,
      }));
    });

    return unlisten;
  }, []);

  // Keep detached window title in sync with workspace context.
  useEffect(() => {
    const nextTitle = buildWindowTitle(workspaceContext);
    native.window.setTitle(nextTitle).catch(() => {});
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
