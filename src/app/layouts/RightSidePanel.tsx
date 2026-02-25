/**
 * Right Side Panel — content area for the right panel.
 *
 * Renders file tree, browser, terminal, config, or design based on
 * the active sidecar tab. The sidecar icon strip itself is rendered
 * separately in MainContent (outside the ResizablePanelGroup).
 *
 * Diffs and file previews open in the middle panel (side-by-side with chat).
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
import type { WorkspaceGitInfo } from "@/features/workspace";
import { CodePanelContent } from "@/features/workspace/ui/CodePanelContent";
import { ConfigPanel } from "@/features/workspace/ui/ConfigPanel";
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
  /** Which sidecar tab is active — drives content switching */
  activeTab: RightSideTab;
  /** Open a diff in the middle panel */
  onOpenDiffTab: (filePath: string) => void;
  /** Open a file preview in the middle panel */
  onOpenFilePreview: (filePath: string) => void;
  /** Compact mode — narrower panel when diff viewer is active */
  compact?: boolean;
  /** Whether file watcher is active — disables polling in useFileChanges */
  isWatched?: boolean;
}

export function RightSidePanel({
  workspace,
  activeTab,
  onOpenDiffTab,
  onOpenFilePreview,
  compact,
  isWatched = false,
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

  // Workspace git info for file changes query (Tauri IPC path)
  // Must include all fields — missing parent_branch/workspace_path causes
  // incorrect branch resolution and phantom diffs.
  const workspaceGitInfo: WorkspaceGitInfo = useMemo(
    () => ({
      root_path: workspace.root_path,
      slug: workspace.slug,
      workspace_path: workspace.workspace_path,
      git_target_branch: workspace.git_target_branch ?? undefined,
      git_default_branch: workspace.git_default_branch,
    }),
    [workspace.root_path, workspace.slug, workspace.workspace_path, workspace.git_target_branch, workspace.git_default_branch]
  );

  // Don't query diffs until the worktree checkout is complete — during "initializing"
  // git is still writing files, producing phantom diffs that clear on next fetch.
  const isReady = workspace.state === "ready";

  // File changes query — polling disabled when file watcher is active
  const { data: fileChangesData } = useFileChanges(
    isReady ? workspace.id : null,
    workspace.session_status,
    workspaceGitInfo,
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
    workspaceGitInfo,
    workspace.state
  );
  const uncommittedFiles = useMemo(() => uncommittedData ?? [], [uncommittedData]);

  const { data: lastTurnData } = useLastTurnFiles(
    isReady ? workspace.id : null,
    workspace.current_session_id,
    workspace.session_status,
    workspaceGitInfo,
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

  return (
    <div className={cn(
      "bg-bg-raised flex h-full min-w-0 flex-1 flex-col overflow-hidden",
      !compact && "border-border-subtle border-l"
    )}>
      {/* In compact mode, force code tab content regardless of sidecar selection */}
      {(compact || activeTab === "code") && (
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
        />
      )}

      {/* Browser panel section: when detached, show placeholder; otherwise
          keep BrowserPanel always mounted for the useBrowserRpcHandler listener. */}
      {isBrowserDetached ? (
        <div
          className={cn("h-full w-full", (compact || activeTab !== "browser") && "hidden")}
        >
          <BrowserDetachedPlaceholder onReattach={reattachBrowser} />
        </div>
      ) : (
        <div
          className={cn(
            "h-full w-full",
            (compact || activeTab !== "browser") && "pointer-events-none invisible absolute"
          )}
        >
          <BrowserPanel
            workspaceId={workspace.id}
            panelVisible={!compact && activeTab === "browser"}
            onDetach={detachBrowser}
          />
        </div>
      )}

      {!compact && activeTab === "terminal" && (
        <TerminalPanel workspaceId={workspace.id} workspacePath={workspace.workspace_path} />
      )}

      {!compact && activeTab === "notebook" && (
        <NotebookPanel
          workspacePath={workspace.workspace_path}
          sessionStatus={workspace.session_status}
        />
      )}

      {!compact && activeTab === "config" && <ConfigPanel />}

      {!compact && activeTab === "design" && <DesignPanel workspaceId={workspace.id} />}

      {!compact && activeTab === "simulator" && (
        <SimulatorPanel workspaceId={workspace.id} workspacePath={workspace.workspace_path} />
      )}
    </div>
  );
}
