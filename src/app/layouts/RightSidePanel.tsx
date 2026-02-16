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
import { useWorkspaceLayout, useFileChanges } from "@/features/workspace";
import type { WorkspaceGitInfo } from "@/features/workspace";
import { CodePanelContent } from "@/features/workspace/ui/CodePanelContent";
import { ConfigPanel } from "@/features/workspace/ui/ConfigPanel";
import { DesignPanel } from "@/features/workspace/ui/DesignPanel";
import { RightSidecar } from "@/features/workspace/ui/RightSidecar";
import { BrowserPanel } from "@/features/browser";
import { BrowserDetachedPlaceholder } from "@/features/browser/ui/BrowserDetachedPlaceholder";
import { useBrowserDetach } from "@/features/browser/hooks/useBrowserDetach";
import { cn } from "@/shared/lib/utils";
import type { RightPanelTab, RightSideTab } from "@/features/workspace/store";
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
}

export function RightSidePanel({
  workspace,
  onOpenDiffTab,
  onOpenFilePreview,
  compact,
  chatPanelCollapsed,
  onExitCompactMode,
  onReturnToCode,
}: RightSidePanelProps) {
  const {
    rightSideTab,
    rightPanelTab,
    selectedFilePath,
    setRightSideTab,
    setRightPanelTab,
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

  // File changes query
  const { data: fileChangesData } = useFileChanges(
    workspace.id,
    workspace.session_status,
    workspaceGitInfo
  );
  const fileChanges = useMemo(() => fileChangesData ?? [], [fileChangesData]);

  // --- Handlers ---

  const handleFileSelect = useCallback(
    (path: string | null) => {
      if (!path) return;
      setSelectedFilePath(path, "changes");
      onOpenDiffTab(path);
    },
    [onOpenDiffTab, setSelectedFilePath]
  );

  const handleBrowserFileClick = useCallback(
    (path: string) => {
      const base = workspace.workspace_path.replace(/\/+$/, "");
      const rel = path.replace(/^\/+/, "");
      const fullPath = `${base}/${rel}`;
      setSelectedFilePath(fullPath, "files");
      onOpenFilePreview(fullPath);
    },
    [onOpenFilePreview, setSelectedFilePath, workspace.workspace_path]
  );

  const handleCodeTabChange = useCallback(
    (tab: RightPanelTab) => setRightPanelTab(tab),
    [setRightPanelTab]
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
              rightPanelTab={rightPanelTab}
              selectedFilePath={selectedFilePath}
              onTabChange={handleCodeTabChange}
              onFileSelect={handleFileSelect}
              onBrowserFileClick={handleBrowserFileClick}
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
