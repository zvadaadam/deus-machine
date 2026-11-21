/** Workspace actions and desktop/mobile composition. Pane geometry lives in WorkspacePanels. */

import type { AddProjectAction } from "@/features/repository/lib/addProject";
import { locationOf } from "@/features/sidebar/lib/location";
import { localFolder, openableFolder } from "@/features/workspace/lib/reach";
import { useCallback, useMemo } from "react";
import { wakeCloudWorkspace } from "@/features/workspace/api/wakeCloudWorkspace";
import { cloudPresence } from "@/features/workspace/lib/cloudPresence";
import { failedToStart, hasCheckout } from "@/features/workspace/lib/startState";
import type { ThinkingLevel } from "@/shared/agents";
import { HomeView, type Repository } from "@/features/repository";
import { useWorkspaceLayout } from "@/features/workspace";
import type { ContentTab } from "@/features/workspace/store";
import { useFileWatcher } from "@/features/file-browser/hooks/useFileWatcher";
import { useSimulatorCapabilities } from "@/features/simulator";
import { workspaceLayoutActions } from "@/features/workspace/store";
import { sessionComposerActions } from "@/features/session/store/sessionComposerStore";
import { WorkspaceHeader } from "@/features/workspace/ui/WorkspaceHeader";
import { ContentTabBar } from "./ContentTabBar";
import { CONTENT_TABS, isTabVisible, anyContentTabVisible, tabsFor } from "./content-tabs";
import { isCloudDirectWebMode } from "@/shared/config/webDirectMode";
import { PRActions } from "@/features/workspace/ui/PRActions";
import { useSettings } from "@/features/settings/api/settings.queries";
import { SidebarInset, useSidebar } from "@/components/ui";
import { cn } from "@/shared/lib/utils";
import { PanelLeft } from "lucide-react";
import type { Workspace, RepoGroup, PRStatus, GhCliStatus } from "@/shared/types";
import { useUpdateWorkspaceStatus } from "@/features/workspace/api";
import { REVIEW_CODE } from "@/features/session/lib/sessionPrompts";
import { track } from "@/platform/analytics";
import { ConnectionBanner, useConnectionState } from "@/features/connection";
import { useIsMobile } from "@/shared/hooks/use-mobile";
import { ChatArea } from "./ChatArea";
import { ContentView } from "./ContentView";
import { MobileLayout } from "./MobileLayout";
import { useAutomationForWorkspace } from "@/features/automations";
import { uiActions } from "@/shared/stores/uiStore";
import { useWorkspaceActions } from "./hooks/useWorkspaceActions";
import { WorkspacePanels } from "./WorkspacePanels";
import { WorkspacePanelButton } from "./WorkspacePanelButton";
import { WorkspaceToolShortcuts } from "./WorkspaceToolShortcuts";
import { usePanelShortcuts } from "./hooks/usePanelShortcuts";

interface MainContentProps {
  selectedWorkspace: Workspace | null;
  prStatus: PRStatus | null;
  ghStatus?: GhCliStatus | null;
  onOpenProject: () => void;
  onCloneRepository: () => void;
  onStartNewProject: () => void;
  /** The cloud's add dialog, for an organization; the window's when none is given. */
  onAddFromGitHub: (organizationId?: string | null) => void;
  /** The ways to add a project by the window's place. */
  addActions: AddProjectAction[];
  /** Repos for the home screen's repo picker */
  repos: Repository[];
  /** Sidebar workspace groups reused by the home screen recent list. */
  repoGroups: RepoGroup[];
  /** Discovery state for the web-direct home: loading and a failed load are
   *  not an empty account. */
  repoGroupsLoading?: boolean;
  repoGroupsError?: string | null;
  /** Handler for sending the first message from the home screen.
   *  Creates workspace + selects it + queues the first message.
   *  Resolves false when the workspace could not be created. */
  onStartWorkspace: (
    repoId: string,
    message: string,
    model: string,
    branch?: string,
    location?: "local" | "cloud",
    thinkingLevel?: ThinkingLevel,
    /** In the cloud, the organization it starts in; the backend's default when absent. */
    organizationId?: string | null
  ) => Promise<boolean>;
  onWorkspaceClick: (workspace: Workspace) => void;
}

export function MainContent({
  selectedWorkspace,
  prStatus,
  ghStatus,
  onOpenProject,
  onCloneRepository,
  onStartNewProject,
  onAddFromGitHub,
  addActions,
  repos,
  repoGroups,
  repoGroupsLoading,
  repoGroupsError,
  onStartWorkspace,
  onWorkspaceClick,
}: MainContentProps) {
  const { open: sidebarOpen, toggleSidebar } = useSidebar();
  const isMobile = useIsMobile();

  const selectedWorkspaceId = selectedWorkspace?.id ?? null;
  // Provenance: the automation whose held sandbox this workspace is (if any)
  // — renders the header chip that jumps to the automation's run history.
  const workspaceAutomation = useAutomationForWorkspace(selectedWorkspaceId);
  const { contentTab, setContentTab, panelMode, setPanelMode } =
    useWorkspaceLayout(selectedWorkspaceId);

  // Effective tab: if the stored tab is hidden by experimental settings, fall back to "changes".
  const experimentalSettings = useSettings().data;
  const simulatorCapabilities = useSimulatorCapabilities({
    enabled: experimentalSettings?.experimental_simulator === true,
  });
  const simulatorAvailable =
    experimentalSettings?.experimental_simulator === true &&
    simulatorCapabilities.data.available === true;
  // A cloud workspace's tabs are its computer's, whatever this one's settings say.
  const workspaceKind = selectedWorkspace?.kind;
  const tabVisibility = useMemo(
    () => tabsFor(workspaceKind ? { kind: workspaceKind } : null, simulatorAvailable),
    [workspaceKind, simulatorAvailable]
  );
  const effectiveContentTab = isTabVisible(contentTab, experimentalSettings, tabVisibility)
    ? contentTab
    : "changes";
  // No tab can serve (web-direct hides them all) → chat-only layout: the chat
  // pane renders full-width and the content pane + splitter don't mount. The
  // same for a workspace that failed to start: its page is the failure. One
  // that is still starting keeps the layout it is about to need, so nothing
  // moves when it becomes ready.
  const contentPaneAvailable =
    anyContentTabVisible(experimentalSettings, tabVisibility) &&
    !(selectedWorkspace && failedToStart(selectedWorkspace));
  const view = contentPaneAvailable ? panelMode : "chat";

  const connectionState = useConnectionState().state;
  const isDisconnected = connectionState === "disconnected";

  // --- Workspace actions (PR bridge, archive, manifest) ---
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
    environmentTasks,
    handleRunTask,
  } = useWorkspaceActions({
    selectedWorkspace,
    setContentTab,
  });

  const statusMutation = useUpdateWorkspaceStatus();
  // Web-direct has no status mutation (workflow status is Mac-side state), so
  // the header menu doesn't render — WorkspaceHeader gates on the handler.
  const webDirect = isCloudDirectWebMode();

  const cloudState =
    selectedWorkspace?.kind === "cloud" ? cloudPresence(selectedWorkspace) : undefined;
  const handleCloudWake = useCallback(() => {
    if (selectedWorkspaceId) void wakeCloudWorkspace(selectedWorkspaceId);
  }, [selectedWorkspaceId]);

  // Only start watching and querying diffs once the worktree checkout is complete.
  const isReady = selectedWorkspace?.state === "ready";

  // Watch workspace for file changes (event-driven cache invalidation). Only a
  // folder on this computer can be watched here (rule 1): a cloud workspace's
  // files are on its computer.
  const watchedFolder = isReady && selectedWorkspace ? localFolder(selectedWorkspace) : null;
  const isWatched = useFileWatcher(watchedFolder, watchedFolder ? selectedWorkspaceId : null);

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

  usePanelShortcuts({
    enabled: selectedWorkspace !== null && !isMobile && contentPaneAvailable,
    mode: panelMode,
    onModeChange: setPanelMode,
  });

  // Insert code review prompt into the active chat's composer. Goes
  // straight through the composer store — no SessionPanel ref round-trip,
  // which means it works even if the chat panel is collapsed.
  const handleInsertReviewPrompt = useCallback(() => {
    if (!selectedWorkspaceId) return;
    const sid = workspaceLayoutActions.getLayout(selectedWorkspaceId).activeChatTabSessionId;
    if (sid) sessionComposerActions.appendDraft(sid, REVIEW_CODE);
  }, [selectedWorkspaceId]);

  // A pull request needs a branch, and a branch needs the checkout.
  const prActions = selectedWorkspace && hasCheckout(selectedWorkspace) && (
    <PRActions
      prStatus={prStatus}
      ghStatus={ghStatus}
      onCreatePR={createPRHandler ? handleCreatePR : undefined}
      onSendAgentMessage={sendAgentMessageHandler ? handleSendAgentMessage : undefined}
      onArchive={handleArchive}
      targetBranch={selectedTargetBranch}
      onTargetBranchChange={setSelectedTargetBranch}
      repoId={selectedWorkspace.repository_id}
      workspaceId={selectedWorkspaceId ?? undefined}
    />
  );

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
            className="control-interaction text-muted-foreground/60 hover:text-foreground hover:bg-foreground/5 absolute top-3 left-3 z-10 flex h-7 w-7 items-center justify-center rounded-lg"
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
              sendAgentMessageHandler={sendAgentMessageHandler}
              handleSendAgentMessage={handleSendAgentMessage}
              setCreatePRHandler={setCreatePRHandler}
              setSendAgentMessageHandler={setSendAgentMessageHandler}
              isWatched={isWatched}
              environmentTasks={environmentTasks}
              onRunTask={handleRunTask}
              onStatusChange={
                webDirect
                  ? undefined
                  : (status) => statusMutation.mutate({ workspaceId: selectedWorkspace.id, status })
              }
              cloudPresence={cloudState}
              onCloudWake={isCloudDirectWebMode() ? undefined : handleCloudWake}
              prStatus={prStatus}
              ghStatus={ghStatus}
              onCreatePR={createPRHandler ? handleCreatePR : undefined}
              onArchive={handleArchive}
              targetBranch={selectedTargetBranch}
              onTargetBranchChange={setSelectedTargetBranch}
            />
          ) : (
            <div className="min-h-0 min-w-0 flex-1">
              <WorkspacePanels
                workspaceId={selectedWorkspace.id}
                mode={panelMode}
                onModeChange={setPanelMode}
                chat={
                  <>
                    <WorkspaceHeader
                      workspaceId={selectedWorkspace.id}
                      repositoryId={selectedWorkspace.repository_id}
                      title={selectedWorkspace.title ?? undefined}
                      repositoryName={selectedWorkspace.repo_name}
                      branch={selectedWorkspace.git_branch ?? undefined}
                      workspacePath={openableFolder(selectedWorkspace) ?? undefined}
                      kind={selectedWorkspace.kind}
                      automationName={workspaceAutomation?.name}
                      onOpenAutomation={
                        workspaceAutomation
                          ? () => uiActions.openAutomations(workspaceAutomation.id)
                          : undefined
                      }
                      cloudPresence={cloudState}
                      onCloudWake={isCloudDirectWebMode() ? undefined : handleCloudWake}
                      setupStatus={selectedWorkspace.setup_status}
                      setupError={selectedWorkspace.error_message}
                      onSendAgentMessage={
                        sendAgentMessageHandler ? handleSendAgentMessage : undefined
                      }
                      workspaceStatus={selectedWorkspace.status}
                      onStatusChange={
                        webDirect
                          ? undefined
                          : (status) =>
                              statusMutation.mutate({ workspaceId: selectedWorkspace.id, status })
                      }
                      trailingActions={
                        contentPaneAvailable && (
                          <>
                            {view === "chat" && prActions}
                            <div
                              className={cn(
                                "flex items-center",
                                view === "chat" && "border-border-subtle ml-1 border-l pl-2"
                              )}
                            >
                              <WorkspacePanelButton
                                action={view === "chat" ? "show" : "hide"}
                                onClick={() => setPanelMode(view === "chat" ? "split" : "chat")}
                              />
                            </div>
                          </>
                        )
                      }
                      tasks={environmentTasks}
                      onRunTask={handleRunTask}
                    />
                    <div className="@container flex min-h-0 flex-1">
                      <div
                        className={cn(
                          "flex min-h-0 min-w-0 flex-1 justify-center",
                          view === "chat" && "px-4"
                        )}
                      >
                        <div
                          className={cn(
                            "flex min-h-0 min-w-0 flex-1",
                            view === "chat" && "max-w-[720px]"
                          )}
                        >
                          <ChatArea
                            key={selectedWorkspace.id}
                            workspace={selectedWorkspace}
                            onCreatePRHandlerChange={setCreatePRHandler}
                            onSendAgentMessageHandlerChange={setSendAgentMessageHandler}
                          />
                        </div>
                      </div>
                      {contentPaneAvailable && view === "chat" && (
                        <WorkspaceToolShortcuts
                          items={CONTENT_TABS.filter((item) =>
                            isTabVisible(item.id, experimentalSettings, tabVisibility)
                          )}
                          onSelect={handleContentTabChange}
                          onEnvironment={() =>
                            uiActions.openEnvironmentSettings(
                              selectedWorkspace.repository_id,
                              locationOf(selectedWorkspace)
                            )
                          }
                        />
                      )}
                    </div>
                  </>
                }
                content={
                  contentPaneAvailable ? (
                    <div
                      className={cn(
                        "flex h-full min-w-0 flex-col pr-2 pb-2",
                        view === "content" && "pl-2"
                      )}
                    >
                      <div
                        data-slot="workspace-tool-header"
                        className="drag-region flex h-11 shrink-0 items-center gap-2 px-2"
                      >
                        {view === "content" && (
                          <WorkspacePanelButton
                            action="hide"
                            onClick={() => setPanelMode("chat")}
                          />
                        )}
                        <ContentTabBar
                          activeTab={effectiveContentTab}
                          onTabChange={handleContentTabChange}
                          workspaceId={selectedWorkspaceId}
                          visibility={tabVisibility}
                        />
                        {prActions}
                      </div>
                      <div className="border-border-subtle bg-bg-elevated flex min-h-0 flex-1 overflow-hidden rounded-lg border">
                        <ContentView
                          workspace={selectedWorkspace}
                          activeTab={effectiveContentTab}
                          panelVisible={view !== "chat"}
                          isWatched={isWatched}
                          onReview={handleInsertReviewPrompt}
                          visibility={tabVisibility}
                          toolbarAction={
                            <WorkspacePanelButton
                              action={view === "content" ? "restore" : "expand"}
                              onClick={() => setPanelMode(view === "content" ? "split" : "content")}
                            />
                          }
                        />
                      </div>
                    </div>
                  ) : undefined
                }
              />
            </div>
          )
        ) : (
          <div className="flex min-w-0 flex-1">
            <HomeView
              repos={repos}
              repoGroups={repoGroups}
              repoGroupsLoading={repoGroupsLoading}
              repoGroupsError={repoGroupsError}
              onSendMessage={onStartWorkspace}
              onWorkspaceClick={onWorkspaceClick}
              onOpenProject={onOpenProject}
              onCloneRepository={onCloneRepository}
              onStartNewProject={onStartNewProject}
              onAddFromGitHub={onAddFromGitHub}
              addActions={addActions}
            />
          </div>
        )}
      </div>
    </SidebarInset>
  );
}
