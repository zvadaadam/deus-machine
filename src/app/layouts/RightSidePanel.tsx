/**
 * Right Side Panel — narrow sidebar with file tree, sidecar tabs, and PR actions.
 *
 * Diffs and file previews open in the middle panel (side-by-side with chat).
 * This panel stays at fixed width except when browser tab is active.
 *
 * Layout: [Content panel (file tree/browser/terminal)] [Sidecar tabs]
 */

import { useCallback, useMemo } from "react";
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
  /** Whether the user is actively dragging the resize handle — disables transitions */
  isResizing?: boolean;
}

export function RightSidePanel({
  workspace,
  prStatus,
  createPRHandler,
  rightPanelWidth,
  rightSideStyle,
  onOpenDiffTab,
  onOpenFilePreview,
  compact,
  compactWidth,
  hidePRStatus,
  isResizing,
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

  // Whether outer container has explicit width from parent (user drag or smart default)
  const hasExplicitWidth = rightSideStyle !== undefined;

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

  // Merge inline style with transition override when dragging
  const outerStyle: React.CSSProperties | undefined = isResizing
    ? { ...rightSideStyle, transition: "none" }
    : rightSideStyle;

  return (
    <div
      className={cn(
        "flex h-full min-w-0 flex-col",
        // Smooth width transition when resizing or switching tabs (matches sidebar curve)
        !compact &&
          !isResizing &&
          "transition-[width,min-width,flex] duration-[280ms] ease-[cubic-bezier(.19,1,.22,1)]",
        !compact && "border-border-subtle border-l",
        !compact && "min-w-[380px]",
        // Browser with no saved width: fill available space (smart default measures + persists)
        !compact && rightSideTab === "browser" && rightPanelWidth === null && "flex-1"
      )}
      style={outerStyle}
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
            "bg-bg-raised flex h-full flex-col overflow-hidden",
            // Smooth width transition when switching tabs (disabled during drag)
            !compact &&
              !isResizing &&
              "transition-[width,flex] duration-[280ms] ease-[cubic-bezier(.19,1,.22,1)]",
            compact
              ? compactWidth == null
                ? "w-[220px]"
                : undefined
              : hasExplicitWidth || rightSideTab === "browser"
                ? "flex-1"
                : "w-[380px]"
          )}
          style={
            compact && compactWidth != null ? { width: compactWidth, flexShrink: 0 } : undefined
          }
        >
          {/* In compact mode, force code tab content regardless of sidecar selection */}
          {(compact || rightSideTab === "code") && (
            <CodePanelContent
              workspace={workspace}
              fileChanges={fileChanges}
              rightPanelTab={rightPanelTab}
              onTabChange={handleCodeTabChange}
              onFileSelect={handleFileSelect}
              onBrowserFileClick={handleBrowserFileClick}
            />
          )}

          {/* BrowserPanel is ALWAYS mounted — even in compact mode — to keep
              the useBrowserRpcHandler Tauri event listener active so the sidecar's
              browser MCP tools (BrowserNavigate, BrowserSnapshot, etc.) always have
              a handler. CSS hides the wrapper; panelVisible tells BrowserPanel to
              hide/show native webviews via Tauri IPC (they render above the DOM). */}
          <div
            className={cn(
              "h-full w-full",
              (compact || rightSideTab !== "browser") && "pointer-events-none invisible absolute"
            )}
          >
            <BrowserPanel
              workspaceId={workspace.id}
              panelVisible={!compact && rightSideTab === "browser"}
            />
          </div>

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
