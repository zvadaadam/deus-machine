/**
 * Main Content — layout orchestrator.
 *
 * Three layout modes:
 * 1. Normal:  ChatArea (flex-1) + RightSidePanel (380px + 56px sidecar)
 * 2. Code:    ChatArea (flex-1, min 300px) <resize> Viewer <resize> RightSidePanel (compact) + Sidecar
 * 3. Browser: ChatArea (flex-1) <resize> RightSidePanel (expanded, resizable)
 *
 * When the middle panel opens, sidebar auto-collapses on screens narrower
 * than 1680px and restores when it closes. ESC closes the middle panel.
 */

import { useState, useRef, useCallback, useMemo, useEffect } from "react";
import type { SessionPanelRef } from "@/features/session";
import { WelcomeView } from "@/features/repository";
import { useWorkspaceLayout, useResizeHandle, useFileChanges } from "@/features/workspace";
import { useArchiveWorkspace } from "@/features/workspace/api/workspace.queries";
import type { WorkspaceGitInfo } from "@/features/workspace";
import { DiffTabContent } from "@/features/workspace/ui/DiffTabContent";
import { WorkspaceHeader } from "@/features/workspace/ui/WorkspaceHeader";
import { FileViewer } from "@/features/file-browser";
import { SidebarInset, useSidebar } from "@/components/ui";
import { PanelLeft } from "lucide-react";
import { toast } from "sonner";
import { ResizeHandle } from "@/shared/components/ResizeHandle";
import type { Workspace, PRStatus } from "@/shared/types";
import { cn } from "@/shared/lib/utils";
import { emit } from "@/platform/tauri";
import { useBrowserWindowStore } from "@/features/browser/store";
import { ChatArea } from "./ChatArea";
import { RightSidePanel } from "./RightSidePanel";

/** Sidebar auto-collapses when opening middle panel on screens narrower than this */
const SIDEBAR_COLLAPSE_THRESHOLD = 1680;

/** Union type for the single active view in the middle panel */
type MiddlePanelView = { type: "diff"; filePath: string } | { type: "file"; filePath: string };
type ParkedMiddlePanel = {
  view: MiddlePanelView;
  middlePanelWidth: number | null;
  compactPanelWidth: number | null;
};

interface MainContentProps {
  selectedWorkspace: Workspace | null;
  prStatus: PRStatus | null;
  workspaceChatPanelRef: React.MutableRefObject<SessionPanelRef | null>;
  onCreateWorkspace: () => void;
  onOpenProject: () => void;
  onCloneRepository: () => void;
}

export function MainContent({
  selectedWorkspace,
  prStatus,
  workspaceChatPanelRef,
  onCreateWorkspace,
  onOpenProject,
  onCloneRepository,
}: MainContentProps) {
  const { open: sidebarOpen, setOpen: setSidebarOpen, toggleSidebar } = useSidebar();

  const selectedWorkspaceId = selectedWorkspace?.id ?? null;
  const {
    rightPanelWidth,
    setRightPanelWidth,
    rightSideTab,
    chatPanelCollapsed,
    setChatPanelCollapsed,
  } = useWorkspaceLayout(selectedWorkspaceId);

  // PR handler bridge: ChatArea sets it, RightSidePanel consumes it.
  // Setter must be called as `setCreatePRHandler(() => handler)` — passing a
  // function directly causes React to invoke it as a state updater (see bf516c6).
  const [createPRHandler, setCreatePRHandler] = useState<(() => void) | null>(null);

  // Target branch for PR creation/merge — synced from WorkspaceHeader's branch selector
  const [selectedTargetBranch, setSelectedTargetBranch] = useState<string>(
    selectedWorkspace?.default_branch ?? "main"
  );

  // Derived from store — no useState/callback delay on workspace load
  const isBrowserTab = rightSideTab === "browser";

  // --- Middle panel state (single active view) ---
  const [middlePanel, setMiddlePanel] = useState<MiddlePanelView | null>(null);
  const [middlePanelWidth, setMiddlePanelWidth] = useState<number | null>(null);
  const [compactPanelWidth, setCompactPanelWidth] = useState<number | null>(null);
  const [parkedMiddlePanel, setParkedMiddlePanel] = useState<ParkedMiddlePanel | null>(null);
  // Sidebar state saved before auto-collapse, restored on close
  const [sidebarBeforePanel, setSidebarBeforePanel] = useState<boolean | null>(null);

  // Reset state when workspace changes (React-recommended render-time pattern)
  const prevWorkspaceIdRef = useRef(selectedWorkspaceId);
  if (prevWorkspaceIdRef.current !== selectedWorkspaceId) {
    prevWorkspaceIdRef.current = selectedWorkspaceId;
    if (middlePanel !== null) setMiddlePanel(null);
    if (middlePanelWidth !== null) setMiddlePanelWidth(null);
    if (compactPanelWidth !== null) setCompactPanelWidth(null);
    if (parkedMiddlePanel !== null) setParkedMiddlePanel(null);
    if (sidebarBeforePanel !== null) setSidebarBeforePanel(null);
    setSelectedTargetBranch(selectedWorkspace?.default_branch ?? "main");
  }

  const middlePanelActive = middlePanel !== null;

  // Workspace git info for DiffTabContent
  const workspaceGitInfo: WorkspaceGitInfo | null = useMemo(
    () =>
      selectedWorkspace
        ? {
            root_path: selectedWorkspace.root_path,
            directory_name: selectedWorkspace.directory_name,
          }
        : null,
    [selectedWorkspace]
  );

  // File changes for prev/next navigation
  const { data: fileChangesData } = useFileChanges(
    selectedWorkspaceId,
    selectedWorkspace?.session_status,
    workspaceGitInfo ?? undefined
  );
  const fileChanges = useMemo(() => fileChangesData ?? [], [fileChangesData]);

  // --- Middle panel operations ---

  /** Collapse sidebar on narrow screens, saving state for restoration */
  const collapseSidebarForPanel = useCallback(() => {
    setSidebarBeforePanel((prev) => {
      if (prev === null) {
        if (window.innerWidth < SIDEBAR_COLLAPSE_THRESHOLD && sidebarOpen) {
          setSidebarOpen(false);
        }
        return sidebarOpen;
      }
      return prev;
    });
  }, [sidebarOpen, setSidebarOpen]);

  const handleOpenDiff = useCallback(
    (filePath: string) => {
      collapseSidebarForPanel();
      setParkedMiddlePanel(null);
      setMiddlePanel({ type: "diff", filePath });
    },
    [collapseSidebarForPanel]
  );

  const handleOpenFilePreview = useCallback(
    (filePath: string) => {
      collapseSidebarForPanel();
      setParkedMiddlePanel(null);
      setMiddlePanel({ type: "file", filePath });
    },
    [collapseSidebarForPanel]
  );

  const handleCloseMiddlePanel = useCallback(() => {
    setMiddlePanel(null);
    setMiddlePanelWidth(null);
    setCompactPanelWidth(null);
    setSidebarBeforePanel((prev) => {
      if (prev !== null) setSidebarOpen(prev);
      return null;
    });
  }, [setSidebarOpen]);

  const handleExitCompactMode = useCallback(() => {
    if (middlePanel) {
      setParkedMiddlePanel({
        view: middlePanel,
        middlePanelWidth,
        compactPanelWidth,
      });
    }
    handleCloseMiddlePanel();
  }, [middlePanel, middlePanelWidth, compactPanelWidth, handleCloseMiddlePanel]);

  const handleRestoreParkedMiddlePanel = useCallback(() => {
    if (!parkedMiddlePanel || middlePanel !== null) return;
    collapseSidebarForPanel();
    setMiddlePanel(parkedMiddlePanel.view);
    setMiddlePanelWidth(parkedMiddlePanel.middlePanelWidth);
    setCompactPanelWidth(parkedMiddlePanel.compactPanelWidth);
    setParkedMiddlePanel(null);
  }, [parkedMiddlePanel, middlePanel, collapseSidebarForPanel]);

  // --- Chat panel collapse/expand ---

  const handleCollapseChatPanel = useCallback(() => {
    setChatPanelCollapsed(true);
  }, [setChatPanelCollapsed]);

  const handleExpandChatPanel = useCallback(() => {
    setChatPanelCollapsed(false);
  }, [setChatPanelCollapsed]);

  // --- PR actions (used in WorkspaceHeader) ---

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

  const { mutate: archiveWorkspace } = useArchiveWorkspace();
  const handleArchive = useCallback(() => {
    if (!selectedWorkspace) return;
    archiveWorkspace(selectedWorkspace.id);
  }, [selectedWorkspace, archiveWorkspace]);

  // --- Prev/next file navigation for diff views ---

  const { onPrevFile, onNextFile, fileIndex, fileCount } = useMemo(() => {
    if (!middlePanel || middlePanel.type !== "diff" || fileChanges.length === 0) {
      return {
        onPrevFile: undefined,
        onNextFile: undefined,
        fileIndex: undefined,
        fileCount: undefined,
      };
    }

    const currentPath = middlePanel.filePath;
    const idx = fileChanges.findIndex((fc) => fc.file === currentPath);
    if (idx === -1) {
      return {
        onPrevFile: undefined,
        onNextFile: undefined,
        fileIndex: undefined,
        fileCount: undefined,
      };
    }

    return {
      fileIndex: idx,
      fileCount: fileChanges.length,
      onPrevFile:
        idx > 0
          ? () => setMiddlePanel({ type: "diff", filePath: fileChanges[idx - 1].file })
          : undefined,
      onNextFile:
        idx < fileChanges.length - 1
          ? () => setMiddlePanel({ type: "diff", filePath: fileChanges[idx + 1].file })
          : undefined,
    };
  }, [middlePanel, fileChanges]);

  // ESC closes the middle panel
  useEffect(() => {
    if (!middlePanelActive) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      const ae = document.activeElement as HTMLElement | null;
      if (
        ae &&
        (ae.tagName === "INPUT" ||
          ae.tagName === "TEXTAREA" ||
          ae.isContentEditable ||
          ae.getAttribute("role") === "textbox")
      )
        return;
      handleCloseMiddlePanel();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [middlePanelActive, handleCloseMiddlePanel]);

  // Cmd+\ toggles chat panel collapse/expand
  useEffect(() => {
    if (!selectedWorkspace) return;
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "\\") {
        e.preventDefault();
        if (chatPanelCollapsed) {
          handleExpandChatPanel();
        } else {
          handleCollapseChatPanel();
        }
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [selectedWorkspace, chatPanelCollapsed, handleExpandChatPanel, handleCollapseChatPanel]);

  // --- Sync workspace changes to detached browser window ---
  const isBrowserDetached = useBrowserWindowStore((s) => s.detachedWindowOpen);
  const detachedWorkspaceContext = useMemo(
    () =>
      selectedWorkspace
        ? {
            workspaceId: selectedWorkspace.id,
            directoryName: selectedWorkspace.directory_name,
            repoName: selectedWorkspace.repo_name,
            branch: selectedWorkspace.branch,
          }
        : null,
    [selectedWorkspace]
  );

  useEffect(() => {
    if (!isBrowserDetached || !detachedWorkspaceContext) return;

    void emit("browser-window:workspace-change", detachedWorkspaceContext);
  }, [isBrowserDetached, detachedWorkspaceContext]);

  // --- Resize handles ---

  // Middle panel mode: resize between chat and (viewer + compact right panel)
  // Snap-to-collapse: dragging chat below 300px collapses it
  const { handleProps: middlePanelResizeProps, isDragging: middlePanelDragging } = useResizeHandle({
    onSizeChange: setMiddlePanelWidth,
    enabled: middlePanelActive,
    direction: "horizontal",
    minSecondarySize: 436, // ~160px compact panel + 56px sidecar + ~220px min viewer
    minPrimarySize: 300, // min chat width
    onPrimaryCollapse: handleCollapseChatPanel,
    isPrimaryCollapsed: chatPanelCollapsed,
    onPrimaryExpand: handleExpandChatPanel,
  });

  // Compact panel resize: between viewer and compact right panel (file list + sidecar)
  const { handleProps: compactResizeProps, isDragging: compactDragging } = useResizeHandle({
    onSizeChange: setCompactPanelWidth,
    enabled: middlePanelActive,
    direction: "horizontal",
    minSecondarySize: 160, // min compact panel width
    minPrimarySize: 300, // min viewer width
  });

  // Right panel resize: drag between chat area and right side panel.
  // Supports bidirectional snap points: drag left to collapse, drag right to re-expand.
  const { handleProps: rightPanelResizeProps, isDragging: rightPanelDragging } = useResizeHandle({
    onSizeChange: setRightPanelWidth,
    enabled: !middlePanelActive,
    direction: "horizontal",
    minSecondarySize: 380,
    minPrimarySize: 200,
    onPrimaryCollapse: handleCollapseChatPanel,
    isPrimaryCollapsed: chatPanelCollapsed,
    onPrimaryExpand: handleExpandChatPanel,
  });

  const collapseStripResizeProps = middlePanelActive
    ? middlePanelResizeProps
    : rightPanelResizeProps;

  // --- Set smart default browser width on first activation ---
  // When browser tab opens for the first time (no saved width), compute ~60% of
  // the main content area. This gives the browser more room for rendering webpages
  // while keeping chat usable. The width is persisted so subsequent opens use the
  // user's last setting. Uses requestAnimationFrame to measure after layout and
  // set the width promptly, minimising a visible 50/50 flash.
  const mainContentRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (
      isBrowserTab &&
      !isBrowserDetached &&
      !middlePanelActive &&
      rightPanelWidth === null &&
      !chatPanelCollapsed
    ) {
      // Use rAF to measure after layout but set width quickly
      const id = requestAnimationFrame(() => {
        const container = mainContentRef.current;
        if (container) {
          const availableWidth = container.getBoundingClientRect().width;
          // 60% for browser, minimum 380px, leave at least 300px for chat
          const browserWidth = Math.max(380, Math.min(availableWidth * 0.6, availableWidth - 300));
          setRightPanelWidth(Math.round(browserWidth));
        }
      });
      return () => cancelAnimationFrame(id);
    }
  }, [
    isBrowserTab,
    isBrowserDetached,
    middlePanelActive,
    rightPanelWidth,
    setRightPanelWidth,
    chatPanelCollapsed,
  ]);

  // --- Computed styles ---

  // Right side panel explicit width — suppressed when chat collapsed, or when
  // browser is detached (fall back to fixed compact width in RightSidePanel).
  const rightSideStyle: React.CSSProperties | undefined =
    !middlePanelActive &&
    !chatPanelCollapsed &&
    !(isBrowserTab && isBrowserDetached) &&
    rightPanelWidth !== null
      ? { width: rightPanelWidth, flexShrink: 0 }
      : undefined;

  // Middle panel section style (viewer + compact right panel combined)
  // When chat collapsed, ignore stored width — fill all available space
  const middlePanelStyle: React.CSSProperties = chatPanelCollapsed
    ? { flex: "1 1 auto" }
    : middlePanelWidth !== null
      ? { width: middlePanelWidth, flexShrink: 0 }
      : { flex: "2 1 0%" };

  return (
    <SidebarInset className="min-w-0">
      <div
        data-slot="main-content"
        className="bg-bg-surface border-border-subtle flex h-full min-w-0 flex-1 overflow-hidden rounded-xl border"
      >
        {/* Sidebar toggle — visible when sidebar collapsed and no workspace */}
        {!sidebarOpen && !selectedWorkspace && (
          <button
            type="button"
            aria-label="Expand sidebar"
            onClick={toggleSidebar}
            className="text-muted-foreground/60 hover:text-foreground hover:bg-foreground/5 absolute top-3 left-3 z-10 flex h-7 w-7 items-center justify-center rounded-md transition-colors duration-200 ease-out"
          >
            <PanelLeft className="h-4 w-4" />
          </button>
        )}

        {selectedWorkspace ? (
          <div className="flex min-w-0 flex-1 flex-col">
            {/* Unified workspace header — spans full width above all panels */}
            <WorkspaceHeader
              repositoryName={selectedWorkspace.directory_name}
              branch={selectedWorkspace.branch}
              workspacePath={selectedWorkspace.workspace_path}
              workspaceId={selectedWorkspace.id}
              prStatus={prStatus}
              onCreatePR={createPRHandler ? handleCreatePR : undefined}
              onReviewPR={handleOpenPR}
              onArchive={handleArchive}
              targetBranch={selectedTargetBranch}
              onTargetBranchChange={setSelectedTargetBranch}
            />

            {/* Panels row */}
            <div ref={mainContentRef} className="flex min-h-0 min-w-0 flex-1">
              {/* Collapsed chat strip — thin affordance where chat was */}
              {chatPanelCollapsed && (
                <button
                  type="button"
                  aria-label="Expand chat"
                  onClick={handleExpandChatPanel}
                  onMouseDown={collapseStripResizeProps.onMouseDown}
                  onDoubleClick={collapseStripResizeProps.onDoubleClick}
                  className={cn(
                    "border-border-subtle flex h-full w-8 flex-shrink-0 cursor-col-resize items-center justify-center border-r",
                    "text-text-muted hover:text-text-secondary hover:bg-bg-overlay",
                    "transition-colors duration-200 ease-out",
                    "animate-[fadeIn_0.15s_0.15s_cubic-bezier(0,0,0.2,1)] [animation-fill-mode:backwards]"
                  )}
                >
                  <PanelLeft className="h-4 w-4" />
                </button>
              )}

              {/* Chat area — collapses to 0 width when chatPanelCollapsed */}
              <div
                className={cn(
                  "flex min-w-0 flex-col overflow-hidden",
                  "transition-[flex,opacity] ease-[cubic-bezier(.19,1,.22,1)]",
                  chatPanelCollapsed
                    ? "pointer-events-none flex-[0_0_0%] opacity-0 duration-200"
                    : "opacity-100 duration-[280ms]"
                )}
                style={
                  chatPanelCollapsed
                    ? undefined
                    : middlePanelActive
                      ? { flex: "1 1 0%", minWidth: 300 }
                      : { flex: "1 1 auto" }
                }
              >
                <ChatArea
                  workspace={selectedWorkspace}
                  workspaceChatPanelRef={workspaceChatPanelRef}
                  onCreatePRHandlerChange={setCreatePRHandler}
                  onCollapseChatPanel={handleCollapseChatPanel}
                />
              </div>

              {middlePanelActive && workspaceGitInfo ? (
                <>
                  {/* Middle panel resize handle — between chat and viewer section */}
                  {!chatPanelCollapsed && (
                    <ResizeHandle
                      handleProps={middlePanelResizeProps}
                      isDragging={middlePanelDragging}
                      label="Resize panels"
                    />
                  )}

                  {/* Middle panel section: viewer + compact right panel */}
                  <div
                    className="flex h-full min-w-0 animate-[fadeIn_0.2s_cubic-bezier(0,0,0.2,1)] flex-col overflow-hidden"
                    style={middlePanelStyle}
                  >
                    <div className="flex min-h-0 flex-1 overflow-hidden">
                      {/* Code viewer (diff or file preview) */}
                      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
                        {middlePanel.type === "diff" ? (
                          <DiffTabContent
                            workspaceId={selectedWorkspace.id}
                            filePath={middlePanel.filePath}
                            workspaceGitInfo={workspaceGitInfo}
                            onClose={handleCloseMiddlePanel}
                            onPrevFile={onPrevFile}
                            onNextFile={onNextFile}
                            fileIndex={fileIndex}
                            fileCount={fileCount}
                          />
                        ) : (
                          <FileViewer
                            filePath={middlePanel.filePath}
                            onClose={handleCloseMiddlePanel}
                          />
                        )}
                      </div>

                      {/* Compact panel resize handle — between viewer and file list */}
                      <ResizeHandle
                        handleProps={compactResizeProps}
                        isDragging={compactDragging}
                        label="Resize file list"
                      />

                      {/* Compact right panel (file list + sidecar) */}
                      <RightSidePanel
                        workspace={selectedWorkspace}
                        rightPanelWidth={null}
                        rightSideStyle={undefined}
                        onOpenDiffTab={handleOpenDiff}
                        onOpenFilePreview={handleOpenFilePreview}
                        compact
                        compactWidth={compactPanelWidth}
                        chatPanelCollapsed={chatPanelCollapsed}
                        onExitCompactMode={handleExitCompactMode}
                        onReturnToCode={handleRestoreParkedMiddlePanel}
                      />
                    </div>
                  </div>
                </>
              ) : (
                <>
                  {/* Right panel resize handle — suppressed when chat collapsed */}
                  {!chatPanelCollapsed && (
                    <ResizeHandle
                      handleProps={rightPanelResizeProps}
                      isDragging={rightPanelDragging}
                      label="Resize panels"
                    />
                  )}

                  {/* Normal right panel — when chat collapsed, skip stored width so flex-1 fills */}
                  <RightSidePanel
                    workspace={selectedWorkspace}
                    rightPanelWidth={chatPanelCollapsed ? null : rightPanelWidth}
                    rightSideStyle={rightSideStyle}
                    onOpenDiffTab={handleOpenDiff}
                    onOpenFilePreview={handleOpenFilePreview}
                    isResizing={rightPanelDragging}
                    chatPanelCollapsed={chatPanelCollapsed}
                    onReturnToCode={handleRestoreParkedMiddlePanel}
                  />
                </>
              )}
            </div>
          </div>
        ) : (
          <div ref={mainContentRef} className="flex min-w-0 flex-1">
            <WelcomeView
              onCreateWorkspace={onCreateWorkspace}
              onOpenProject={onOpenProject}
              onCloneRepository={onCloneRepository}
            />
          </div>
        )}
      </div>
    </SidebarInset>
  );
}
