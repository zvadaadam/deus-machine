/**
 * Content View — thin router for the active content tab.
 *
 * Each tab is either:
 *   - Lazy: mounted/unmounted on tab switch (Changes, Files, Config, Design)
 *   - Persistent: always mounted, hidden when inactive (Terminal, Browser, Simulator)
 *     These preserve native state (PTY sessions, WebView instances).
 *
 * Data fetching is owned by each tab component, not by this router.
 */

import { useLayoutEffect, useState } from "react";
import { TerminalPanel } from "@/features/terminal";
import { ChangesView } from "@/features/workspace/ui/ChangesView";
import { FilesView } from "@/features/workspace/ui/FilesView";
import { AgentConfigPanel } from "@/features/agent-config/ui/AgentConfigPanel";
import { DesignPanel } from "@/features/workspace/ui/DesignPanel";
import { BrowserPanel } from "@/features/browser";
import { SimulatorPanel } from "@/features/simulator";
import { AppsLauncher, useAppsLaunched, useAppsStopped } from "@/features/apps";
import { cn } from "@/shared/lib/utils";
import type { ContentTab } from "@/features/workspace/store";
import type { Workspace } from "@/shared/types";

interface ContentViewProps {
  workspace: Workspace;
  activeTab: ContentTab;
  /** Whether file watcher is active */
  isWatched?: boolean;
  /** Insert a code review prompt into the chat input */
  onReview?: () => void;
  simulatorAvailable: boolean;
}

export function ContentView({
  workspace,
  activeTab,
  isWatched = false,
  onReview,
  simulatorAvailable,
}: ContentViewProps) {
  // AAP lifecycle → Browser tabs: open on launch, close on stop/crash.
  // Both hooks ignore events targeting other workspaces and always mount
  // during a workspace session so a launch/stop completed while the user
  // is on a different content tab still takes effect.
  useAppsLaunched(workspace.id);
  useAppsStopped(workspace.id);

  // The terminal mounts for the LAST LOCAL workspace even while a cloud one
  // is selected — see the comment at the render site. A LOCAL selection uses
  // the live prop directly (no first-frame gap); the committed state only
  // serves CLOUD renders, so it may lag by an effect tick without being
  // user-visible. Updated in a layout effect, not during render — a discarded
  // render must not leak an uncommitted workspace into a later cloud mount.
  const [lastLocalTerminal, setLastLocalTerminal] = useState<{ id: string; path: string } | null>(
    null
  );
  useLayoutEffect(() => {
    if (workspace.kind !== "cloud") {
      setLastLocalTerminal((prev) =>
        prev?.id === workspace.id && prev.path === workspace.workspace_path
          ? prev
          : { id: workspace.id, path: workspace.workspace_path }
      );
    }
  }, [workspace.kind, workspace.id, workspace.workspace_path]);
  const terminalTarget =
    workspace.kind !== "cloud"
      ? { id: workspace.id, path: workspace.workspace_path }
      : lastLocalTerminal;

  return (
    <div className="flex h-full min-w-0 flex-1 flex-col overflow-hidden">
      {/* Lazy tabs — mounted only when active */}
      {activeTab === "changes" && (
        <ChangesView workspace={workspace} isWatched={isWatched} onReview={onReview} />
      )}

      {activeTab === "files" && <FilesView workspace={workspace} isWatched={isWatched} />}

      {activeTab === "config" && <AgentConfigPanel workspace={workspace} />}

      {activeTab === "design" && <DesignPanel workspaceId={workspace.id} />}

      {activeTab === "apps" && <AppsLauncher workspaceId={workspace.id} />}

      {/* Persistent tabs — always mounted, hidden when inactive */}
      <div
        className={cn(
          "h-full w-full min-w-0 overflow-hidden",
          activeTab !== "browser" && "pointer-events-none invisible absolute"
        )}
      >
        <BrowserPanel workspaceId={workspace.id} panelVisible={activeTab === "browser"} />
      </div>

      <div
        className={cn(
          "h-full w-full",
          activeTab !== "terminal" && "pointer-events-none invisible absolute"
        )}
      >
        {workspace.kind === "cloud" && (
          // A LOCAL shell here would masquerade as the sandbox — the same
          // truthfulness class as every state-collapse bug this sprint. The
          // real remote PTY rides the sidecar session channel (browser:input
          // proves the streaming pattern); until it lands, say so.
          <div className="text-muted-foreground flex h-full w-full flex-col items-center justify-center gap-1.5 text-sm">
            <p className="text-foreground/70 font-medium">Terminal attaches to the cloud sandbox</p>
            <p className="max-w-sm text-center text-xs">
              The remote shell is coming — for now, ask the agent to run commands; it executes
              inside the sandbox.
            </p>
          </div>
        )}
        {terminalTarget && (
          // Mounted through cloud selections too (frozen on the last LOCAL
          // workspace): TerminalPanel keeps every visited workspace's xterm
          // buffers in component state, so unmounting it on a cloud visit
          // silently discarded scrollback that survives every local↔local
          // switch. Cloud ids never enter the panel — a local PTY at a cloud
          // row's path would be the masquerade the placeholder exists to
          // avoid.
          <div className={cn("h-full w-full", workspace.kind === "cloud" && "hidden")}>
            <TerminalPanel
              workspaceId={terminalTarget.id}
              workspacePath={terminalTarget.path}
              panelVisible={activeTab === "terminal" && workspace.kind !== "cloud"}
            />
          </div>
        )}
      </div>

      {simulatorAvailable && (
        <div
          className={cn(
            "h-full w-full",
            activeTab !== "simulator" && "pointer-events-none invisible absolute"
          )}
        >
          <SimulatorPanel workspaceId={workspace.id} workspacePath={workspace.workspace_path} />
        </div>
      )}
    </div>
  );
}
