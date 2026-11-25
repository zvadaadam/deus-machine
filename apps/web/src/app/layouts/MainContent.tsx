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
import { useWorkspacePanelMode } from "@/features/workspace";
import { useFileWatcher } from "@/features/file-browser/hooks/useFileWatcher";
import { useSimulatorCapabilities } from "@/features/simulator";
import { workspaceLayoutActions } from "@/features/workspace/store";
import { sessionComposerActions } from "@/features/session/store/sessionComposerStore";
import { WorkspaceHeader } from "@/features/workspace/ui/WorkspaceHeader";
import {
  getVisibleTools,
  anyContentTabVisible,
  tabsFor,
  type ContentTab,
} from "@/features/workspace-tabs";
import { isCloudDirectWebMode } from "@/shared/config/webDirectMode";
import { PRActions } from "@/features/workspace/ui/PRActions";
import { useSettings } from "@/features/settings/api/settings.queries";
import { SidebarInset, useSidebar } from "@/components/ui";
import { cn } from "@/shared/lib/utils";
import { PanelLeft } from "lucide-react";
import type { Workspace, RepoGroup } from "@/shared/types";
import type { PRActionState } from "@/features/workspace/lib/prState";
import { useUpdateWorkspaceStatus } from "@/features/workspace/api";
import { REVIEW_CODE } from "@/features/session/lib/sessionPrompts";
import { track } from "@/platform/analytics";
import { ConnectionBanner, useConnectionState } from "@/features/connection";
import { useIsMobile } from "@/shared/hooks/use-mobile";
import { ChatArea } from "./ChatArea";
import { MobileLayout } from "./MobileLayout";
import { useAutomationForWorkspace } from "@/features/automations";
import { uiActions } from "@/shared/stores/uiStore";
import { useWorkspaceActions } from "./hooks/useWorkspaceActions";
import { WorkspaceContentPane } from "./WorkspaceContentPane";
import { WorkspacePanels } from "./WorkspacePanels";
import { WorkspacePanelButton } from "./WorkspacePanelButton";
import { WorkspaceToolShortcuts } from "./WorkspaceToolShortcuts";
import { usePanelShortcuts } from "./hooks/usePanelShortcuts";

interface MainContentProps {
  selectedWorkspace: Workspace | null;
  onArchive?: () => void;
  prState: PRActionState;
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

const toolOpenedEvent = {
  terminal: "terminal_opened",
  browser: "browser_opened",
  simulator: "simulator_opened",
  changes: "diff_viewed",
  files: "files_opened",
  config: null,
} as const;

export function MainContent({
  selectedWorkspace,
  onArchive,
  prState,
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
  // The header chip opens run history for the automation that holds this workspace.
  const workspaceAutomation = useAutomationForWorkspace(selectedWorkspaceId);
  const { panelMode, setPanelMode } = useWorkspacePanelMode(selectedWorkspaceId);

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

  const visibleTools = useMemo(
    () => getVisibleTools(experimentalSettings, tabVisibility),
    [experimentalSettings, tabVisibility]
  );

  // Web-direct has no tools. A failed start has no checkout for them.
  // Keep the pane during startup so the chat stays in place when the checkout is ready.
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
    environmentTasks,
    handleRunTask,
  } = useWorkspaceActions({
    selectedWorkspace,
  });

  const statusMutation = useUpdateWorkspaceStatus();
  // Workflow status lives on the Mac. The hosted header omits the menu without a handler.
  const webDirect = isCloudDirectWebMode();

  const cloudState =
    selectedWorkspace?.kind === "cloud" ? cloudPresence(selectedWorkspace) : undefined;
  const handleCloudWake = useCallback(() => {
    if (selectedWorkspaceId) void wakeCloudWorkspace(selectedWorkspaceId);
  }, [selectedWorkspaceId]);

  // Watch only after checkout. Rule 1 gives a cloud workspace no folder on this computer.
  const isReady = selectedWorkspace?.state === "ready";
  const watchedFolder = isReady && selectedWorkspace ? localFolder(selectedWorkspace) : null;
  const isWatched = useFileWatcher(watchedFolder ? selectedWorkspaceId : null);

  const openTool = useCallback(
    (tool: ContentTab, replaceTabId?: string) => {
      if (!selectedWorkspaceId) return;
      workspaceLayoutActions.openToolTab(selectedWorkspaceId, tool, {
        replaceTabId,
        forceNew: !!replaceTabId,
        cloud: workspaceKind === "cloud",
      });
      const event = toolOpenedEvent[tool];
      if (event) track(event, { workspace_id: selectedWorkspaceId });
    },
    [selectedWorkspaceId, workspaceKind]
  );

  usePanelShortcuts({
    enabled: selectedWorkspace !== null && !isMobile && contentPaneAvailable,
    mode: panelMode,
    onModeChange: setPanelMode,
  });

  // Write to the composer store so Review also works with the chat pane collapsed.
  const handleInsertReviewPrompt = useCallback(() => {
    if (!selectedWorkspaceId) return;
    const sid = workspaceLayoutActions.getLayout(selectedWorkspaceId).activeChatTabSessionId;
    if (sid) sessionComposerActions.appendDraft(sid, REVIEW_CODE);
  }, [selectedWorkspaceId]);

  // A pull request needs a branch, and a branch needs the checkout.
  const prActions = selectedWorkspace && hasCheckout(selectedWorkspace) && (
    <PRActions
      state={prState}
      onCreatePR={createPRHandler ? handleCreatePR : undefined}
      onSendAgentMessage={sendAgentMessageHandler ? handleSendAgentMessage : undefined}
      onArchive={onArchive}
      targetBranch={selectedTargetBranch}
      onTargetBranchChange={setSelectedTargetBranch}
      repoId={selectedWorkspace.repository_id}
      workspaceId={selectedWorkspaceId ?? undefined}
    />
  );

  return (
    <SidebarInset className="min-w-0">
      <ConnectionBanner />

      <div
        data-slot="main-content"
        className={cn(
          "bg-bg-surface flex h-full min-w-0 flex-1 overflow-hidden transition-[border-radius,border-color,opacity]",
          sidebarOpen ? "tempo-slow" : "tempo-slow-exit",
          // The phone's sidebar is a sheet, so its content goes edge to edge.
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
              prState={prState}
              onCreatePR={createPRHandler ? handleCreatePR : undefined}
              onArchive={onArchive}
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
                          items={visibleTools}
                          onSelect={openTool}
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
                    <WorkspaceContentPane
                      workspace={selectedWorkspace}
                      view={view}
                      onModeChange={setPanelMode}
                      visibility={tabVisibility}
                      onOpenTool={openTool}
                      isWatched={isWatched}
                      onReview={handleInsertReviewPrompt}
                      environmentTasks={environmentTasks}
                      onRunTask={handleRunTask}
                      prActions={prActions}
                    />
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
