/**
 * Content Panel -- renders the active content tab (Code, Terminal, Browser, etc.).
 *
 * Lives inside the right "content" panel of the two-panel layout
 * (Session | Content). The content tab header (ContentTabBar + PRActions)
 * is rendered by MainContent above this component.
 *
 * Panel sizing is managed by react-resizable-panels (parent PanelGroup).
 */

import { useCallback, useMemo } from "react";
import { TerminalPanel } from "@/features/terminal";
import { NotebookPanel } from "@/features/notebook";
import {
  useWorkspaceLayout,
  useFileChanges,
  useUncommittedFiles,
  useLastTurnFiles,
} from "@/features/workspace";
import { CodePanelContent } from "@/features/workspace/ui/CodePanelContent";
import { AgentConfigPanel } from "@/features/agent-config/ui/AgentConfigPanel";
import { DesignPanel } from "@/features/workspace/ui/DesignPanel";
import { BrowserPanel } from "@/features/browser";
import { SimulatorPanel } from "@/features/simulator";
import { BrowserDetachedPlaceholder } from "@/features/browser/ui/BrowserDetachedPlaceholder";
import { useBrowserDetach } from "@/features/browser/hooks/useBrowserDetach";
import { cn } from "@/shared/lib/utils";
import type { RightSideTab } from "@/features/workspace/store";
import type { Workspace } from "@/shared/types";

interface RightSidePanelProps {
  workspace: Workspace;
  /** Which content tab is active -- drives content switching */
  activeTab: RightSideTab;
  /** Switch to the code tab (used by file click handlers) */
  onSwitchToCodeTab: () => void;
  /** Whether file watcher is active -- disables polling in useFileChanges */
  isWatched?: boolean;
  /** Insert a code review prompt into the chat input */
  onReview?: () => void;
}

export function RightSidePanel({
  workspace,
  activeTab,
  onSwitchToCodeTab,
  isWatched = false,
  onReview,
}: RightSidePanelProps) {
  const { selectedFilePath, setSelectedFilePath, rightPanelTab, setRightPanelTab } =
    useWorkspaceLayout(workspace.id);

  // Map store's RightPanelTab ("changes"|"files") → FileBrowserPanel's FilterMode ("changes"|"all")
  const filterMode = rightPanelTab === "files" ? "all" : "changes";
  const handleFilterModeChange = (mode: "all" | "changes") => {
    setRightPanelTab(mode === "all" ? "files" : "changes");
  };

  const {
    isDetached: isBrowserDetached,
    detach: detachBrowser,
    reattach: reattachBrowser,
  } = useBrowserDetach({
    workspaceId: workspace.id,
    directoryName: workspace.slug,
    repoName: workspace.repo_name,
    branch: workspace.git_branch,
  });

  // Don't query diffs until the worktree checkout is complete — during "initializing"
  // git is still writing files, producing phantom diffs that clear on next fetch.
  const isReady = workspace.state === "ready";

  // File changes query — polling disabled when file watcher is active
  const { data: fileChangesData } = useFileChanges(
    isReady ? workspace.id : null,
    workspace.session_status,
    isWatched,
    workspace.state
  );
  const fileChanges = useMemo(() => fileChangesData?.files ?? [], [fileChangesData]);
  const fileChangesTruncated = fileChangesData?.truncated ?? false;
  const fileChangesTotalCount = fileChangesData?.totalCount ?? 0;

  // Uncommitted files (HEAD → workdir) and last-turn files (checkpoint → workdir)
  const { data: uncommittedData } = useUncommittedFiles(
    isReady ? workspace.id : null,
    workspace.session_status,
    workspace.state
  );
  const uncommittedFiles = useMemo(() => uncommittedData ?? [], [uncommittedData]);

  const { data: lastTurnData } = useLastTurnFiles(
    isReady ? workspace.id : null,
    workspace.current_session_id,
    workspace.session_status,
    workspace.state
  );
  const lastTurnFiles = useMemo(() => lastTurnData ?? [], [lastTurnData]);

  // --- Handlers ---

  // Build a set of changed file paths for O(1) lookup
  const changedPaths = useMemo(() => {
    const set = new Set<string>();
    const addPaths = (changes: typeof fileChanges) => {
      for (const c of changes) {
        const p = c.file || c.file_path || "";
        if (p) set.add(p);
      }
    };
    addPaths(fileChanges);
    addPaths(uncommittedFiles);
    addPaths(lastTurnFiles);
    return set;
  }, [fileChanges, uncommittedFiles, lastTurnFiles]);

  // Unified file click handler: changed files → open diff, others → open preview
  const handleFileClick = useCallback(
    (path: string) => {
      if (changedPaths.has(path)) {
        setSelectedFilePath(path, "changes");
      } else {
        setSelectedFilePath(path, "files");
      }
      onSwitchToCodeTab();
    },
    [changedPaths, onSwitchToCodeTab, setSelectedFilePath]
  );

  return (
    <div className="flex h-full min-w-0 flex-1 flex-col overflow-hidden">
      {activeTab === "code" && (
        <CodePanelContent
          workspace={workspace}
          fileChanges={fileChanges}
          uncommittedFiles={uncommittedFiles}
          lastTurnFiles={lastTurnFiles}
          fileChangesTruncated={fileChangesTruncated}
          fileChangesTotalCount={fileChangesTotalCount}
          selectedFilePath={selectedFilePath}
          onFileClick={handleFileClick}
          filterMode={filterMode}
          onFilterModeChange={handleFilterModeChange}
          onReview={onReview}
        />
      )}

      {/* Browser panel section: when detached, show placeholder; otherwise
          keep BrowserPanel always mounted for the useBrowserRpcHandler listener. */}
      {isBrowserDetached ? (
        <div className={cn("h-full w-full", activeTab !== "browser" && "hidden")}>
          <BrowserDetachedPlaceholder onReattach={reattachBrowser} />
        </div>
      ) : (
        <div
          className={cn(
            "h-full w-full",
            activeTab !== "browser" && "pointer-events-none invisible absolute"
          )}
        >
          <BrowserPanel
            workspaceId={workspace.id}
            panelVisible={activeTab === "browser"}
            onDetach={detachBrowser}
          />
        </div>
      )}

      {/* Terminal panel: always mounted so PTY sessions and xterm.js DOM survive
          tab switches (same pattern as BrowserPanel and SimulatorPanel). */}
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

      {activeTab === "notebook" && (
        <NotebookPanel
          workspacePath={workspace.workspace_path}
          sessionStatus={workspace.session_status}
        />
      )}

      {activeTab === "config" && <AgentConfigPanel workspace={workspace} />}

      {activeTab === "design" && <DesignPanel workspaceId={workspace.id} />}

      {/* Simulator panel: always mounted so useSimulatorRpcHandler stays active
          for agent-driven SimulatorStart/ListDevices calls (same pattern as BrowserPanel). */}
      <div
        className={cn(
          "h-full w-full",
          activeTab !== "simulator" && "pointer-events-none invisible absolute"
        )}
      >
        <SimulatorPanel workspaceId={workspace.id} workspacePath={workspace.workspace_path} />
      </div>
    </div>
  );
}
