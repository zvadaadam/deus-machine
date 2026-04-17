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
import { HomeView } from "@/features/repository";
import { useWorkspaceLayout } from "@/features/workspace";
import { useCollapsedSizePercent } from "@/features/workspace/hooks/useCollapsedSizePercent";
import type { ContentTab } from "@/features/workspace/store";
import { useFileWatcher } from "@/features/file-browser/hooks/useFileWatcher";
import { WorkspaceHeader } from "@/features/workspace/ui/WorkspaceHeader";
import { ContentTabBar } from "./ContentTabBar";
import { isTabVisible } from "./content-tabs";
import { PRActions } from "@/features/workspace/ui/PRActions";
import { useSettings } from "@/features/settings/api/settings.queries";
import { SidebarInset, useSidebar } from "@/components/ui";
import { cn } from "@/shared/lib/utils";
import { ResizablePanelGroup, ResizablePanel, ResizableHandle } from "@/components/ui/resizable";
import { PanelLeft } from "lucide-react";
import type { Workspace, PRStatus, GhCliStatus } from "@/shared/types";
import { useUpdateWorkspaceStatus } from "@/features/workspace/api";
import { REVIEW_CODE } from "@/features/session/lib/sessionPrompts";
import { native } from "@/platform";
import { BROWSER_WORKSPACE_CHANGE } from "@shared/events";
import { useBrowserWindowStore } from "@/features/browser/store";
import { track } from "@/platform/analytics";
import { ConnectionBanner, useConnectionState } from "@/features/connection";
import { useIsMobile } from "@/shared/hooks/use-mobile";
import { ChatArea } from "./ChatArea";
import { ContentView } from "./ContentView";
import { MobileLayout } from "./MobileLayout";
import { CollapsedChatStrip, CollapsedContentStrip } from "./CollapsedPanelStrips";
import { useWorkspaceActions } from "./hooks/useWorkspaceActions";
import { usePanelShortcuts } from "./hooks/usePanelShortcuts";

interface MainContentProps {
  selectedWorkspace: Workspace | null;
  prStatus: PRStatus | null;
  ghStatus?: GhCliStatus | null;
  workspaceChatPanelRef: React.MutableRefObject<SessionPanelRef | null>;
  onCreateWorkspace: () => void;
  onOpenProject: () => void;
  onCloneRepository: () => void;
  onStartNewProject: () => void;
  /** Repos for the home screen's repo picker */
  repos: import("@/features/repository/types").Repository[];
  /** Handler for sending the first message from the home screen.
   *  Creates workspace + selects it + queues the first message. */
  onStartWorkspace: (repoId: string, message: string, model: string) => void;
}

export function MainContent({
  selectedWorkspace,
  prStatus,
  ghStatus,
  workspaceChatPanelRef,
  onCreateWorkspace: _onCreateWorkspace,
  onOpenProject,
  onCloneRepository,
  onStartNewProject,
  repos,
  onStartWorkspace,
}: MainContentProps) {
  const { open: sidebarOpen, toggleSidebar } = useSidebar();
  const isMobile = useIsMobile();

  const selectedWorkspaceId = selectedWorkspace?.id ?? null;
  const {
    contentTab,
    setContentTab,
    chatPanelCollapsed,
    setChatPanelCollapsed,
    contentPanelCollapsed,
    setContentPanelCollapsed,
  } = useWorkspaceLayout(selectedWorkspaceId);

  // Effective tab: if the stored tab is hidden by experimental settings, fall back to "changes".
  const experimentalSettings = useSettings().data;
  const effectiveContentTab = isTabVisible(contentTab, experimentalSettings)
    ? contentTab
    : "changes";

  const isBrowserDetached = useBrowserWindowStore((s) => s.detachedWindowOpen);
  const connectionState = useConnectionState().state;
  const isDisconnected = connectionState === "disconnected";

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
    handleArchive,
    handleRetrySetup,
    handleViewSetupLogs,
    manifestTasks,
    hasManifest,
    handleRunTask,
  } = useWorkspaceActions({
    selectedWorkspace,
    setContentTab,
  });

  const statusMutation = useUpdateWorkspaceStatus();

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
    (tab: ContentTab) => {
      setContentTab(tab);
      // Track feature surface adoption — fire on every user-initiated tab switch.
      // We use a static map instead of ts-pattern here because these are all
      // simple string→event mappings with no branching logic.
      const tabEventMap: Partial<Record<ContentTab, () => void>> = {
        terminal: () =>
          track("terminal_opened", { workspace_id: selectedWorkspaceId ?? undefined }),
        browser: () => track("browser_opened", { workspace_id: selectedWorkspaceId ?? undefined }),
        simulator: () =>
          track("simulator_opened", { workspace_id: selectedWorkspaceId ?? undefined }),
        changes: () => track("diff_viewed", { workspace_id: selectedWorkspaceId ?? undefined }),
        files: () => track("files_opened", { workspace_id: selectedWorkspaceId ?? undefined }),
      };
      tabEventMap[tab]?.();
    },
    [setContentTab, selectedWorkspaceId]
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
    setContentPanelCollapsed(true);
    contentPanelRef.current?.collapse();
  }, [setContentPanelCollapsed]);

  const handleExpandContentPanel = useCallback(() => {
    setContentPanelCollapsed(false);
  }, [setContentPanelCollapsed]);

  useEffect(() => {
    if (!selectedWorkspaceId) return;
    if (contentPanelCollapsed) {
      contentPanelRef.current?.collapse();
    } else {
      contentPanelRef.current?.expand();
    }
  }, [contentPanelCollapsed, selectedWorkspaceId]);

  // --- Keyboard shortcuts ---
  usePanelShortcuts({
    enabled: selectedWorkspace !== null && !isMobile,
    chatPanelCollapsed,
    chatPanelRef,
    contentPanelCollapsed,
    contentPanelRef,
  });

  // --- Reset panel sizes on workspace switch ---
  // ResizablePanelGroup has no key prop — it stays mounted across workspace
  // switches so SimulatorPanel and BrowserPanel keep their native sessions alive.
  // Without the key, react-resizable-panels won't re-apply defaultSize on
  // re-render. We must imperatively collapse/expand panels to match the
  // per-workspace Zustand state when the selected workspace changes.
  useEffect(() => {
    if (!selectedWorkspaceId) return;
    if (chatPanelCollapsed) {
      chatPanelRef.current?.collapse();
    } else {
      chatPanelRef.current?.expand();
      chatPanelRef.current?.resize(sessionPanelDefaultSize);
    }
    if (contentPanelCollapsed) {
      contentPanelRef.current?.collapse();
    } else {
      contentPanelRef.current?.expand();
      contentPanelRef.current?.resize(contentPanelDefaultSize);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only fire on workspace change, not on collapse toggles
  }, [selectedWorkspaceId]);

  // --- Hide all native BrowserViews on workspace switch ---
  // BrowserViews are native Electron overlays rendered ABOVE the DOM. When
  // switching workspaces or going to the welcome screen, stale views from
  // the previous workspace would remain visible. Hide them immediately;
  // the new workspace's BrowserTab will re-show its own view when ready.
  useEffect(() => {
    native.browserViews.hideAll().catch(() => {
      /* Expected: IPC may be unavailable in web mode; stale views are harmless */
    });
  }, [selectedWorkspaceId]);

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
    void native.events.send(BROWSER_WORKSPACE_CHANGE, detachedWorkspaceContext);
  }, [isBrowserDetached, detachedWorkspaceContext]);

  // Insert code review prompt into chat input
  const handleInsertReviewPrompt = useCallback(() => {
    workspaceChatPanelRef.current?.insertText(REVIEW_CODE);
  }, [workspaceChatPanelRef]);

  return (
    <SidebarInset className="min-w-0">
      {/* Connection banner — appears at top of content area when WS is down */}
      <ConnectionBanner />

      <div
        data-slot="main-content"
        className={cn(
          "bg-bg-surface flex h-full min-w-0 flex-1 overflow-hidden transition-[border-radius,border-color,opacity] duration-[280ms] ease-[cubic-bezier(.19,1,.22,1)]",
          // Mobile: edge-to-edge, no border/rounding (sidebar is a Sheet overlay)
          isMobile
            ? "border-0"
            : cn(
                "border",
                sidebarOpen
                  ? "border-border-subtle rounded-tl-xl border-r-0"
                  : "rounded-none border-transparent"
              ),
          isDisconnected && "opacity-60"
        )}
      >
        {/* Sidebar toggle -- visible when sidebar collapsed (desktop) or always on mobile welcome */}
        {(!sidebarOpen || isMobile) && !selectedWorkspace && (
          <button
            type="button"
            data-slot="welcome-sidebar-toggle"
            aria-label="Expand sidebar"
            onClick={toggleSidebar}
            className="text-muted-foreground/60 hover:text-foreground hover:bg-foreground/5 absolute top-3 left-3 z-10 flex h-7 w-7 items-center justify-center rounded-lg transition-[transform,color,background-color] duration-200 ease-out"
          >
            <PanelLeft className="h-4 w-4" />
          </button>
        )}

        {selectedWorkspace ? (
          isMobile ? (
            /* Mobile: single-panel layout with bottom tab bar */
            <MobileLayout
              key={selectedWorkspace.id}
              workspace={selectedWorkspace}
              workspaceChatPanelRef={workspaceChatPanelRef}
              sendAgentMessageHandler={sendAgentMessageHandler}
              handleSendAgentMessage={handleSendAgentMessage}
              onRetrySetup={
                selectedWorkspace.setup_status === "failed" ? handleRetrySetup : undefined
              }
              onViewSetupLogs={
                selectedWorkspace.setup_status === "failed" ? handleViewSetupLogs : undefined
              }
              setCreatePRHandler={setCreatePRHandler}
              setSendAgentMessageHandler={setSendAgentMessageHandler}
              isWatched={isWatched}
              manifestTasks={manifestTasks}
              hasManifest={hasManifest}
              onRunTask={handleRunTask}
              onStatusChange={(status) =>
                statusMutation.mutate({ workspaceId: selectedWorkspace.id, status })
              }
              prStatus={prStatus}
              ghStatus={ghStatus}
              onCreatePR={createPRHandler ? handleCreatePR : undefined}
              onArchive={handleArchive}
              targetBranch={selectedTargetBranch}
              onTargetBranchChange={setSelectedTargetBranch}
            />
          ) : (
            /* Two-panel split — the top-level layout, no full-width header */
            <div ref={panelGroupContainerRef} className="min-h-0 min-w-0 flex-1">
              <ResizablePanelGroup direction="horizontal">
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
                        onSendAgentMessage={
                          sendAgentMessageHandler ? handleSendAgentMessage : undefined
                        }
                        onRetrySetup={
                          selectedWorkspace.setup_status === "failed" ? handleRetrySetup : undefined
                        }
                        onViewSetupLogs={
                          selectedWorkspace.setup_status === "failed"
                            ? handleViewSetupLogs
                            : undefined
                        }
                        workspaceStatus={selectedWorkspace.status}
                        onStatusChange={(status) =>
                          statusMutation.mutate({ workspaceId: selectedWorkspace.id, status })
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
                  defaultSize={contentPanelCollapsed ? safeCollapsedSize : contentPanelDefaultSize}
                  minSize={MIN_PANEL_SIZE}
                  onCollapse={handleCollapseContentPanel}
                  onExpand={handleExpandContentPanel}
                  className="min-w-0"
                  order={2}
                >
                  {contentPanelCollapsed ? (
                    <CollapsedContentStrip onExpand={() => contentPanelRef.current?.expand()} />
                  ) : (
                    <div className="flex h-full flex-col pr-2 pb-2">
                      {/* Tab header: content tabs (left) + PR actions (right) */}
                      <div className="drag-region flex h-11 flex-shrink-0 items-center justify-between px-2.5">
                        <ContentTabBar
                          activeTab={effectiveContentTab}
                          onTabChange={handleContentTabChange}
                          workspaceId={selectedWorkspaceId}
                        />
                        <PRActions
                          prStatus={prStatus}
                          ghStatus={ghStatus}
                          onCreatePR={createPRHandler ? handleCreatePR : undefined}
                          onSendAgentMessage={
                            sendAgentMessageHandler ? handleSendAgentMessage : undefined
                          }
                          onArchive={handleArchive}
                          targetBranch={selectedTargetBranch}
                          onTargetBranchChange={setSelectedTargetBranch}
                          repoId={selectedWorkspace.repository_id}
                          workspaceId={selectedWorkspaceId ?? undefined}
                        />
                      </div>

                      {/* Content area — rounded corners, subtle border */}
                      <div className="border-border-subtle bg-bg-elevated flex min-h-0 flex-1 overflow-hidden rounded-lg border">
                        <ContentView
                          workspace={selectedWorkspace}
                          activeTab={effectiveContentTab}
                          isWatched={isWatched}
                          onReview={handleInsertReviewPrompt}
                        />
                      </div>
                    </div>
                  )}
                </ResizablePanel>
              </ResizablePanelGroup>
            </div>
          )
        ) : (
          <div className="flex min-w-0 flex-1">
            <HomeView
              repos={repos}
              onSendMessage={onStartWorkspace}
              onOpenProject={onOpenProject}
              onCloneRepository={onCloneRepository}
              onStartNewProject={onStartNewProject}
            />
          </div>
        )}
      </div>
    </SidebarInset>
  );
}
