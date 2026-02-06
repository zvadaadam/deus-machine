/**
 * Right Side Panel — narrow sidebar with file tree, sidecar tabs, and PR actions.
 *
 * Diffs/file viewing now open as tabs in the ChatArea (VS Code pattern).
 * This panel stays at fixed width except when browser tab is active.
 *
 * Layout: [Content panel (file tree/browser/terminal)] [Sidecar tabs]
 */

import { useEffect, useRef, useCallback, useMemo } from "react";
import { toast } from "sonner";
import { TerminalPanel } from "@/features/terminal";
import { useWorkspaceLayout, useFileChanges } from "@/features/workspace";
import type { WorkspaceGitInfo } from "@/features/workspace";
import { CodePanelContent } from "@/features/workspace/ui/CodePanelContent";
import { ConfigPanel } from "@/features/workspace/ui/ConfigPanel";
import { DesignPanel } from "@/features/workspace/ui/DesignPanel";
import { PRStatusBar } from "@/features/workspace/ui/PRStatusBar";
import { RightSidecar } from "@/features/workspace/ui/RightSidecar";
import { BrowserPanel } from "@/features/browser";
import { cn } from "@/shared/lib/utils";
import type { RightPanelTab, RightSideTab } from "@/features/workspace/store";
import type { Workspace, PRStatus } from "@/shared/types";

interface RightSidePanelProps {
  workspace: Workspace;
  prStatus: PRStatus | null;
  createPRHandler: (() => void) | null;
  onExpandedChange: (expanded: boolean) => void;
  /** Current panel width from store — used for flex-1 conditional */
  rightPanelWidth: number | null;
  /** Inline style for custom width (browser mode) */
  rightSideStyle?: React.CSSProperties;
  /** Open a diff tab in the chat area */
  onOpenDiffTab: (filePath: string) => void;
  /** Open a file viewer tab in the chat area */
  onOpenFileTab: (filePath: string) => void;
}

export function RightSidePanel({
  workspace,
  prStatus,
  createPRHandler,
  onExpandedChange,
  rightPanelWidth,
  rightSideStyle,
  onOpenDiffTab,
  onOpenFileTab,
}: RightSidePanelProps) {
  const { rightSideTab, rightPanelTab, setRightSideTab, setRightPanelTab } = useWorkspaceLayout(
    workspace.id
  );

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

  // Expansion: only when browser tab is active
  const rightSideExpanded = rightSideTab === "browser";

  // Notify parent of expansion state changes
  const prevExpandedRef = useRef(rightSideExpanded);
  useEffect(() => {
    if (rightSideExpanded !== prevExpandedRef.current) {
      prevExpandedRef.current = rightSideExpanded;
      onExpandedChange(rightSideExpanded);
    }
  }, [rightSideExpanded, onExpandedChange]);

  // --- Handlers ---

  const handleFileSelect = useCallback(
    (path: string | null) => {
      if (path) onOpenDiffTab(path);
    },
    [onOpenDiffTab]
  );

  const handleBrowserFileClick = useCallback(
    (path: string) => {
      onOpenFileTab(`${workspace.workspace_path}/${path}`);
    },
    [onOpenFileTab, workspace.workspace_path]
  );

  const handleCodeTabChange = useCallback(
    (tab: RightPanelTab) => setRightPanelTab(tab),
    [setRightPanelTab]
  );

  const handleRightSideTabChange = useCallback(
    (tab: RightSideTab) => setRightSideTab(tab),
    [setRightSideTab]
  );

  const handleCreatePR = useCallback(() => {
    if (!createPRHandler) {
      toast.error("No active session available to create a PR.");
      return;
    }
    createPRHandler();
  }, [createPRHandler]);

  const handleOpenPR = useCallback(() => {
    if (!prStatus?.pr_url) {
      toast.error("PR link not available.");
      return;
    }
    window.open(prStatus.pr_url, "_blank", "noopener,noreferrer");
  }, [prStatus]);

  return (
    <div
      className={cn(
        "border-border/40 flex h-full min-w-0 flex-col border-l",
        rightSideExpanded && "min-w-[380px]",
        rightSideExpanded && rightPanelWidth === null && "flex-1"
      )}
      style={rightSideStyle}
    >
      <PRStatusBar
        prStatus={prStatus}
        onCreatePR={createPRHandler ? handleCreatePR : undefined}
        onReviewPR={handleOpenPR}
      />

      <div className="flex min-h-0 flex-1 overflow-hidden">
        {/* Content panel: file tree, browser, terminal, config, design */}
        <div
          className={cn(
            "bg-background/50 flex h-full flex-col overflow-hidden backdrop-blur-sm",
            rightSideTab === "browser" ? "flex-1" : "w-[380px]"
          )}
        >
          {rightSideTab === "code" && (
            <CodePanelContent
              workspace={workspace}
              fileChanges={fileChanges}
              rightPanelTab={rightPanelTab}
              onTabChange={handleCodeTabChange}
              onFileSelect={handleFileSelect}
              onBrowserFileClick={handleBrowserFileClick}
            />
          )}

          {rightSideTab === "browser" && <BrowserPanel workspaceId={workspace.id} />}

          {rightSideTab === "terminal" && (
            <TerminalPanel workspacePath={workspace.workspace_path} />
          )}

          {rightSideTab === "config" && <ConfigPanel />}

          {rightSideTab === "design" && <DesignPanel workspaceId={workspace.id} />}
        </div>

        <RightSidecar activeTab={rightSideTab} onTabChange={handleRightSideTabChange} />
      </div>
    </div>
  );
}
