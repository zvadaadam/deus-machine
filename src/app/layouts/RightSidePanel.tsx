/**
 * Right Side Panel — narrow sidebar with file tree, sidecar tabs, and PR actions.
 *
 * Diffs and file previews open in the middle panel (side-by-side with chat).
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
  /** Open a diff in the middle panel */
  onOpenDiffTab: (filePath: string) => void;
  /** Open a file preview in the middle panel */
  onOpenFilePreview: (filePath: string) => void;
  /** Compact mode — narrower panel when diff viewer is active */
  compact?: boolean;
  /** Custom width for the compact content panel (from resize handle) */
  compactWidth?: number | null;
  /** Hide PRStatusBar (rendered by parent instead for header alignment) */
  hidePRStatus?: boolean;
}

export function RightSidePanel({
  workspace,
  prStatus,
  createPRHandler,
  onExpandedChange,
  rightPanelWidth,
  rightSideStyle,
  onOpenDiffTab,
  onOpenFilePreview,
  compact,
  compactWidth,
  hidePRStatus,
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
      const base = workspace.workspace_path.replace(/\/+$/, "");
      const rel = path.replace(/^\/+/, "");
      onOpenFilePreview(`${base}/${rel}`);
    },
    [onOpenFilePreview, workspace.workspace_path]
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
        "flex h-full min-w-0 flex-col",
        !compact && "border-border/40 border-l",
        !compact && rightSideExpanded && "min-w-[380px]",
        !compact && rightSideExpanded && rightPanelWidth === null && "flex-1"
      )}
      style={rightSideStyle}
    >
      {!hidePRStatus && (
        <PRStatusBar
          prStatus={prStatus}
          onCreatePR={createPRHandler ? handleCreatePR : undefined}
          onReviewPR={handleOpenPR}
          compact={compact}
        />
      )}

      <div className="flex min-h-0 flex-1 overflow-hidden">
        {/* Content panel: file tree, browser, terminal, config, design */}
        <div
          className={cn(
            "bg-background/50 flex h-full flex-col overflow-hidden backdrop-blur-sm",
            compact
              ? compactWidth == null
                ? "w-[220px]"
                : undefined
              : rightSideTab === "browser"
                ? "flex-1"
                : "w-[380px]"
          )}
          style={
            compact && compactWidth != null ? { width: compactWidth, flexShrink: 0 } : undefined
          }
        >
          {/* In compact mode, force code tab content regardless of sidecar selection */}
          {(compact ? true : rightSideTab === "code") && (
            <CodePanelContent
              workspace={workspace}
              fileChanges={fileChanges}
              rightPanelTab={rightPanelTab}
              onTabChange={handleCodeTabChange}
              onFileSelect={handleFileSelect}
              onBrowserFileClick={handleBrowserFileClick}
            />
          )}

          {!compact && rightSideTab === "browser" && <BrowserPanel workspaceId={workspace.id} />}

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
        />
      </div>
    </div>
  );
}
