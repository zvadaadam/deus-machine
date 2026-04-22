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

import { TerminalPanel } from "@/features/terminal";
import { ChangesView } from "@/features/workspace/ui/ChangesView";
import { FilesView } from "@/features/workspace/ui/FilesView";
import { AgentConfigPanel } from "@/features/agent-config/ui/AgentConfigPanel";
import { DesignPanel } from "@/features/workspace/ui/DesignPanel";
import { BrowserPanel } from "@/features/browser";
import { SimulatorPanel } from "@/features/simulator";
import { AppsLauncher, useAppsLaunched, useAppsStopped } from "@/features/apps";
import { capabilities } from "@/platform/capabilities";
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
}

export function ContentView({
  workspace,
  activeTab,
  isWatched = false,
  onReview,
}: ContentViewProps) {
  // AAP lifecycle → Browser tabs: open on launch, close on stop/crash.
  // Both hooks ignore events targeting other workspaces and always mount
  // during a workspace session so a launch/stop completed while the user
  // is on a different content tab still takes effect.
  useAppsLaunched(workspace.id);
  useAppsStopped(workspace.id);

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
        <TerminalPanel
          workspaceId={workspace.id}
          workspacePath={workspace.workspace_path}
          panelVisible={activeTab === "terminal"}
        />
      </div>

      {capabilities.nativeSimulator && (
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
