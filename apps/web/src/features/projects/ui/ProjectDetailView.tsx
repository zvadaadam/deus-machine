import { useCallback, useMemo, useRef, useState } from "react";
import {
  Archive,
  ArrowUpRight,
  LoaderCircle,
  FolderOpen,
  Users,
  MoreHorizontal,
  Square,
  TriangleAlert,
} from "lucide-react";
import { toast } from "sonner";
import type { ProjectAgent } from "@shared/projects";
import type { DiffStats, Workspace } from "@/shared/types";
import { Button } from "@/components/ui";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { SessionPanel, SessionTabBar, type ChatTab } from "@/features/session";
import { ProjectConversationProvider } from "@/features/session/context/ProjectConversationContext";
import { WorkspaceHeader } from "@/features/workspace/ui/WorkspaceHeader";
import { WorkspacePanels } from "@/app/layouts/WorkspacePanels";
import { WorkspacePanelButton } from "@/app/layouts/WorkspacePanelButton";
import type { WorkspacePanelMode } from "@/features/workspace/store/workspaceLayoutStore";
import { cn } from "@/shared/lib/utils";
import { getErrorMessage } from "@shared/lib/errors";
import { getAgentHarnessForModel } from "@/shared/agents";
import { useProject, useProjectAction } from "../api/projects.queries";
import { projectTabsActions, useProjectTabs } from "../store/projectTabsStore";
import { ProjectOverview } from "./ProjectOverview";
import { ProjectPreparation } from "./ProjectPreparation";
import { ProjectStatus } from "./ProjectStatus";
import { useIsMobile } from "@/shared/hooks/use-mobile";
import { useFileWatcher } from "@/features/file-browser/hooks/useFileWatcher";
import { ContentTabBar, ContentTabButton } from "@/app/layouts/ContentTabBar";
import { ContentView } from "@/app/layouts/ContentView";
import type { ContentTab } from "@/features/workspace/store";
import { useSimulatorCapabilities } from "@/features/simulator";
import { sessionComposerActions } from "@/features/session/store/sessionComposerStore";
import { REVIEW_CODE } from "@/features/session/lib/sessionPrompts";
import { uiActions } from "@/shared/stores/uiStore";
import { ProjectFilesView } from "./ProjectFilesView";
import type { ProjectFileSelection } from "./ProjectFilePane";
import { useSettings } from "@/features/settings/api";
import { isTabVisible } from "@/app/layouts/content-tabs";
import {
  openWorkspaceResource,
  type WorkspaceResource,
} from "@/features/session/lib/openWorkspaceResource";

function agentLabel(agent: ProjectAgent): string {
  return agent.role === "coordinator" ? "Coordinator" : agent.title;
}

/**
 * One Project page. The coordinator's conversation is the first, pinned tab;
 * opening an agent adds its conversation as another tab. The workspace tools on
 * the right (Changes, Files, Terminal…) follow the selected tab's worktree, while
 * Overview and Documents stay Project-wide.
 */
export function ProjectDetailView({
  projectId,
  workspaces,
  diffStats,
  onOpenWorkspace,
}: {
  projectId: string;
  workspaces: Workspace[];
  diffStats?: Record<string, DiffStats>;
  /** Leave the Project for an agent's full workspace view. */
  onOpenWorkspace: (agent: ProjectAgent) => void;
}) {
  const query = useProject(projectId);
  const action = useProjectAction(projectId);
  const tabs = useProjectTabs(projectId);
  const [mobileTab, setMobileTab] = useState<"chat" | "content">("chat");
  const [panelMode, setPanelMode] = useState<WorkspacePanelMode>("split");
  const [activeTab, setActiveTab] = useState<ContentTab | "overview" | "documents">("overview");
  const [file, setFile] = useState<ProjectFileSelection | null>(null);
  const isMobile = useIsMobile();
  const settings = useSettings().data;
  const overviewRef = useRef<HTMLElement>(null);
  const project = query.data;
  const coordinator = project?.agents.find((agent) => agent.id === project.coordinatorAgentId);
  const openAgents = useMemo(
    () =>
      tabs.agentIds.flatMap((id) => {
        const agent = project?.agents.find((item) => item.id === id);
        return agent && agent.role !== "coordinator" ? [agent] : [];
      }),
    [tabs.agentIds, project?.agents]
  );
  const activeAgent = openAgents.find((agent) => agent.id === tabs.activeAgentId) ?? coordinator;
  const workspace = workspaces.find((item) => item.id === activeAgent?.workspaceId);
  const isReady = workspace?.state === "ready";
  const isWatched = useFileWatcher(
    isReady ? workspace.workspace_path : null,
    isReady ? workspace.id : null
  );
  const simulator = useSimulatorCapabilities({
    enabled: settings?.experimental_simulator === true,
  });
  const simulatorAvailable = settings?.experimental_simulator === true && simulator.data.available;
  const cloudSimulator = workspace?.kind === "cloud";
  const workspaceTab =
    activeTab === "overview" || activeTab === "documents"
      ? null
      : isTabVisible(activeTab, settings, { simulatorAvailable, cloudSimulator })
        ? activeTab
        : "files";
  const openAgent = useCallback(
    (agentId: string, contentTab?: ContentTab) => {
      projectTabsActions.open(projectId, agentId === coordinator?.id ? null : agentId);
      if (contentTab) {
        setActiveTab(contentTab);
        setPanelMode((mode) => (mode === "chat" ? "split" : mode));
      }
      setMobileTab(contentTab ? "content" : "chat");
    },
    [projectId, coordinator?.id]
  );
  const conversation = useMemo(
    () => ({ agents: project?.agents ?? [], openAgent }),
    [project?.agents, openAgent]
  );
  if (query.isLoading)
    return (
      <div className="flex flex-1 items-center justify-center">
        <LoaderCircle
          aria-label="Loading project"
          className="text-text-tertiary size-5 motion-safe:animate-spin"
        />
      </div>
    );
  if (query.isError || !project)
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6">
        <p role="alert" className="text-text-secondary text-sm">
          {query.isError ? getErrorMessage(query.error) : "This project could not be found."}
        </p>
        <Button variant="outline" size="sm" onClick={uiActions.closeProjects}>
          Close project
        </Button>
        {query.isError && (
          <Button variant="ghost" size="sm" onClick={() => void query.refetch()}>
            Try again
          </Button>
        )}
      </div>
    );
  const archived = project.status === "archived";
  const run = (input: Parameters<typeof action.mutate>[0]) =>
    action.mutate(input, { onError: (error) => toast.error(getErrorMessage(error)) });
  const openResource = (resource: WorkspaceResource) => {
    if (!workspace || !activeAgent) return;
    if (
      openWorkspaceResource(workspace.id, resource, !isMobile && isTabVisible("browser", settings))
    ) {
      setActiveTab(resource.kind === "file" ? resource.target : "browser");
      setMobileTab("content");
      setPanelMode("split");
    }
  };
  const openFile = (selection: ProjectFileSelection | null) => {
    setFile(selection);
    setActiveTab("documents");
    setMobileTab("content");
    if (panelMode === "chat") setPanelMode("split");
  };
  const revealOverview = () => {
    setMobileTab("content");
    setActiveTab("overview");
    setPanelMode("split");
    requestAnimationFrame(() => {
      overviewRef.current?.scrollTo({ top: 0 });
      overviewRef.current?.focus();
    });
  };
  const chatAgents = coordinator ? [coordinator, ...openAgents] : openAgents;
  const harness = getAgentHarnessForModel(project.model);
  const chatTabs = chatAgents.map((agent): ChatTab => {
    const base = {
      id: agent.id,
      label: agentLabel(agent),
      agentHarness: harness,
      initialModel: project.model,
      closable: agent.role !== "coordinator",
    };
    return agent.sessionId
      ? { ...base, kind: "session", sessionId: agent.sessionId, hasStarted: true }
      : { ...base, kind: "pending", hasStarted: false };
  });
  const showTabBar = Boolean(coordinator?.sessionId) || openAgents.length > 0;
  const isCoordinator = !activeAgent || activeAgent.role === "coordinator";
  const header = (
    <WorkspaceHeader
      repositoryId={project.repositoryId}
      title={project.title}
      titleAs="h1"
      repositoryName={isMobile ? undefined : project.repositoryName}
      workspacePath={isReady ? workspace.workspace_path : undefined}
      mobile={isMobile}
      trailingActions={
        <>
          {!archived && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  className="no-drag"
                  aria-label="Project options"
                >
                  <MoreHorizontal />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {activeAgent?.sessionId && (
                  <DropdownMenuItem onSelect={() => onOpenWorkspace(activeAgent)}>
                    <ArrowUpRight />
                    Open {isCoordinator ? "coordinator" : activeAgent.title} workspace
                  </DropdownMenuItem>
                )}
                {!project.paused && project.activeAgentCount > 0 && (
                  <DropdownMenuItem
                    disabled={action.isPending}
                    onSelect={() => run({ action: "pause", requestId: crypto.randomUUID() })}
                  >
                    <Square />
                    Stop all agents
                  </DropdownMenuItem>
                )}
                <DropdownMenuItem
                  disabled={action.isPending}
                  onSelect={() => run({ action: "archive", requestId: crypto.randomUUID() })}
                >
                  <Archive />
                  Archive project
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
          {!isMobile && (
            <WorkspacePanelButton
              action={panelMode === "chat" ? "show" : "hide"}
              label={panelMode === "chat" ? "Show workspace" : "Hide workspace"}
              onClick={() => setPanelMode(panelMode === "chat" ? "split" : "chat")}
            />
          )}
        </>
      }
    />
  );
  const notice = (project.error || project.paused || project.status === "limit-reached") && (
    <div
      className="border-border-subtle bg-bg-elevated flex shrink-0 items-start gap-2 border-b px-4 py-3 text-xs leading-relaxed"
      role="status"
    >
      <TriangleAlert className="text-text-tertiary mt-0.5 size-3.5 shrink-0" />
      <div className="text-text-secondary flex-1">
        {project.error ||
          (project.status === "limit-reached"
            ? `The project used its ${project.dispatchLimit} allowed turns. Add more turns to continue the queued work.`
            : project.activeAgentCount > 0
              ? "Stopping agents. Queued messages are saved."
              : "Project stopped. Queued messages are saved; cancelled tasks need a new instruction or Continue.")}
      </div>
      {project.paused && project.activeAgentCount > 0 && project.error && !archived && (
        <Button
          variant="outline"
          size="xs"
          disabled={action.isPending}
          onClick={() => run({ action: "pause", requestId: crypto.randomUUID() })}
        >
          Retry stopping agents
        </Button>
      )}
      {project.paused && !archived && (
        <Button
          variant="outline"
          size="xs"
          disabled={action.isPending || project.activeAgentCount > 0}
          onClick={() => run({ action: "resume", requestId: crypto.randomUUID() })}
        >
          {project.pendingInputCount > 0 ? "Resume queued work" : "Reopen project"}
        </Button>
      )}
      {project.status === "limit-reached" && (
        <Button
          variant="outline"
          size="xs"
          disabled={action.isPending}
          onClick={() =>
            run({
              action: "limits",
              dispatchLimit: project.dispatchLimit + 20,
              requestId: crypto.randomUUID(),
            })
          }
        >
          Add 20 turns
        </Button>
      )}
    </div>
  );
  const chat = (
    <section
      id="project-panel-chat"
      aria-label={
        activeAgent ? `${agentLabel(activeAgent)} conversation` : "Coordinator conversation"
      }
      className={cn(
        "flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden",
        isMobile && mobileTab !== "chat" && "hidden"
      )}
    >
      {showTabBar && (!isMobile || openAgents.length > 0) && (
        <SessionTabBar
          tabs={chatTabs}
          activeTabId={activeAgent?.id ?? ""}
          workingSessionIds={
            new Set(
              chatAgents.flatMap((agent) =>
                agent.status === "working" && agent.sessionId ? [agent.sessionId] : []
              )
            )
          }
          onTabChange={(tabId) => openAgent(tabId)}
          onTabClose={(tabId) => projectTabsActions.close(project.id, tabId)}
          onTabReorder={(reordered) =>
            projectTabsActions.reorder(
              project.id,
              reordered.map((tab) => tab.id).filter((id) => id !== coordinator?.id)
            )
          }
        />
      )}
      <ProjectConversationProvider value={conversation}>
        {workspace && activeAgent?.sessionId ? (
          <div
            className={cn(
              "@container flex min-h-0 min-w-0 flex-1 justify-center",
              panelMode === "chat" && !isMobile && "px-4"
            )}
          >
            <div
              className={cn(
                "flex min-h-0 min-w-0 flex-1",
                panelMode === "chat" && !isMobile && "max-w-[720px]"
              )}
            >
              <SessionPanel
                key={activeAgent.sessionId}
                embedded
                sessionId={activeAgent.sessionId}
                managedProject={{ projectId: project.id, agentId: activeAgent.id, current: true }}
                workspaceId={workspace.id}
                workspacePath={workspace.workspace_path}
                workspaceKind={workspace.kind}
                workspaceRepoName={workspace.repo_name}
                workspaceParentBranch={workspace.git_target_branch}
                workspaceDefaultBranch={workspace.git_default_branch}
                initialModel={project.model}
                onRevealWorkspace={() => onOpenWorkspace(activeAgent)}
                onOpenResource={openResource}
                onOpenProjectControls={revealOverview}
              />
            </div>
          </div>
        ) : archived ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-2 p-8 text-center">
            <p className="text-text-secondary text-sm">Project archived</p>
            <p className="text-text-tertiary max-w-sm text-xs leading-relaxed">
              Published files and results remain available in the overview.
            </p>
          </div>
        ) : (
          <ProjectPreparation
            workspace={workspace}
            ready={Boolean(activeAgent?.sessionId)}
            subject={isCoordinator ? "coordinator" : "agent"}
            title={
              activeAgent?.error
                ? `${isCoordinator ? "Coordinator" : activeAgent.title} needs attention`
                : isCoordinator
                  ? "Preparing your coordinator"
                  : `Preparing ${activeAgent.title}`
            }
            error={activeAgent?.error}
          >
            {activeAgent?.error && (
              <Button
                variant="outline"
                size="sm"
                disabled={action.isPending}
                onClick={() =>
                  run({ action: "retry", agentId: activeAgent.id, requestId: crypto.randomUUID() })
                }
              >
                Retry preparation
              </Button>
            )}
          </ProjectPreparation>
        )}
      </ProjectConversationProvider>
    </section>
  );
  const content = (
    <div
      id="project-panel-content"
      className={cn(
        "flex h-full min-h-0 min-w-0 flex-1 flex-col",
        !isMobile && "pr-2 pb-2",
        panelMode === "content" && "pl-2",
        isMobile && mobileTab !== "content" && "hidden"
      )}
    >
      <div className="drag-region flex h-11 shrink-0 items-center gap-2 px-2">
        <ContentTabBar
          activeTab={workspaceTab}
          onTabChange={setActiveTab}
          workspaceId={workspace?.id}
          simulatorAvailable={simulatorAvailable}
          cloudSimulator={cloudSimulator}
          leadingTabs={
            <>
              <ContentTabButton
                item={{ label: "Overview", icon: Users }}
                isActive={activeTab === "overview"}
                onClick={() => setActiveTab("overview")}
              />
              <ContentTabButton
                item={{ label: "Documents", icon: FolderOpen }}
                isActive={activeTab === "documents"}
                onClick={() => setActiveTab("documents")}
              />
            </>
          }
        />
        {!isMobile && (
          <WorkspacePanelButton
            action={panelMode === "content" ? "restore" : "expand"}
            onClick={() => setPanelMode(panelMode === "content" ? "split" : "content")}
          />
        )}
      </div>
      <div
        className={cn(
          "relative flex min-h-0 flex-1 overflow-hidden",
          !isMobile && "border-border-subtle bg-bg-elevated rounded-lg border"
        )}
      >
        <aside
          ref={overviewRef}
          tabIndex={-1}
          aria-label="Project overview"
          className={cn(
            "min-h-0 min-w-0 flex-1 overflow-y-auto",
            activeTab !== "overview" && "hidden"
          )}
        >
          <div className="flex items-center justify-between gap-2 px-5 pt-4">
            <ProjectStatus status={project.status} />
            <span className="text-text-muted text-xs tabular-nums" title="Agent turns used">
              {project.dispatchCount} / {project.dispatchLimit}
            </span>
          </div>
          <ProjectOverview
            project={project}
            activeAgentId={openAgents.length ? (activeAgent?.id ?? null) : null}
            diffStats={diffStats}
            onOpenAgent={(agent) => openAgent(agent.id)}
            onOpenChanges={(agent) => openAgent(agent.id, "changes")}
            onOpenFile={openFile}
          />
        </aside>
        <div className={cn("min-h-0 min-w-0 flex-1", activeTab !== "documents" && "hidden")}>
          <ProjectFilesView project={project} selection={file} onSelect={openFile} />
        </div>
        {workspace && (
          <div className={cn("min-h-0 min-w-0 flex-1", !workspaceTab && "hidden")}>
            <ContentView
              workspace={workspace}
              activeTab={workspaceTab}
              panelVisible={panelMode !== "chat" && (!isMobile || mobileTab === "content")}
              isWatched={isWatched}
              simulatorAvailable={simulatorAvailable}
              cloudSimulator={cloudSimulator}
              onReview={() => {
                if (activeAgent?.sessionId)
                  sessionComposerActions.appendDraft(activeAgent.sessionId, REVIEW_CODE);
                setPanelMode("split");
                setMobileTab("chat");
              }}
            />
          </div>
        )}
      </div>
    </div>
  );
  return (
    <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col" data-slot="project-detail">
      {isMobile ? (
        <>
          {header}
          <div
            className="border-border-subtle flex h-10 shrink-0 gap-1 border-b px-3"
            role="tablist"
            aria-label="Project view"
          >
            {(["chat", "content"] as const).map((tab) => (
              <button
                key={tab}
                type="button"
                role="tab"
                aria-selected={mobileTab === tab}
                aria-controls={`project-panel-${tab}`}
                onClick={() => setMobileTab(tab)}
                className={cn(
                  "control-interaction max-w-[50%] truncate border-b-2 px-3 text-sm",
                  mobileTab === tab
                    ? "border-text-primary text-text-primary"
                    : "text-text-tertiary border-transparent"
                )}
              >
                {tab === "chat"
                  ? activeAgent
                    ? agentLabel(activeAgent)
                    : "Coordinator"
                  : "Workspace"}
              </button>
            ))}
          </div>
          {notice}
          {chat}
          {content}
        </>
      ) : (
        <WorkspacePanels
          workspaceId={`project:${project.id}`}
          mode={panelMode}
          onModeChange={setPanelMode}
          chat={
            <>
              {header}
              {notice}
              {chat}
            </>
          }
          content={content}
        />
      )}
    </div>
  );
}
