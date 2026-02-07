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
import type { WorkspaceGitInfo } from "@/features/workspace";
import { DiffTabContent } from "@/features/workspace/ui/DiffTabContent";
import { PRStatusBar } from "@/features/workspace/ui/PRStatusBar";
import { FileViewer } from "@/features/file-browser";
import { SidebarInset, useSidebar } from "@/components/ui";
import { PanelLeft } from "lucide-react";
import { toast } from "sonner";
import { ResizeHandle } from "@/shared/components/ResizeHandle";
import type { Workspace, PRStatus } from "@/shared/types";
import { ChatArea } from "./ChatArea";
import { RightSidePanel } from "./RightSidePanel";

/** Sidebar auto-collapses when opening middle panel on screens narrower than this */
const SIDEBAR_COLLAPSE_THRESHOLD = 1680;

/** Union type for the single active view in the middle panel */
type MiddlePanelView = { type: "diff"; filePath: string } | { type: "file"; filePath: string };

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
  const { rightPanelWidth, setRightPanelWidth } = useWorkspaceLayout(selectedWorkspaceId);

  // PR handler bridge: ChatArea sets it, RightSidePanel consumes it.
  // Setter must be called as `setCreatePRHandler(() => handler)` — passing a
  // function directly causes React to invoke it as a state updater (see bf516c6).
  const [createPRHandler, setCreatePRHandler] = useState<(() => void) | null>(null);

  // Right side expansion state (browser tab only)
  const [rightSideExpanded, setRightSideExpanded] = useState(false);

  // --- Middle panel state (single active view) ---
  const [middlePanel, setMiddlePanel] = useState<MiddlePanelView | null>(null);
  const [middlePanelWidth, setMiddlePanelWidth] = useState<number | null>(null);
  const [compactPanelWidth, setCompactPanelWidth] = useState<number | null>(null);
  // Sidebar state saved before auto-collapse, restored on close
  const [sidebarBeforePanel, setSidebarBeforePanel] = useState<boolean | null>(null);

  // Reset state when workspace changes (React-recommended render-time pattern)
  const prevWorkspaceIdRef = useRef(selectedWorkspaceId);
  if (prevWorkspaceIdRef.current !== selectedWorkspaceId) {
    prevWorkspaceIdRef.current = selectedWorkspaceId;
    if (middlePanel !== null) setMiddlePanel(null);
    if (middlePanelWidth !== null) setMiddlePanelWidth(null);
    if (compactPanelWidth !== null) setCompactPanelWidth(null);
    if (sidebarBeforePanel !== null) setSidebarBeforePanel(null);
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
      setMiddlePanel({ type: "diff", filePath });
    },
    [collapseSidebarForPanel]
  );

  const handleOpenFilePreview = useCallback(
    (filePath: string) => {
      collapseSidebarForPanel();
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

  // --- PR actions for the aligned PRStatusBar above the middle panel ---

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

  // --- Resize handles ---

  // Middle panel mode: resize between chat and (viewer + compact right panel)
  const { handleProps: middlePanelResizeProps, isDragging: middlePanelDragging } = useResizeHandle({
    onSizeChange: setMiddlePanelWidth,
    enabled: middlePanelActive,
    direction: "horizontal",
    minSecondarySize: 436, // ~160px compact panel + 56px sidecar + ~220px min viewer
    minPrimarySize: 300, // min chat width
  });

  // Compact panel resize: between viewer and compact right panel (file list + sidecar)
  const { handleProps: compactResizeProps, isDragging: compactDragging } = useResizeHandle({
    onSizeChange: setCompactPanelWidth,
    enabled: middlePanelActive,
    direction: "horizontal",
    minSecondarySize: 160, // min compact panel width
    minPrimarySize: 300, // min viewer width
  });

  // Browser mode: resize between chat area and expanded right panel
  const { handleProps: browserResizeProps, isDragging: browserDragging } = useResizeHandle({
    onSizeChange: setRightPanelWidth,
    enabled: rightSideExpanded && !middlePanelActive,
    direction: "horizontal",
    minSecondarySize: 380,
    minPrimarySize: 200,
  });

  // --- Computed styles ---

  // Browser mode right side style (no middle panel)
  const browserRightSideStyle: React.CSSProperties | undefined =
    rightSideExpanded && !middlePanelActive && rightPanelWidth !== null
      ? { width: rightPanelWidth, flexShrink: 0 }
      : undefined;

  // Middle panel section style (viewer + compact right panel combined)
  const middlePanelStyle: React.CSSProperties =
    middlePanelWidth !== null ? { width: middlePanelWidth, flexShrink: 0 } : { flex: "2 1 0%" };

  return (
    <SidebarInset className="min-w-0">
      <div
        data-slot="main-content"
        className="bg-background border-border/5 flex h-full min-w-0 flex-1 overflow-hidden rounded-lg border"
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

        <div className="flex min-w-0 flex-1">
          {selectedWorkspace ? (
            <>
              {/* Chat area — always visible, shrinks when middle panel is active */}
              <div
                className="flex min-w-0 flex-col overflow-hidden"
                style={middlePanelActive ? { flex: "1 1 0%", minWidth: 300 } : { flex: "1 1 auto" }}
              >
                <ChatArea
                  workspace={selectedWorkspace}
                  workspaceChatPanelRef={workspaceChatPanelRef}
                  onCreatePRHandlerChange={setCreatePRHandler}
                />
              </div>

              {middlePanelActive && workspaceGitInfo ? (
                <>
                  {/* Middle panel resize handle — between chat and viewer section */}
                  <ResizeHandle
                    handleProps={middlePanelResizeProps}
                    isDragging={middlePanelDragging}
                    label="Resize panels"
                  />

                  {/* Middle panel section: PRStatusBar + (viewer | compact right panel) */}
                  <div
                    className="flex h-full min-w-0 animate-[fadeIn_0.2s_cubic-bezier(0,0,0.2,1)] flex-col overflow-hidden"
                    style={middlePanelStyle}
                  >
                    {/* PRStatusBar — aligned with chat header row 1 */}
                    <PRStatusBar
                      prStatus={prStatus}
                      onCreatePR={createPRHandler ? handleCreatePR : undefined}
                      onReviewPR={handleOpenPR}
                      compact
                    />

                    {/* Horizontal content: viewer + compact right panel */}
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

                      {/* Compact right panel (file list + sidecar, PRStatusBar hidden) */}
                      <RightSidePanel
                        workspace={selectedWorkspace}
                        prStatus={prStatus}
                        createPRHandler={createPRHandler}
                        onExpandedChange={setRightSideExpanded}
                        rightPanelWidth={null}
                        rightSideStyle={undefined}
                        onOpenDiffTab={handleOpenDiff}
                        onOpenFilePreview={handleOpenFilePreview}
                        compact
                        compactWidth={compactPanelWidth}
                        hidePRStatus
                      />
                    </div>
                  </div>
                </>
              ) : (
                <>
                  {/* Browser resize handle — enabled when browser tab expands */}
                  {rightSideExpanded && (
                    <ResizeHandle
                      handleProps={browserResizeProps}
                      isDragging={browserDragging}
                      label="Resize panels"
                    />
                  )}

                  {/* Normal right panel */}
                  <RightSidePanel
                    workspace={selectedWorkspace}
                    prStatus={prStatus}
                    createPRHandler={createPRHandler}
                    onExpandedChange={setRightSideExpanded}
                    rightPanelWidth={rightPanelWidth}
                    rightSideStyle={browserRightSideStyle}
                    onOpenDiffTab={handleOpenDiff}
                    onOpenFilePreview={handleOpenFilePreview}
                  />
                </>
              )}
            </>
          ) : (
            <WelcomeView
              onCreateWorkspace={onCreateWorkspace}
              onOpenProject={onOpenProject}
              onCloneRepository={onCloneRepository}
            />
          )}
        </div>
      </div>
    </SidebarInset>
  );
}
