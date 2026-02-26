/**
 * Main Content -- layout orchestrator.
 *
 * Two-panel horizontal split (40/60 default ratio):
 *   SESSION PANEL (left, 40%):  WorkspaceHeader → SessionTabs → Chat → Input
 *   CONTENT PANEL (right, 60%): ContentTabBar + PRActions → ContentArea
 *
 * Each panel has its own header bar. The split is the top-level layout.
 * Content tab switching (Code, Config, Terminal, etc.) lives in the
 * content panel's header. PR actions also live in the content panel header.
 *
 * Panel resizing uses react-resizable-panels for keyboard accessibility,
 * touch support, and built-in collapse/expand with snap behavior.
 *
 * Concerns are split across extracted hooks:
 * - useWorkspaceActions: PR bridge, archive, retry, manifest tasks
 * - useKeyboardShortcuts: Cmd+\ toggles session panel
 */

import { useRef, useCallback, useMemo, useEffect } from "react";
import type { ImperativePanelHandle } from "react-resizable-panels";
import type { SessionPanelRef } from "@/features/session";
import { WelcomeView } from "@/features/repository";
import { useWorkspaceLayout } from "@/features/workspace";
import { useCollapsedSizePercent } from "@/features/workspace/hooks/useCollapsedSizePercent";
import type { RightSideTab } from "@/features/workspace/store";
import { useFileWatcher } from "@/features/file-browser/hooks/useFileWatcher";
import { WorkspaceHeader } from "@/features/workspace/ui/WorkspaceHeader";
import { ContentTabBar, isTabVisible } from "@/features/workspace/ui/ContentTabBar";
import { PRActions } from "@/features/workspace/ui/PRActions";
import { useSettings } from "@/features/settings/api/settings.queries";
import { SidebarInset, useSidebar } from "@/components/ui";
import { cn } from "@/shared/lib/utils";
import { ResizablePanelGroup, ResizablePanel, ResizableHandle } from "@/components/ui/resizable";
import { PanelLeft } from "lucide-react";
import type { Workspace, PRStatus, GhCliStatus } from "@/shared/types";
import { emit } from "@/platform/tauri";
import { useBrowserWindowStore } from "@/features/browser/store";
import { ChatArea } from "./ChatArea";
import { RightSidePanel } from "./RightSidePanel";
import { CollapsedChatStrip, CollapsedContentStrip } from "./CollapsedPanelStrips";
import { useWorkspaceActions } from "./hooks/useWorkspaceActions";
import { useKeyboardShortcuts } from "./hooks/useKeyboardShortcuts";

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
  const { open: sidebarOpen, toggleSidebar } = useSidebar();

  const selectedWorkspaceId = selectedWorkspace?.id ?? null;
  const {
    rightSideTab,
    setRightSideTab,
    chatPanelCollapsed,
    setChatPanelCollapsed,
    rightPanelCollapsed,
    setRightPanelCollapsed,
  } = useWorkspaceLayout(selectedWorkspaceId);

  // Effective tab: if the stored tab is hidden by experimental settings, fall back to "code".
  const experimentalSettings = useSettings().data;
  const effectiveRightSideTab = isTabVisible(rightSideTab, experimentalSettings)
    ? rightSideTab
    : "code";

  const isBrowserDetached = useBrowserWindowStore((s) => s.detachedWindowOpen);

  // --- Workspace actions (PR bridge, archive, retry, manifest) ---
  const {
    createPRHandler,
    setCreatePRHandler,
    sendAgentMessageHandler,
    setSendAgentMessageHandler,
    selectedTargetBranch,
    setSelectedTargetBranch,
    handleCreatePR,
    handleSendAgentMessage,
    handleOpenPR,
    handleArchive,
    handleRetrySetup,
    handleViewSetupLogs,
    manifestTasks,
    hasManifest,
    handleRunTask,
  } = useWorkspaceActions({
    selectedWorkspace,
    prStatus,
    setRightSideTab,
  });

  // Only start watching and querying diffs once the worktree checkout is complete.
  const isReady = selectedWorkspace?.state === "ready";

  // Watch workspace for file changes (event-driven cache invalidation)
  const isWatched = useFileWatcher(
    isReady ? (selectedWorkspace?.workspace_path ?? null) : null,
    isReady ? selectedWorkspaceId : null
  );

  // --- Refs for imperative panel control ---
  const chatPanelRef = useRef<ImperativePanelHandle>(null);
  const contentPanelRef = useRef<ImperativePanelHandle>(null);
  const panelGroupContainerRef = useRef<HTMLDivElement>(null);

  // Dynamic collapsed size: 36px strip -> percentage of container width.
  const MIN_PANEL_SIZE = 15;
  const collapsedSizePct = useCollapsedSizePercent(panelGroupContainerRef, 36);
  const safeCollapsedSize = Math.min(collapsedSizePct, MIN_PANEL_SIZE - 0.1);

  // Default split: 40% session / 60% content — same for all tabs.
  const sessionPanelDefaultSize = 40;
  const contentPanelDefaultSize = 60;

  const sessionStatus = selectedWorkspace?.session_status;
  const isSessionWorking = sessionStatus === "working";

  // --- Content tab change ---
  const handleContentTabChange = useCallback(
    (tab: RightSideTab) => {
      setRightSideTab(tab);
    },
    [setRightSideTab]
  );

  // --- Chat panel collapse/expand ---
  const handleCollapseChatPanel = useCallback(() => {
    setChatPanelCollapsed(true);
    chatPanelRef.current?.collapse();
  }, [setChatPanelCollapsed]);

  const handleExpandChatPanel = useCallback(() => {
    setChatPanelCollapsed(false);
  }, [setChatPanelCollapsed]);

  // --- Content panel collapse/expand ---
  const handleCollapseContentPanel = useCallback(() => {
    setRightPanelCollapsed(true);
    contentPanelRef.current?.collapse();
  }, [setRightPanelCollapsed]);

  const handleExpandContentPanel = useCallback(() => {
    setRightPanelCollapsed(false);
  }, [setRightPanelCollapsed]);

  // --- Keyboard shortcuts ---
  useKeyboardShortcuts({
    enabled: selectedWorkspace !== null,
    chatPanelCollapsed,
    chatPanelRef,
    contentPanelCollapsed: rightPanelCollapsed,
    contentPanelRef,
  });

  // --- Sync workspace changes to detached browser window ---
  const detachedWorkspaceContext = useMemo(
    () =>
      selectedWorkspace
        ? {
            workspaceId: selectedWorkspace.id,
            directoryName: selectedWorkspace.slug,
            repoName: selectedWorkspace.repo_name,
            branch: selectedWorkspace.git_branch,
          }
        : null,
    [selectedWorkspace]
  );

  useEffect(() => {
    if (!isBrowserDetached || !detachedWorkspaceContext) return;
    void emit("browser-window:workspace-change", detachedWorkspaceContext);
  }, [isBrowserDetached, detachedWorkspaceContext]);

  // Diff handlers: opening a diff switches to code tab.
  const handleOpenDiff = useCallback(
    (_filePath: string) => {
      setRightSideTab("code");
    },
    [setRightSideTab]
  );

  const handleOpenFilePreview = useCallback(
    (_filePath: string) => {
      setRightSideTab("code");
    },
    [setRightSideTab]
  );

  return (
    <SidebarInset className="min-w-0">
      <div
        data-slot="main-content"
        className={cn(
          "bg-bg-surface flex h-full min-w-0 flex-1 overflow-hidden border transition-[border-radius,border-color] duration-[280ms] ease-[cubic-bezier(.19,1,.22,1)]",
          sidebarOpen
            ? "border-border-subtle rounded-l-xl border-r-0"
            : "rounded-none border-transparent"
        )}
      >
        {/* Sidebar toggle -- visible when sidebar collapsed and no workspace */}
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
          /* Two-panel split — the top-level layout, no full-width header */
          <div ref={panelGroupContainerRef} className="min-h-0 min-w-0 flex-1">
            <ResizablePanelGroup
              direction="horizontal"
              key={selectedWorkspaceId}
            >
              {/* ─── SESSION PANEL (left, collapsible) ─── */}
              <ResizablePanel
                ref={chatPanelRef}
                collapsible
                collapsedSize={safeCollapsedSize}
                minSize={MIN_PANEL_SIZE}
                defaultSize={chatPanelCollapsed ? safeCollapsedSize : sessionPanelDefaultSize}
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
                  <div className="flex h-full min-w-0 flex-col">
                    {/* Title header — workspace name + repo/branch + Open */}
                    <WorkspaceHeader
                      title={selectedWorkspace.title ?? undefined}
                      repositoryName={selectedWorkspace.repo_name}
                      branch={selectedWorkspace.git_branch ?? undefined}
                      workspacePath={selectedWorkspace.workspace_path}
                      setupStatus={selectedWorkspace.setup_status}
                      setupError={selectedWorkspace.error_message}
                      onSendAgentMessage={sendAgentMessageHandler ? handleSendAgentMessage : undefined}
                      onRetrySetup={
                        selectedWorkspace.setup_status === "failed" ? handleRetrySetup : undefined
                      }
                      onViewSetupLogs={
                        selectedWorkspace.setup_status === "failed" ? handleViewSetupLogs : undefined
                      }
                      tasks={manifestTasks}
                      hasManifest={hasManifest}
                      onRunTask={handleRunTask}
                    />

                    {/* Session tabs + chat messages + input */}
                    <ChatArea
                      key={selectedWorkspace.id}
                      workspace={selectedWorkspace}
                      workspaceChatPanelRef={workspaceChatPanelRef}
                      onCreatePRHandlerChange={setCreatePRHandler}
                      onSendAgentMessageHandlerChange={setSendAgentMessageHandler}
                      onCollapseChatPanel={handleCollapseChatPanel}
                    />
                  </div>
                )}
              </ResizablePanel>

              <ResizableHandle />

              {/* ─── CONTENT PANEL (right, collapsible) ─── */}
              <ResizablePanel
                ref={contentPanelRef}
                collapsible
                collapsedSize={safeCollapsedSize}
                defaultSize={rightPanelCollapsed ? safeCollapsedSize : contentPanelDefaultSize}
                minSize={MIN_PANEL_SIZE}
                onCollapse={handleCollapseContentPanel}
                onExpand={handleExpandContentPanel}
                className="min-w-0"
                order={2}
              >
                {rightPanelCollapsed ? (
                  <CollapsedContentStrip
                    onExpand={() => contentPanelRef.current?.expand()}
                  />
                ) : (
                  <div className="flex h-full flex-col pr-2 pb-2">
                    {/* Tab header: content tabs (left) + PR actions (right) */}
                    <div className="flex h-9 flex-shrink-0 items-center justify-between px-2.5">
                      <ContentTabBar
                        activeTab={effectiveRightSideTab}
                        onTabChange={handleContentTabChange}
                      />
                      <PRActions
                        prStatus={prStatus}
                        ghStatus={ghStatus}
                        onCreatePR={createPRHandler ? handleCreatePR : undefined}
                        onSendAgentMessage={sendAgentMessageHandler ? handleSendAgentMessage : undefined}
                        onReviewPR={handleOpenPR}
                        onArchive={handleArchive}
                        targetBranch={selectedTargetBranch}
                        onTargetBranchChange={setSelectedTargetBranch}
                        workspacePath={selectedWorkspace.workspace_path}
                      />
                    </div>

                    {/* Content area — rounded corners, subtle border */}
                    <div className="border-border-subtle bg-bg-raised flex min-h-0 flex-1 overflow-hidden rounded-[10px] border">
                      <RightSidePanel
                        workspace={selectedWorkspace}
                        activeTab={effectiveRightSideTab}
                        onOpenDiffTab={handleOpenDiff}
                        onOpenFilePreview={handleOpenFilePreview}
                        isWatched={isWatched}
                      />
                    </div>
                  </div>
                )}
              </ResizablePanel>
            </ResizablePanelGroup>
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
