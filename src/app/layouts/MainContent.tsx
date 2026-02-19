/**
 * Main Content — layout orchestrator.
 *
 * Three layout modes:
 * 1. Normal:  ChatArea (flex) + RightSidePanel (resizable)
 * 2. Code:    ChatArea (flex) <resize> Viewer <resize> RightSidePanel (compact) + Sidecar
 * 3. Browser: ChatArea (flex) <resize> RightSidePanel (expanded, resizable)
 *
 * The RightSidecar (58px icon strip) lives OUTSIDE the ResizablePanelGroup
 * so it's always visible — even when the content panel collapses to 0.
 * This follows the VS Code activity bar pattern: click icon to toggle,
 * click active icon to collapse.
 *
 * Panel resizing uses react-resizable-panels for keyboard accessibility,
 * touch support, and built-in collapse/expand with snap behavior.
 *
 * When the middle panel opens, sidebar auto-collapses on screens narrower
 * than 1680px and restores when it closes. ESC closes the middle panel.
 */

import { useState, useRef, useCallback, useMemo, useEffect } from "react";
import type { ImperativePanelHandle } from "react-resizable-panels";
import type { SessionPanelRef } from "@/features/session";
import { WelcomeView } from "@/features/repository";
import { useWorkspaceLayout, useFileChanges } from "@/features/workspace";
import { useCollapsedSizePercent } from "@/features/workspace/hooks/useCollapsedSizePercent";
import { useRightPanelSizing } from "@/features/workspace/hooks/useRightPanelSizing";
import { useArchiveWorkspace } from "@/features/workspace/api/workspace.queries";
import type { WorkspaceGitInfo } from "@/features/workspace";
import type { RightSideTab } from "@/features/workspace/store";
import { useFileWatcher } from "@/features/file-browser/hooks/useFileWatcher";
import { DiffTabContent } from "@/features/workspace/ui/DiffTabContent";
import { WorkspaceHeader } from "@/features/workspace/ui/WorkspaceHeader";
import { RightSidecar } from "@/features/workspace/ui/RightSidecar";
import { FileViewer } from "@/features/file-browser";
import { SidebarInset, useSidebar } from "@/components/ui";
import { cn } from "@/shared/lib/utils";
import { ResizablePanelGroup, ResizablePanel, ResizableHandle } from "@/components/ui/resizable";
import { PanelLeft } from "lucide-react";
import { toast } from "sonner";
import type { Workspace, PRStatus, GhCliStatus } from "@/shared/types";
import { emit } from "@/platform/tauri";
import { useBrowserWindowStore } from "@/features/browser/store";
import { ChatArea } from "./ChatArea";
import { RightSidePanel } from "./RightSidePanel";
import { CollapsedChatStrip, CollapsedContentStrip } from "./CollapsedPanelStrips";

/** Sidebar auto-collapses when opening middle panel on screens narrower than this */
const SIDEBAR_COLLAPSE_THRESHOLD = 1680;

/** Union type for the single active view in the middle panel */
type MiddlePanelView = { type: "diff"; filePath: string } | { type: "file"; filePath: string };
type ParkedMiddlePanel = { view: MiddlePanelView };

interface MainContentProps {
  selectedWorkspace: Workspace | null;
  prStatus: PRStatus | null;
  ghStatus?: GhCliStatus | null;
  workspaceChatPanelRef: React.MutableRefObject<SessionPanelRef | null>;
  onCreateWorkspace: () => void;
  onOpenProject: () => void;
  onCloneRepository: () => void;
}

export function MainContent({
  selectedWorkspace,
  prStatus,
  ghStatus,
  workspaceChatPanelRef,
  onCreateWorkspace,
  onOpenProject,
  onCloneRepository,
}: MainContentProps) {
  const { open: sidebarOpen, setOpen: setSidebarOpen, toggleSidebar } = useSidebar();

  const selectedWorkspaceId = selectedWorkspace?.id ?? null;
  const {
    rightSideTab,
    setRightSideTab,
    chatPanelCollapsed,
    setChatPanelCollapsed,
    rightPanelCollapsed,
    setRightPanelCollapsed,
  } = useWorkspaceLayout(selectedWorkspaceId);

  // PR handler bridge: ChatArea sets it, WorkspaceHeader consumes it.
  // Setter must be called as `setXxxHandler(() => handler)` — passing a
  // function directly causes React to invoke it as a state updater (see bf516c6).
  const [createPRHandler, setCreatePRHandler] = useState<(() => void) | null>(null);
  const [sendAgentMessageHandler, setSendAgentMessageHandler] = useState<
    ((text: string) => Promise<void>) | null
  >(null);

  // Target branch for PR creation/merge — synced from WorkspaceHeader's branch selector
  const [selectedTargetBranch, setSelectedTargetBranch] = useState<string>(
    selectedWorkspace?.default_branch ?? "main"
  );

  // Derived from store — no useState/callback delay on workspace load
  const isBrowserTab = rightSideTab === "browser";
  const isBrowserDetached = useBrowserWindowStore((s) => s.detachedWindowOpen);

  // --- Middle panel state (single active view) ---
  const [middlePanel, setMiddlePanel] = useState<MiddlePanelView | null>(null);
  const [parkedMiddlePanel, setParkedMiddlePanel] = useState<ParkedMiddlePanel | null>(null);
  // Sidebar state saved before auto-collapse, restored on close
  const [sidebarBeforePanel, setSidebarBeforePanel] = useState<boolean | null>(null);

  // Reset state when workspace changes (React-recommended render-time pattern).
  // Capture flag so we can also reset the sizing hook's ref after it's created.
  const prevWorkspaceIdRef = useRef(selectedWorkspaceId);
  const workspaceChanged = prevWorkspaceIdRef.current !== selectedWorkspaceId;
  if (workspaceChanged) {
    prevWorkspaceIdRef.current = selectedWorkspaceId;
    if (middlePanel !== null) setMiddlePanel(null);
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

  // Only start watching and querying diffs once the worktree checkout is complete.
  // During "initializing", git is writing thousands of files — starting the watcher
  // here would flood the system with events, triggering expensive scans + re-renders.
  const isReady = selectedWorkspace?.state === "ready";

  // Watch workspace for file changes (event-driven cache invalidation)
  const isWatched = useFileWatcher(
    isReady ? selectedWorkspace?.workspace_path ?? null : null,
    isReady ? selectedWorkspaceId : null,
  );

  // File changes for prev/next navigation — polling disabled when file watcher is active
  const { data: fileChangesData } = useFileChanges(
    isReady ? selectedWorkspaceId : null,
    selectedWorkspace?.session_status,
    workspaceGitInfo ?? undefined,
    isWatched
  );
  const fileChanges = useMemo(() => fileChangesData?.files ?? [], [fileChangesData]);

  // --- Refs for imperative panel control ---
  const chatPanelRef = useRef<ImperativePanelHandle>(null);
  const rightPanelRef = useRef<ImperativePanelHandle>(null);
  // Wraps only the ResizablePanelGroup (excludes 58px sidecar) for correct pixel↔percent math
  const panelGroupContainerRef = useRef<HTMLDivElement>(null);

  // Dynamic collapsed size: 36px strip → percentage of container width.
  // Library supports dynamic updates — ResizeObserver keeps it accurate.
  const MIN_PANEL_SIZE = 15;
  const collapsedSizePct = useCollapsedSizePercent(panelGroupContainerRef, 36);
  const safeCollapsedSize = Math.min(collapsedSizePct, MIN_PANEL_SIZE - 0.1);

  // Per-tab sizing: normal tabs (30%) vs browser (60%), stored width restoration,
  // and resize persistence. resizeToTab handles expand-from-collapsed + category
  // boundary transitions. isCategoryBoundary detects when resize is needed.
  const { resizeToTab, isCategoryBoundary, handleResize, hasRestoredWidthRef } =
    useRightPanelSizing({
      workspaceId: selectedWorkspaceId,
      panelGroupContainerRef,
      rightPanelRef,
      isBrowserDetached,
      middlePanelActive,
    });

  // Deferred reset: hasRestoredWidthRef comes from the hook above, but needs
  // resetting on workspace change (detected earlier in the render pass).
  if (workspaceChanged) {
    // eslint-disable-next-line react-hooks/refs -- intentional: reset on workspace change during render
    hasRestoredWidthRef.current = false;
  }

  // Smart default: browser gets 60%, everything else gets 30%.
  // Stored widths are restored after mount via the hook's useLayoutEffect.
  const rightPanelDefaultSize = isBrowserTab && !isBrowserDetached ? 60 : 30;

  // Session status for breathing indicator on collapsed chat strip
  const sessionStatus = selectedWorkspace?.session_status;
  const isSessionWorking = sessionStatus === "working";

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
    setSidebarBeforePanel((prev) => {
      if (prev !== null) setSidebarOpen(prev);
      return null;
    });
  }, [setSidebarOpen]);

  const handleExitCompactMode = useCallback(() => {
    if (middlePanel) {
      setParkedMiddlePanel({ view: middlePanel });
    }
    handleCloseMiddlePanel();
  }, [middlePanel, handleCloseMiddlePanel]);

  const handleRestoreParkedMiddlePanel = useCallback(() => {
    if (!parkedMiddlePanel || middlePanel !== null) return;
    collapseSidebarForPanel();
    setMiddlePanel(parkedMiddlePanel.view);
    setParkedMiddlePanel(null);
  }, [parkedMiddlePanel, middlePanel, collapseSidebarForPanel]);

  // --- Chat panel collapse/expand ---
  // handleCollapseChatPanel is used both as the ResizablePanel onCollapse callback
  // (when user drags to minimum) AND as the button click handler from the chat
  // tab bar. When called from the button, we must also imperatively collapse
  // the panel — setting the store flag alone doesn't physically resize it.

  const handleCollapseChatPanel = useCallback(() => {
    setChatPanelCollapsed(true);
    chatPanelRef.current?.collapse();
  }, [setChatPanelCollapsed]);

  const handleExpandChatPanel = useCallback(() => {
    setChatPanelCollapsed(false);
  }, [setChatPanelCollapsed]);

  // --- Right panel collapse/expand ---

  const handleCollapseRightPanel = useCallback(() => {
    setRightPanelCollapsed(true);
  }, [setRightPanelCollapsed]);

  const handleExpandRightPanel = useCallback(() => {
    setRightPanelCollapsed(false);
  }, [setRightPanelCollapsed]);

  // --- Sidecar tab change (VS Code activity bar pattern) ---
  // All toggle logic lives here so the sidecar component stays pure.
  const handleSidecarTabChange = useCallback(
    (tab: RightSideTab) => {
      if (middlePanelActive) {
        // Compact mode: clicking Code restores parked diff, other tabs park diff + switch
        if (tab === "code") {
          setRightSideTab(tab);
          handleRestoreParkedMiddlePanel();
        } else {
          setRightSideTab(tab);
          handleExitCompactMode();
        }
        return;
      }

      if (rightPanelCollapsed) {
        // Content is collapsed — just switch the strip label/icon, don't expand.
        // The strip click is the expand action; sidecar tabs pre-select content.
        setRightSideTab(tab);
        // Restore parked diff even while collapsed — the middle panel layout
        // is a separate ResizablePanelGroup, so collapse state is irrelevant.
        if (tab === "code") {
          handleRestoreParkedMiddlePanel();
        }
      } else if (tab === rightSideTab) {
        // Clicked the already-active tab — collapse content
        rightPanelRef.current?.collapse();
      } else {
        // Switch to a different tab (content stays expanded).
        // If crossing a size category boundary (normal <-> browser),
        // resize to the new tab's target width.
        setRightSideTab(tab);
        if (isCategoryBoundary(rightSideTab, tab)) {
          resizeToTab(tab);
        }
        // Returning to code tab — restore parked diff if one was saved.
        // The diff gets parked when leaving compact mode (code → browser/terminal).
        // Without this, the user loses their open diff viewer on round-trip.
        if (tab === "code") {
          handleRestoreParkedMiddlePanel();
        }
      }
    },
    [
      middlePanelActive,
      rightPanelCollapsed,
      rightSideTab,
      setRightSideTab,
      handleRestoreParkedMiddlePanel,
      handleExitCompactMode,
      isCategoryBoundary,
      resizeToTab,
    ]
  );

  // --- PR actions (used in WorkspaceHeader) ---

  const handleCreatePR = useCallback(() => {
    if (!createPRHandler) {
      toast.error("No active session available to create a PR.");
      return;
    }
    createPRHandler();
  }, [createPRHandler]);

  const handleSendAgentMessage = useCallback(
    (text: string) => {
      if (!sendAgentMessageHandler) {
        toast.error("No active session available.");
        return;
      }
      sendAgentMessageHandler(text);
    },
    [sendAgentMessageHandler]
  );

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

  // Cmd+\ toggles chat panel, Cmd+] toggles right panel
  useEffect(() => {
    if (!selectedWorkspace) return;
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "\\") {
        e.preventDefault();
        if (chatPanelCollapsed) {
          chatPanelRef.current?.expand();
        } else {
          chatPanelRef.current?.collapse();
        }
      }
      if ((e.metaKey || e.ctrlKey) && e.key === "]") {
        e.preventDefault();
        if (rightPanelCollapsed) {
          resizeToTab(rightSideTab);
        } else {
          rightPanelRef.current?.collapse();
        }
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [selectedWorkspace, chatPanelCollapsed, rightPanelCollapsed, rightSideTab, resizeToTab]);

  // --- Sync workspace changes to detached browser window ---
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

  return (
    <SidebarInset className="min-w-0">
      <div
        data-slot="main-content"
        className={cn(
          "bg-bg-surface flex h-full min-w-0 flex-1 overflow-hidden border transition-[border-radius,border-color] duration-[280ms] ease-[cubic-bezier(.19,1,.22,1)]",
          sidebarOpen ? "border-border-subtle rounded-l-xl border-r-0" : "border-transparent rounded-none",
        )}
      >
        {/* Sidebar toggle — visible when sidebar collapsed and no workspace */}
        {!sidebarOpen && !selectedWorkspace && (
          <button
            type="button"
            data-slot="welcome-sidebar-toggle"
            aria-label="Expand sidebar"
            onClick={toggleSidebar}
            className="text-muted-foreground/60 hover:text-foreground hover:bg-foreground/5 absolute top-3 left-3 z-10 flex h-7 w-7 items-center justify-center rounded-md transition-[transform,color,background-color] duration-200 ease-out"
          >
            <PanelLeft className="h-4 w-4" />
          </button>
        )}

        {selectedWorkspace ? (
          <div className="flex min-w-0 flex-1 flex-col">
            {/* Unified workspace header — spans full width above all panels */}
            <WorkspaceHeader
              repositoryName={selectedWorkspace.directory_name}
              branch={selectedWorkspace.branch ?? undefined}
              workspacePath={selectedWorkspace.workspace_path}
              workspaceId={selectedWorkspace.id}
              prStatus={prStatus}
              ghStatus={ghStatus}
              onCreatePR={createPRHandler ? handleCreatePR : undefined}
              onSendAgentMessage={sendAgentMessageHandler ? handleSendAgentMessage : undefined}
              onReviewPR={handleOpenPR}
              onArchive={handleArchive}
              targetBranch={selectedTargetBranch}
              onTargetBranchChange={setSelectedTargetBranch}
            />

            {/* Panels row: [ResizablePanelGroup] [Sidecar 58px] */}
            <div className="flex min-h-0 min-w-0 flex-1">
              {/* Panel group container — excludes sidecar for correct pixel↔percent math */}
              <div ref={panelGroupContainerRef} className="h-full min-w-0 flex-1">
                {middlePanelActive && workspaceGitInfo ? (
                  // --- Middle panel mode: Chat | Viewer | CompactPanel ---
                  <ResizablePanelGroup direction="horizontal" key={`${selectedWorkspaceId}-middle`}>
                    {/* Chat panel (collapsible) — collapses to 36px strip, not 0 */}
                    <ResizablePanel
                      ref={chatPanelRef}
                      collapsible
                      collapsedSize={safeCollapsedSize}
                      minSize={MIN_PANEL_SIZE}
                      defaultSize={chatPanelCollapsed ? safeCollapsedSize : undefined}
                      onCollapse={handleCollapseChatPanel}
                      onExpand={handleExpandChatPanel}
                      className="min-w-0"
                      order={1}
                    >
                      {chatPanelCollapsed ? (
                        <CollapsedChatStrip
                          onExpand={() => chatPanelRef.current?.expand()}
                          isWorking={isSessionWorking}
                        />
                      ) : (
                        <ChatArea
                          key={selectedWorkspace.id}
                          workspace={selectedWorkspace}
                          workspaceChatPanelRef={workspaceChatPanelRef}
                          onCreatePRHandlerChange={setCreatePRHandler}
                          onSendAgentMessageHandlerChange={setSendAgentMessageHandler}
                          onCollapseChatPanel={handleCollapseChatPanel}
                        />
                      )}
                    </ResizablePanel>

                    <ResizableHandle />

                    {/* Middle section: viewer + compact right panel */}
                    <ResizablePanel defaultSize={60} minSize={30} className="min-w-0" order={2}>
                      <div className="flex h-full min-w-0 animate-[fadeIn_0.2s_cubic-bezier(0,0,0.2,1)] flex-col overflow-hidden">
                        <ResizablePanelGroup direction="horizontal">
                          {/* Code viewer (diff or file preview) */}
                          <ResizablePanel minSize={30} className="min-w-0" order={1}>
                            <div className="flex h-full min-w-0 flex-col overflow-hidden">
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
                          </ResizablePanel>

                          <ResizableHandle />

                          {/* Compact right panel (file list only — no sidecar) */}
                          <ResizablePanel defaultSize={25} minSize={12} className="min-w-0" order={2}>
                            <RightSidePanel
                              workspace={selectedWorkspace}
                              activeTab={rightSideTab}
                              onOpenDiffTab={handleOpenDiff}
                              onOpenFilePreview={handleOpenFilePreview}
                              compact
                              isWatched={isWatched}
                            />
                          </ResizablePanel>
                        </ResizablePanelGroup>
                      </div>
                    </ResizablePanel>
                  </ResizablePanelGroup>
                ) : (
                  // --- Normal mode: Chat | RightSidePanel ---
                  <ResizablePanelGroup direction="horizontal" key={`${selectedWorkspaceId}-normal`}>
                    {/* Chat panel (collapsible) — collapses to 36px strip, not 0 */}
                    <ResizablePanel
                      ref={chatPanelRef}
                      collapsible
                      collapsedSize={safeCollapsedSize}
                      minSize={MIN_PANEL_SIZE}
                      defaultSize={chatPanelCollapsed ? safeCollapsedSize : undefined}
                      onCollapse={handleCollapseChatPanel}
                      onExpand={handleExpandChatPanel}
                      className="min-w-0"
                      order={1}
                    >
                      {chatPanelCollapsed ? (
                        <CollapsedChatStrip
                          onExpand={() => chatPanelRef.current?.expand()}
                          isWorking={isSessionWorking}
                        />
                      ) : (
                        <ChatArea
                          key={selectedWorkspace.id}
                          workspace={selectedWorkspace}
                          workspaceChatPanelRef={workspaceChatPanelRef}
                          onCreatePRHandlerChange={setCreatePRHandler}
                          onSendAgentMessageHandlerChange={setSendAgentMessageHandler}
                          onCollapseChatPanel={handleCollapseChatPanel}
                        />
                      )}
                    </ResizablePanel>

                    <ResizableHandle />

                    {/* Right side panel (collapsible) — collapses to 36px strip */}
                    <ResizablePanel
                      ref={rightPanelRef}
                      collapsible
                      collapsedSize={safeCollapsedSize}
                      defaultSize={rightPanelCollapsed ? safeCollapsedSize : rightPanelDefaultSize}
                      minSize={MIN_PANEL_SIZE}
                      onResize={handleResize}
                      onCollapse={handleCollapseRightPanel}
                      onExpand={handleExpandRightPanel}
                      className="min-w-0"
                      order={2}
                    >
                      {rightPanelCollapsed ? (
                        <CollapsedContentStrip
                          activeTab={rightSideTab}
                          onExpand={() => resizeToTab(rightSideTab)}
                        />
                      ) : (
                        <RightSidePanel
                          workspace={selectedWorkspace}
                          activeTab={rightSideTab}
                          onOpenDiffTab={handleOpenDiff}
                          onOpenFilePreview={handleOpenFilePreview}
                          isWatched={isWatched}
                        />
                      )}
                    </ResizablePanel>
                  </ResizablePanelGroup>
                )}
              </div>

              {/* Always-visible sidecar — outside ResizablePanelGroup */}
              <RightSidecar
                activeTab={rightSideTab}
                onTabChange={handleSidecarTabChange}
                contentCollapsed={!middlePanelActive && rightPanelCollapsed}
                compact={middlePanelActive}
              />
            </div>
          </div>
        ) : (
          <div className="flex min-w-0 flex-1">
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

