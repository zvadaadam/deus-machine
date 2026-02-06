/**
 * Main Content — layout orchestrator.
 *
 * Three layout modes:
 * 1. Normal:  ChatArea (flex-1) + RightSidePanel (380px + 56px sidecar)
 * 2. Diff:    ChatArea (flex-1, min 300px) <resize> DiffViewer + RightSidePanel (compact 200px)
 * 3. Browser: ChatArea (flex-1) <resize> RightSidePanel (expanded, resizable)
 *
 * When diff opens, sidebar auto-collapses on narrow screens (<1400px)
 * and restores when diff closes. ESC closes the diff panel.
 */

import { useState, useRef, useCallback, useMemo, useEffect } from "react";
import type { SessionPanelRef } from "@/features/session";
import { WelcomeView } from "@/features/repository";
import { useWorkspaceLayout, useResizeHandle } from "@/features/workspace";
import type { WorkspaceGitInfo } from "@/features/workspace";
import { DiffTabContent } from "@/features/workspace/ui/DiffTabContent";
import { SidebarInset, useSidebar } from "@/components/ui";
import { PanelLeft } from "lucide-react";
import { cn } from "@/shared/lib/utils";
import { SCREEN_WIDTH_THRESHOLD } from "@/shared/stores/layoutCoordinationStore";
import type { Workspace, PRStatus } from "@/shared/types";
import { ChatArea } from "./ChatArea";
import type { ChatAreaRef } from "./ChatArea";
import { RightSidePanel } from "./RightSidePanel";

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

  // PR handler bridge: ChatArea sets it, RightSidePanel consumes it
  const [createPRHandler, setCreatePRHandler] = useState<(() => void) | null>(null);

  // Right side expansion state (browser tab only)
  const [rightSideExpanded, setRightSideExpanded] = useState(false);

  // Diff state — file path drives the diff panel visibility
  const [activeDiffFilePath, setActiveDiffFilePath] = useState<string | null>(null);
  const [diffSectionWidth, setDiffSectionWidth] = useState<number | null>(null);
  // Sidebar state saved before diff auto-collapse, restored on close
  const [sidebarBeforeDiff, setSidebarBeforeDiff] = useState<boolean | null>(null);

  // ChatArea ref — for opening file tabs from RightSidePanel
  const chatAreaRef = useRef<ChatAreaRef>(null);

  // Reset diff state when workspace changes (React-recommended render-time pattern)
  const prevWorkspaceIdRef = useRef(selectedWorkspaceId);
  if (prevWorkspaceIdRef.current !== selectedWorkspaceId) {
    prevWorkspaceIdRef.current = selectedWorkspaceId;
    if (activeDiffFilePath !== null) setActiveDiffFilePath(null);
    if (diffSectionWidth !== null) setDiffSectionWidth(null);
    if (sidebarBeforeDiff !== null) setSidebarBeforeDiff(null);
  }

  const diffActive = !!activeDiffFilePath;

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

  // --- Diff handlers ---

  const handleOpenDiff = useCallback(
    (filePath: string) => {
      // Save sidebar state once (first diff open in this session)
      setSidebarBeforeDiff((prev) => {
        if (prev === null) {
          // Auto-collapse sidebar on narrow screens
          if (window.innerWidth < SCREEN_WIDTH_THRESHOLD && sidebarOpen) {
            setSidebarOpen(false);
          }
          return sidebarOpen;
        }
        return prev;
      });
      setActiveDiffFilePath(filePath);
    },
    [sidebarOpen, setSidebarOpen]
  );

  const handleCloseDiff = useCallback(() => {
    setActiveDiffFilePath(null);
    setDiffSectionWidth(null);
    // Restore sidebar to pre-diff state
    setSidebarBeforeDiff((prev) => {
      if (prev !== null) {
        setSidebarOpen(prev);
      }
      return null;
    });
  }, [setSidebarOpen]);

  // ESC closes the diff panel
  useEffect(() => {
    if (!activeDiffFilePath) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // Don't close if user is in a text field
      const ae = document.activeElement as HTMLElement | null;
      if (
        ae &&
        (ae.tagName === "INPUT" ||
          ae.tagName === "TEXTAREA" ||
          ae.isContentEditable ||
          ae.getAttribute("role") === "textbox")
      )
        return;
      handleCloseDiff();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [activeDiffFilePath, handleCloseDiff]);

  // --- Resize handles ---

  // Diff mode: resize between chat and (diff + compact right panel)
  const { handleProps: diffResizeProps, isDragging: diffDragging } = useResizeHandle({
    onSizeChange: setDiffSectionWidth,
    enabled: diffActive,
    direction: "horizontal",
    minSecondarySize: 460, // ~200px compact panel + 56px sidecar + ~200px min diff
    minPrimarySize: 300, // min chat width
  });

  // Browser mode: resize between chat area and expanded right panel
  const { handleProps: browserResizeProps, isDragging: browserDragging } = useResizeHandle({
    onSizeChange: setRightPanelWidth,
    enabled: rightSideExpanded && !diffActive,
    direction: "horizontal",
    minSecondarySize: 380,
    minPrimarySize: 200,
  });

  // --- Computed styles ---

  // Browser mode right side style (no diff)
  const browserRightSideStyle: React.CSSProperties | undefined =
    rightSideExpanded && !diffActive && rightPanelWidth !== null
      ? { width: rightPanelWidth, flexShrink: 0 }
      : undefined;

  // Diff section style (diff viewer + compact right panel combined)
  const diffSectionStyle: React.CSSProperties =
    diffSectionWidth !== null ? { width: diffSectionWidth, flexShrink: 0 } : { flex: "2 1 0%" };

  return (
    <SidebarInset className="min-w-0">
      <div
        data-slot="main-content"
        className="bg-background border-border/5 flex h-full min-w-0 flex-1 overflow-hidden rounded-lg border"
      >
        {/* Sidebar toggle — visible when sidebar collapsed and no workspace tab bar */}
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
              {/* Chat area — always visible, shrinks when diff is active */}
              <div
                className="flex min-w-0 flex-col overflow-hidden"
                style={diffActive ? { flex: "1 1 0%", minWidth: 300 } : { flex: "1 1 auto" }}
              >
                <ChatArea
                  ref={chatAreaRef}
                  workspace={selectedWorkspace}
                  workspaceChatPanelRef={workspaceChatPanelRef}
                  onCreatePRHandlerChange={setCreatePRHandler}
                />
              </div>

              {diffActive && workspaceGitInfo ? (
                <>
                  {/* Diff resize handle — between chat and diff section */}
                  <div
                    {...diffResizeProps}
                    className="group relative z-10 flex w-0 flex-shrink-0 cursor-col-resize items-center justify-center"
                    aria-label="Resize panels"
                    role="separator"
                    aria-orientation="vertical"
                  >
                    <div className="absolute inset-y-0 w-3 -translate-x-1/2" />
                    <div
                      className={cn(
                        "absolute inset-y-0 w-[3px] -translate-x-1/2 rounded-full transition-opacity duration-200 ease-[ease]",
                        diffDragging
                          ? "bg-primary/40 opacity-100"
                          : "bg-border opacity-0 group-hover:opacity-100"
                      )}
                    />
                  </div>

                  {/* Diff section: viewer + compact right panel */}
                  <div className="flex h-full min-w-0 overflow-hidden" style={diffSectionStyle}>
                    {/* Diff viewer — takes remaining space */}
                    <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
                      <DiffTabContent
                        workspaceId={selectedWorkspace.id}
                        filePath={activeDiffFilePath}
                        workspaceGitInfo={workspaceGitInfo}
                        onClose={handleCloseDiff}
                      />
                    </div>

                    {/* Compact right panel */}
                    <RightSidePanel
                      workspace={selectedWorkspace}
                      prStatus={prStatus}
                      createPRHandler={createPRHandler}
                      onExpandedChange={setRightSideExpanded}
                      rightPanelWidth={null}
                      rightSideStyle={undefined}
                      onOpenDiffTab={handleOpenDiff}
                      onOpenFileTab={(path) => chatAreaRef.current?.openFileTab(path)}
                      compact
                    />
                  </div>
                </>
              ) : (
                <>
                  {/* Browser resize handle — enabled when browser tab expands */}
                  {rightSideExpanded && (
                    <div
                      {...browserResizeProps}
                      className="group relative z-10 flex w-0 flex-shrink-0 cursor-col-resize items-center justify-center"
                      aria-label="Resize panels"
                      role="separator"
                      aria-orientation="vertical"
                    >
                      <div className="absolute inset-y-0 w-3 -translate-x-1/2" />
                      <div
                        className={cn(
                          "absolute inset-y-0 w-[3px] -translate-x-1/2 rounded-full transition-opacity duration-200 ease-[ease]",
                          browserDragging
                            ? "bg-primary/40 opacity-100"
                            : "bg-border opacity-0 group-hover:opacity-100"
                        )}
                      />
                    </div>
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
                    onOpenFileTab={(path) => chatAreaRef.current?.openFileTab(path)}
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
