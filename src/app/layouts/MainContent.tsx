/**
 * Main Content — layout orchestrator.
 *
 * Three layout modes:
 * 1. Normal:  ChatArea (flex) + RightSidePanel (resizable)
 * 2. Code:    ChatArea (flex) <resize> Viewer <resize> RightSidePanel (compact) + Sidecar
 * 3. Browser: ChatArea (flex) <resize> RightSidePanel (expanded, resizable)
 *
 * Panel resizing uses react-resizable-panels for keyboard accessibility,
 * touch support, and built-in collapse/expand with snap behavior.
 *
 * When the middle panel opens, sidebar auto-collapses on screens narrower
 * than 1680px and restores when it closes. ESC closes the middle panel.
 */

import { useState, useRef, useCallback, useMemo, useEffect, useLayoutEffect } from "react";
import type { ImperativePanelHandle } from "react-resizable-panels";
import type { SessionPanelRef } from "@/features/session";
import { WelcomeView } from "@/features/repository";
import { useWorkspaceLayout, useFileChanges } from "@/features/workspace";
import { useArchiveWorkspace } from "@/features/workspace/api/workspace.queries";
import type { WorkspaceGitInfo } from "@/features/workspace";
import { useFileWatcher } from "@/features/file-browser/hooks/useFileWatcher";
import { DiffTabContent } from "@/features/workspace/ui/DiffTabContent";
import { WorkspaceHeader } from "@/features/workspace/ui/WorkspaceHeader";
import { FileViewer } from "@/features/file-browser";
import { SidebarInset, useSidebar } from "@/components/ui";
import { ResizablePanelGroup, ResizablePanel, ResizableHandle } from "@/components/ui/resizable";
import { PanelLeft } from "lucide-react";
import { toast } from "sonner";
import type { Workspace, PRStatus, GhCliStatus } from "@/shared/types";
import { cn } from "@/shared/lib/utils";
import { emit } from "@/platform/tauri";
import { useBrowserWindowStore } from "@/features/browser/store";
import { ChatArea } from "./ChatArea";
import { RightSidePanel } from "./RightSidePanel";

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
    rightPanelWidth,
    setRightPanelWidth,
    rightSideTab,
    chatPanelCollapsed,
    setChatPanelCollapsed,
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

  // Reset state when workspace changes (React-recommended render-time pattern)
  const prevWorkspaceIdRef = useRef(selectedWorkspaceId);
  // Guard: true once stored width has been restored for the current workspace.
  // Prevents useLayoutEffect from re-firing on every drag frame (which would
  // cause a feedback loop: onResize → setRightPanelWidth → effect → resize()).
  const hasRestoredWidthRef = useRef(false);
  if (prevWorkspaceIdRef.current !== selectedWorkspaceId) {
    prevWorkspaceIdRef.current = selectedWorkspaceId;
    if (middlePanel !== null) setMiddlePanel(null);
    if (parkedMiddlePanel !== null) setParkedMiddlePanel(null);
    if (sidebarBeforePanel !== null) setSidebarBeforePanel(null);
    setSelectedTargetBranch(selectedWorkspace?.default_branch ?? "main");
    // eslint-disable-next-line react-hooks/refs -- intentional: reset on workspace change during render
    hasRestoredWidthRef.current = false;
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

  // Watch workspace for file changes (event-driven cache invalidation)
  const isWatched = useFileWatcher(selectedWorkspace?.workspace_path ?? null, selectedWorkspaceId);

  // File changes for prev/next navigation — polling disabled when file watcher is active
  const { data: fileChangesData } = useFileChanges(
    selectedWorkspaceId,
    selectedWorkspace?.session_status,
    workspaceGitInfo ?? undefined,
    isWatched
  );
  const fileChanges = useMemo(() => fileChangesData ?? [], [fileChangesData]);

  // --- Refs for imperative panel control ---
  const chatPanelRef = useRef<ImperativePanelHandle>(null);
  const rightPanelRef = useRef<ImperativePanelHandle>(null);
  const mainContentRef = useRef<HTMLDivElement>(null);

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

  const handleCollapseChatPanel = useCallback(() => {
    setChatPanelCollapsed(true);
  }, [setChatPanelCollapsed]);

  const handleExpandChatPanel = useCallback(() => {
    setChatPanelCollapsed(false);
  }, [setChatPanelCollapsed]);

  // --- Right panel resize persistence ---
  // Convert percentage size from react-resizable-panels to pixels for Zustand store
  const handleRightPanelResize = useCallback(
    (sizePercent: number) => {
      const container = mainContentRef.current;
      if (!container) return;
      const total = container.getBoundingClientRect().width;
      if (total > 0) {
        setRightPanelWidth(Math.round((sizePercent / 100) * total));
      }
    },
    [setRightPanelWidth]
  );

  // Default size for right panel — smart default only, no ref access needed.
  // Stored pixel widths are restored after mount via useLayoutEffect below.
  const rightPanelDefaultSize = isBrowserTab && !isBrowserDetached ? 60 : 30;

  // Restore stored panel width once after mount / workspace switch.
  // useLayoutEffect runs before paint so the user sees no flash.
  // The hasRestoredWidthRef guard prevents this from re-firing during drag
  // (onResize updates rightPanelWidth, which would otherwise re-trigger
  // this effect and create a feedback loop with forced layout reflows).
  useLayoutEffect(() => {
    if (hasRestoredWidthRef.current) return;
    if (rightPanelWidth === null || middlePanelActive) return;
    const container = mainContentRef.current;
    if (!container || !rightPanelRef.current) return;
    const total = container.getBoundingClientRect().width;
    if (total > 0) {
      rightPanelRef.current.resize((rightPanelWidth / total) * 100);
      hasRestoredWidthRef.current = true;
    }
  }, [rightPanelWidth, middlePanelActive]);

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

  // Cmd+\ toggles chat panel collapse/expand via imperative panel API
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
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [selectedWorkspace, chatPanelCollapsed]);

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
            className="text-muted-foreground/60 hover:text-foreground hover:bg-foreground/5 absolute top-3 left-3 z-10 flex h-7 w-7 items-center justify-center rounded-md transition-[left,color,background-color] duration-200 ease-out"
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

            {/* Panels row */}
            <div ref={mainContentRef} className="flex min-h-0 min-w-0 flex-1">
              {middlePanelActive && workspaceGitInfo ? (
                // --- Middle panel mode: Chat | Viewer | CompactPanel ---
                <ResizablePanelGroup direction="horizontal" key={`${selectedWorkspaceId}-middle`}>
                  {/* Chat panel (collapsible) */}
                  <ResizablePanel
                    ref={chatPanelRef}
                    collapsible
                    collapsedSize={0}
                    minSize={15}
                    defaultSize={chatPanelCollapsed ? 0 : undefined}
                    onCollapse={handleCollapseChatPanel}
                    onExpand={handleExpandChatPanel}
                    className="min-w-0"
                    order={1}
                  >
                    {chatPanelCollapsed ? (
                      <CollapsedChatStrip onExpand={() => chatPanelRef.current?.expand()} />
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

                        {/* Compact right panel (file list + sidecar) */}
                        <ResizablePanel defaultSize={25} minSize={12} className="min-w-0" order={2}>
                          <RightSidePanel
                            workspace={selectedWorkspace}
                            onOpenDiffTab={handleOpenDiff}
                            onOpenFilePreview={handleOpenFilePreview}
                            compact
                            chatPanelCollapsed={chatPanelCollapsed}
                            onExitCompactMode={handleExitCompactMode}
                            onReturnToCode={handleRestoreParkedMiddlePanel}
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
                  {/* Chat panel (collapsible) */}
                  <ResizablePanel
                    ref={chatPanelRef}
                    collapsible
                    collapsedSize={0}
                    minSize={15}
                    defaultSize={chatPanelCollapsed ? 0 : undefined}
                    onCollapse={handleCollapseChatPanel}
                    onExpand={handleExpandChatPanel}
                    className="min-w-0"
                    order={1}
                  >
                    {chatPanelCollapsed ? (
                      <CollapsedChatStrip onExpand={() => chatPanelRef.current?.expand()} />
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

                  {/* Right side panel */}
                  <ResizablePanel
                    ref={rightPanelRef}
                    defaultSize={rightPanelDefaultSize}
                    minSize={20}
                    onResize={handleRightPanelResize}
                    className="min-w-0"
                    order={2}
                  >
                    <RightSidePanel
                      workspace={selectedWorkspace}
                      onOpenDiffTab={handleOpenDiff}
                      onOpenFilePreview={handleOpenFilePreview}
                      chatPanelCollapsed={chatPanelCollapsed}
                      onReturnToCode={handleRestoreParkedMiddlePanel}
                      isWatched={isWatched}
                    />
                  </ResizablePanel>
                </ResizablePanelGroup>
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

/** Thin collapsed strip — shows when chat panel is collapsed */
function CollapsedChatStrip({ onExpand }: { onExpand: () => void }) {
  return (
    <button
      type="button"
      aria-label="Expand chat"
      onClick={onExpand}
      className={cn(
        "border-border-subtle flex h-full w-full cursor-pointer items-center justify-center border-r",
        "text-text-muted hover:text-text-secondary hover:bg-bg-overlay",
        "transition-colors duration-200 ease-out",
        "animate-[fadeIn_0.15s_0.15s_cubic-bezier(0,0,0.2,1)] [animation-fill-mode:backwards]"
      )}
    >
      <PanelLeft className="h-4 w-4" />
    </button>
  );
}
