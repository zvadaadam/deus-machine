/**
 * Right Side Panel — narrow sidebar with file tree, sidecar tabs.
 *
 * Diffs and file previews open in the middle panel (side-by-side with chat).
 * Panel sizing is managed by react-resizable-panels (parent PanelGroup).
 * PR actions have moved to WorkspaceHeader (unified header bar).
 *
 * Layout: [Content panel (file tree/browser/terminal)] [Sidecar tabs]
 */

import { useCallback, useMemo } from "react";
import { TerminalPanel } from "@/features/terminal";
import { useWorkspaceLayout, useFileChanges, useUncommittedFiles, useLastTurnFiles } from "@/features/workspace";
import type { WorkspaceGitInfo } from "@/features/workspace";
import { CodePanelContent } from "@/features/workspace/ui/CodePanelContent";
import { ConfigPanel } from "@/features/workspace/ui/ConfigPanel";
import { DesignPanel } from "@/features/workspace/ui/DesignPanel";
import { RightSidecar } from "@/features/workspace/ui/RightSidecar";
import { BrowserPanel } from "@/features/browser";
import { BrowserDetachedPlaceholder } from "@/features/browser/ui/BrowserDetachedPlaceholder";
import { useBrowserDetach } from "@/features/browser/hooks/useBrowserDetach";
import { cn } from "@/shared/lib/utils";
import type { RightSideTab } from "@/features/workspace/store";
import type { Workspace } from "@/shared/types";

interface RightSidePanelProps {
  workspace: Workspace;
  /** Open a diff in the middle panel */
  onOpenDiffTab: (filePath: string) => void;
  /** Open a file preview in the middle panel */
  onOpenFilePreview: (filePath: string) => void;
  /** Compact mode — narrower panel when diff viewer is active */
  compact?: boolean;
  /** Whether chat panel is collapsed — drives flex-1 expansion */
  chatPanelCollapsed?: boolean;
  /** Called when a non-code sidecar tab is clicked in compact mode (closes diff) */
  onExitCompactMode?: () => void;
  /** Called when user switches sidecar back to Code (used to restore parked diff layout) */
  onReturnToCode?: () => void;
  /** Whether file watcher is active — disables polling in useFileChanges */
  isWatched?: boolean;
}

export function RightSidePanel({
  workspace,
  onOpenDiffTab,
  onOpenFilePreview,
  compact,
  chatPanelCollapsed,
  onExitCompactMode,
  onReturnToCode,
  isWatched = false,
}: RightSidePanelProps) {
  const {
    rightSideTab,
    selectedFilePath,
    setRightSideTab,
    setSelectedFilePath,
  } = useWorkspaceLayout(workspace.id);

  const {
    isDetached: isBrowserDetached,
    detach: detachBrowser,
    reattach: reattachBrowser,
  } = useBrowserDetach({
    workspaceId: workspace.id,
    directoryName: workspace.directory_name,
    repoName: workspace.repo_name,
    branch: workspace.branch,
  });

  // Workspace git info for file changes query (Tauri IPC path)
  const workspaceGitInfo: WorkspaceGitInfo = useMemo(
    () => ({
      root_path: workspace.root_path,
      directory_name: workspace.directory_name,
    }),
    [workspace.root_path, workspace.directory_name]
  );

  // File changes query — polling disabled when file watcher is active
  const { data: fileChangesData } = useFileChanges(
    workspace.id,
    workspace.session_status,
    workspaceGitInfo,
    isWatched
  );
  const fileChanges = useMemo(() => fileChangesData ?? [], [fileChangesData]);

  // Uncommitted files (HEAD → workdir) and last-turn files (checkpoint → workdir)
  const { data: uncommittedData } = useUncommittedFiles(
    workspace.id,
    workspace.session_status,
    workspaceGitInfo
  );
  const uncommittedFiles = useMemo(() => uncommittedData ?? [], [uncommittedData]);

  const { data: lastTurnData } = useLastTurnFiles(
    workspace.id,
    workspace.active_session_id,
    workspace.session_status,
    workspaceGitInfo
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
        // Changed file — relative path, open diff viewer
        setSelectedFilePath(path, "changes");
        onOpenDiffTab(path);
      } else {
        // Regular file — build full workspace path, open preview
        const base = workspace.workspace_path.replace(/\/+$/, "");
        const rel = path.replace(/^\/+/, "");
        const fullPath = `${base}/${rel}`;
        setSelectedFilePath(path, "files");
        onOpenFilePreview(fullPath);
      }
    },
    [changedPaths, onOpenDiffTab, onOpenFilePreview, setSelectedFilePath, workspace.workspace_path]
  );

  const handleRightSideTabChange = useCallback(
    (tab: RightSideTab) => {
      setRightSideTab(tab);
      if (tab === "code") {
        onReturnToCode?.();
      }
    },
    [setRightSideTab, onReturnToCode]
  );

  return (
    <div
      className={cn(
        "flex h-full min-w-0 flex-col",
        !compact && "border-border-subtle border-l",
      )}
    >
      <div className="flex min-h-0 flex-1 overflow-hidden">
        {/* Content panel: file tree, browser, terminal, config, design */}
        <div className="bg-bg-raised flex h-full flex-1 flex-col overflow-hidden">
          {/* In compact mode, force code tab content regardless of sidecar selection */}
          {(compact || rightSideTab === "code") && (
            <CodePanelContent
              workspace={workspace}
              fileChanges={fileChanges}
              uncommittedFiles={uncommittedFiles}
              lastTurnFiles={lastTurnFiles}
              selectedFilePath={selectedFilePath}
              onFileClick={handleFileClick}
            />
          )}

          {/* Browser panel section: when detached, show placeholder; otherwise
              keep BrowserPanel always mounted for the useBrowserRpcHandler listener. */}
          {isBrowserDetached ? (
            <div
              className={cn("h-full w-full", (compact || rightSideTab !== "browser") && "hidden")}
            >
              <BrowserDetachedPlaceholder onReattach={reattachBrowser} />
            </div>
          ) : (
            <div
              className={cn(
                "h-full w-full",
                (compact || rightSideTab !== "browser") && "pointer-events-none invisible absolute"
              )}
            >
              <BrowserPanel
                workspaceId={workspace.id}
                panelVisible={!compact && rightSideTab === "browser"}
                onDetach={detachBrowser}
              />
            </div>
          )}

          {!compact && rightSideTab === "terminal" && (
            <TerminalPanel workspacePath={workspace.workspace_path} />
          )}

          {!compact && rightSideTab === "config" && <ConfigPanel />}

          {!compact && rightSideTab === "design" && <DesignPanel workspaceId={workspace.id} />}
        </div>

        <RightSidecar
          activeTab={rightSideTab}
          onTabChange={handleRightSideTabChange}
          compact={compact}
          onRequestExitCompact={onExitCompactMode}
        />
      </div>
    </div>
  );
}
