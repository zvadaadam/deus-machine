import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useDeusCloudSession } from "@/shared/hooks/useDeusCloudSession";
import { api } from "@shared/api";
import { call } from "@/platform/ws";
import type { ThinkingLevel } from "@/shared/agents";
import {
  AddRepositoryDialog,
  CloneRepositoryModal,
  StartNewProjectModal,
} from "@/features/repository";
import { addProjectActions, hiddenAddProjectCommands } from "@/features/repository/lib/addProject";
import { SettingsSidebar, SettingsPage, useAssistantArrivals } from "@/features/settings";
import {
  useKeyboardShortcuts,
  useZoom,
  useIsFullscreen,
  useWindowDragZone,
  useWindowResizing,
} from "@/shared/hooks";
import {
  useWorkspacesByRepo,
  useBulkDiffStats,
  rereadDiffStats,
  usePRStatus,
  useGhStatus,
  useArchiveWorkspace,
  useUnarchiveWorkspace,
  useUpdateWorkspaceStatus,
} from "@/features/workspace/api";
import { useResizeHandle } from "@/features/workspace";
import { useRepos } from "@/features/repository/api";
import { SidebarProvider, useSidebar } from "@/components/ui";
import { AppSidebar, SidebarSkeleton } from "@/features/sidebar";
import { useWorkspaceStore } from "@/features/workspace/store";
import { openWorkspace, showWorkspace } from "@/features/workspace/lib/openWorkspace";
import { openNewWorkspace } from "@/features/workspace/lib/newWorkspace";
import { derivePRActionState } from "@/features/workspace/lib/prState";
import { hasCheckout } from "@/features/workspace/lib/startState";
import { pendingFirstMessages } from "@/features/workspace/store/workspaceStartStore";
import { chatView, type ChatView } from "@/features/settings/lib/chatView";
import { useEditableSettings, useUpdateSettings } from "@/features/settings/api/settings.queries";
import { useFirstMessageDelivery } from "@/features/session/hooks/useFirstMessageDelivery";
import { useSidebarStore } from "@/features/sidebar/store";
import { useWindowPlace } from "@/features/sidebar/hooks/useWindowPlace";
import { offersNewFromBranch } from "@/features/sidebar/lib/location";
import { openableFolder } from "@/features/workspace/lib/reach";
import { cloudPresence } from "@/features/workspace/lib/cloudPresence";
import { wokeUp, type OpenCloudWorkspace } from "@/features/workspace/lib/diffStats";
import { useUIStore } from "@/shared/stores/uiStore";
import { ResizeHandle } from "@/shared/components/ResizeHandle";
import { tempo } from "@/shared/lib/tempo";
import { native } from "@/platform";
import { capabilities } from "@/platform/capabilities";
import { isCloudDirectWebMode } from "@/shared/config/webDirectMode";
import { getLastOpenInAppId } from "@/shared/hooks/useLastOpenInApp";
import { track } from "@/platform/analytics";
import { CommandPalette } from "@/features/command-palette";
import {
  copyWorkspaceLink,
  currentChatLink,
  useHasWorkspaceChat,
} from "@/features/workspace/lib/workspaceAddress";
import { AutomationsPage, useAutomations } from "@/features/automations";
import { BoardPage } from "@/features/board/BoardPage";
import { useFileVisit } from "@/features/workspace/lib/fileVisit";
import { useBoardAddress } from "@/features/board/address";
import { CustomizePage } from "@/features/customize";
import { setupEnvironmentPrompt } from "@/features/session/lib/sessionPrompts";
import { GitHubPickerModal } from "@/features/sidebar/ui/GitHubPickerModal";
import { useConnectionStateInit } from "@/features/connection";
import { MainContent } from "./MainContent";
import { useRepoActions } from "./hooks/useRepoActions";
import { toast } from "sonner";
import { getErrorMessage } from "@shared/lib/errors";
import { useCreateWorkspace } from "@/features/workspace/api";

/**
 * SidebarResizeHandle — drag handle on the sidebar's right edge.
 * Must be rendered inside SidebarProvider to access sidebar open state.
 * Reports isDragging so the parent can disable sidebar CSS transitions during resize.
 */
function SidebarResizeHandle({
  onSizeChange,
  onDraggingChange,
}: {
  onSizeChange: (size: number | null) => void;
  onDraggingChange: (dragging: boolean) => void;
}) {
  const { open } = useSidebar();

  const { handleProps, isDragging } = useResizeHandle({
    onSizeChange,
    enabled: open,
    direction: "horizontal",
    mode: "primary",
    minPrimarySize: 200,
    minSecondarySize: 400,
  });

  // Notify parent of drag state changes to disable sidebar transitions
  useEffect(() => {
    onDraggingChange(isDragging);
  }, [isDragging, onDraggingChange]);

  if (!open) return null;

  return <ResizeHandle handleProps={handleProps} isDragging={isDragging} label="Resize sidebar" />;
}

export function MainLayout() {
  // Keep the Deus Cloud auth listener alive for the whole app lifetime.
  // Owned only by transient consumers (a settings section, an onboarding
  // step), the device-key-minted broadcast was lost whenever the user
  // navigated before the background mint finished.
  useDeusCloudSession();
  // Zustand stores - Global state (ID-only; full object derived from React Query below)
  const selectedWorkspaceId = useWorkspaceStore((state) => state.selectedWorkspaceId);
  const selectWorkspace = useWorkspaceStore((state) => state.selectWorkspace);
  const expandRepo = useSidebarStore((s) => s.expandRepo);

  const board = useBoardAddress();
  useFileVisit(selectedWorkspaceId);
  const settingsOpen = useUIStore((s) => s.settingsOpen);
  const automationsOpen = useUIStore((s) => s.automationsOpen);
  const openAutomations = useUIStore((s) => s.openAutomations);
  const customizeOpen = useUIStore((s) => s.customizeOpen);
  const openCustomize = useUIStore((s) => s.openCustomize);

  // TanStack Query
  const workspacesQuery = useWorkspacesByRepo();
  // Keep the automations cache warm app-wide: the sidebar zap and the header
  // chip derive provenance from it, not just the Automations view.
  useAutomations();
  // An assistant asking to connect is announced wherever the person is.
  useAssistantArrivals();

  const repoGroups = useMemo(() => workspacesQuery.data ?? [], [workspacesQuery.data]);
  const loading = workspacesQuery.isLoading;

  // Derive the full workspace object from React Query data.
  // The store only holds an ID; this useMemo resolves it to a Workspace
  // on every React Query refresh, eliminating the old sync effect entirely.
  const selectedWorkspace = useMemo(() => {
    if (!selectedWorkspaceId || !repoGroups.length) return null;
    for (const group of repoGroups) {
      const found = group.workspaces.find((w) => w.id === selectedWorkspaceId);
      if (found) return found;
    }
    return null;
  }, [selectedWorkspaceId, repoGroups]);

  const webDirect = isCloudDirectWebMode();

  // Opening a cloud workspace attaches its session channel (Durable Object
  // side — does NOT wake the VM). The snapshot that comes back is how deus
  // learns an old sandbox is paused: the row updates and the chat shows
  // "Sandbox paused — wakes on your next message". Idempotent server-side.
  const selectedCloudWorkspaceId =
    selectedWorkspace?.kind === "cloud" ? selectedWorkspace.id : null;
  // Its channel open (the connect answers once it is), its diff numbers are read
  // again: the sidebar's were read with none open, as zeros.
  const queryClient = useQueryClient();
  useEffect(() => {
    if (!selectedCloudWorkspaceId) return;
    call(api.connectCloudWorkspace, { workspaceId: selectedCloudWorkspaceId })
      .then(() => rereadDiffStats(queryClient, selectedCloudWorkspaceId))
      .catch(() => {
        // Best-effort — an unreachable platform just means no truth refresh.
      });
  }, [selectedCloudWorkspaceId, queryClient]);
  // Its computer waking, they are read again too: read while it slept, as zeros.
  const selectedCloudPresence =
    selectedWorkspace?.kind === "cloud" ? cloudPresence(selectedWorkspace) : null;
  const openCloudRef = useRef<OpenCloudWorkspace | null>(null);
  useEffect(() => {
    const current =
      selectedCloudWorkspaceId && selectedCloudPresence
        ? { workspaceId: selectedCloudWorkspaceId, presence: selectedCloudPresence }
        : null;
    if (wokeUp(openCloudRef.current, current) && current) {
      rereadDiffStats(queryClient, current.workspaceId);
    }
    openCloudRef.current = current;
  }, [selectedCloudWorkspaceId, selectedCloudPresence, queryClient]);

  // Bulk-fetch diff stats for all workspaces: one query for the whole sidebar
  const bulkDiffStatsQuery = useBulkDiffStats(repoGroups);

  // Sidebar resize: null = default 344px, number = user-set width
  const [sidebarWidth, setSidebarWidth] = useState<number | null>(null);
  // Tracks drag state to disable sidebar CSS transitions during resize
  const [sidebarDragging, setSidebarDragging] = useState(false);

  // GitHub picker modal state
  const [githubPickerRepoId, setGithubPickerRepoId] = useState<string | null>(null);

  // Queries for repos
  const reposQuery = useRepos();

  const repos = reposQuery.data || [];

  // GitHub integration status — gates PR polling and feeds the sidebar profile
  const ghStatusQuery = useGhStatus();
  const ghIdentity = ghStatusQuery.data;
  const sidebarProfile = {
    login: ghIdentity?.login ?? null,
    displayName: ghIdentity?.displayName ?? null,
    avatarUrl: ghIdentity?.avatarUrl ?? null,
  };

  const prWorkspaceId =
    selectedWorkspace && hasCheckout(selectedWorkspace) ? selectedWorkspace.id : null;
  const prStatusQuery = usePRStatus(prWorkspaceId, {
    ghInstalled: ghStatusQuery.data?.isInstalled,
    ghAuthenticated: ghStatusQuery.data?.isAuthenticated,
    workspace: selectedWorkspace,
  });

  // --- Extracted hooks ---

  const repoActions = useRepoActions({ selectWorkspace });

  // A workspace starts on Home: from the sidebar's row, or a project's "+"
  // (which hands Home that project).
  const handleNewWorkspace = useCallback((repoId?: string) => openNewWorkspace({ repoId }), []);

  // --- Home screen send flow ---
  // When the user sends a message from the home screen, we:
  // 1. Create a workspace for the selected repo
  // 2. Select it (transitions to two-panel layout)
  // 3. Queue the message to be sent once the workspace has its first chat
  const welcomeCreateMutation = useCreateWorkspace();
  // The message waits in workspaceStartStore, keyed by workspace, and is sent
  // by useFirstMessageDelivery when that workspace is ready — whichever one is
  // on screen. A start that fails keeps it: the workspace's start view shows
  // it, and a retry sends it.
  useFirstMessageDelivery(repoGroups, workspacesQuery.isSuccess);

  const handleStartWorkspace = useCallback(
    async (
      repoId: string,
      message: string,
      model: string,
      branch?: string,
      location?: "local" | "cloud",
      thinkingLevel?: ThinkingLevel,
      organizationId?: string | null,
      role?: "coordinator"
    ) => {
      try {
        const workspace = await welcomeCreateMutation.mutateAsync(
          branch || location || role
            ? {
                repositoryId: repoId,
                source_branch: branch,
                ...(role && { role }),
                location,
                // A cloud workspace starts in the organization the composer names.
                ...(location === "cloud" && organizationId
                  ? { organization_id: organizationId }
                  : {}),
              }
            : repoId
        );
        // Store pending message — will be sent when workspace gets a session
        pendingFirstMessages.set(workspace.id, { message, model, thinkingLevel });
        showWorkspace(workspace.id);
        expandRepo(workspace.repository_id);
        return true;
      } catch (error) {
        console.error("Failed to create workspace from home:", error);
        toast.error(getErrorMessage(error));
        return false;
      }
    },
    [welcomeCreateMutation, expandRepo]
  );

  // Settings uses the same creation/send path as the home composer.
  const pendingEnvSetup = useUIStore((s) => s.pendingEnvSetup);
  useEffect(() => {
    if (!pendingEnvSetup) return;
    useUIStore.getState().clearEnvSetupRequest();
    void handleStartWorkspace(
      pendingEnvSetup.repoId,
      setupEnvironmentPrompt(pendingEnvSetup.location),
      pendingEnvSetup.model,
      undefined,
      pendingEnvSetup.location,
      undefined,
      pendingEnvSetup.organizationId
    );
  }, [pendingEnvSetup, handleStartWorkspace]);

  // Derive repo name for GitHub picker modal from repoGroups
  const githubPickerRepoName = useMemo(() => {
    if (!githubPickerRepoId) return "";
    const group = repoGroups.find((g) => g.repo_id === githubPickerRepoId);
    return group?.repo_name ?? "";
  }, [githubPickerRepoId, repoGroups]);

  const { mutateAsync: archive } = useArchiveWorkspace();
  const { mutate: restore } = useUnarchiveWorkspace();
  const archiveWorkspace = useCallback(
    async (workspaceId: string) => {
      let toastId: ReturnType<typeof toast.loading> | undefined;
      // A local archive usually finishes before a progress message can be read.
      const pending = setTimeout(() => {
        toastId = toast.loading("Archiving…");
      }, tempo.moderate.duration * 1000);
      try {
        await archive(workspaceId);
        if (useWorkspaceStore.getState().selectedWorkspaceId === workspaceId) selectWorkspace(null);
        toast.success("Workspace archived", {
          id: toastId,
          duration: 5000,
          action: {
            label: "Undo",
            onClick: () => restore(workspaceId),
          },
        });
      } catch (error) {
        toast.error(getErrorMessage(error), { id: toastId });
      } finally {
        clearTimeout(pending);
      }
    },
    [archive, restore, selectWorkspace]
  );

  const { mutate: updateStatus } = useUpdateWorkspaceStatus();
  const handleStatusChange = useCallback(
    (workspaceId: string, status: import("@shared/enums").WorkspaceStatus) => {
      updateStatus(
        { workspaceId, status },
        { onError: (error) => toast.error(getErrorMessage(error)) }
      );
    },
    [updateStatus]
  );

  // --- Global hooks ---

  // Connection state machine — subscribes to WS changes + send-attempt-failed events
  useConnectionStateInit();

  // Zoom (Cmd+=/Cmd+-/Cmd+0)
  useZoom();

  // Track fullscreen state — toggles `.fullscreen` class on <html> for CSS
  useIsFullscreen();

  // Adds .electron class to <html> and injects CSS-only drag region rules.
  // Headers with .drag-region class become draggable; buttons auto-excluded.
  useWindowDragZone();

  // Disable CSS transitions during native window resize to prevent content "sticking"
  useWindowResizing();

  // Rule 1: an editor opens the workspace's folder on this computer; with
  // none (a cloud workspace, or no checkout yet) ⌘O and the palette offer nothing.
  const selectedFolder = selectedWorkspace ? openableFolder(selectedWorkspace) : null;
  const canOpenInApp = selectedFolder !== null;
  function openInLastApp() {
    const lastAppId = getLastOpenInAppId();
    const path = selectedFolder;
    if (lastAppId && path) {
      track("open_in_app", { app_id: lastAppId });
      native.apps.openIn(lastAppId, path).catch((err) => {
        console.warn("[MainLayout] Failed to open workspace in external app:", err);
      });
    }
  }

  // Where this window's workspaces run: this computer, or the cloud (by organization).
  // The sidebar lists that place; the rest of the app reads the full list.
  const places = useWindowPlace({
    repoGroups,
    selectedWorkspaceId,
    selectedWorkspace,
    openWorkspace,
    selectWorkspace,
  });
  const { place: windowPlace } = places;
  // Adding a project follows the window's place: a folder on this computer, a
  // GitHub repository (no clone) in the cloud, in the window's organization.
  const folderPicker = { nativeFolderPicker: capabilities.nativeFolderPicker };
  const addActions = addProjectActions(windowPlace.location, folderPicker);
  const { openAddFromGitHub } = repoActions;
  const handleAddFromGitHub = useCallback(
    (organizationId?: string | null) =>
      openAddFromGitHub(organizationId !== undefined ? organizationId : windowPlace.organizationId),
    [openAddFromGitHub, windowPlace.organizationId]
  );

  // Keyboard shortcuts
  useKeyboardShortcuts({
    onRefresh: async () => {
      workspacesQuery.refetch();
      if (prWorkspaceId) {
        prStatusQuery.refetch();
      }
    },
    onOpenInApp: canOpenInApp ? openInLastApp : undefined,
    onSwitchPlace: places.chooseIndex,
  });

  const { settings } = useEditableSettings();
  const { mutate: updateSettings } = useUpdateSettings();
  function showChatView(view: ChatView) {
    updateSettings(
      { key: "chat_view", value: view },
      { onError: (error) => toast.error(getErrorMessage(error)) }
    );
  }

  const hasChat = useHasWorkspaceChat(selectedWorkspace?.id);
  function copyLink(target: "workspace" | "chat") {
    if (!selectedWorkspace) return;
    const workspaceId = selectedWorkspace.id;
    return copyWorkspaceLink(target === "chat" ? currentChatLink(workspaceId) : { workspaceId });
  }

  return (
    <SidebarProvider
      className="h-full"
      data-resizing={sidebarDragging || undefined}
      style={
        {
          "--sidebar-width": sidebarWidth ? `${sidebarWidth}px` : "344px",
          "--sidebar-width-mobile": "344px",
        } as React.CSSProperties
      }
    >
      {/* Sidebar — swap between app sidebar and settings sidebar */}
      {settingsOpen ? (
        <SettingsSidebar />
      ) : loading ? (
        <SidebarSkeleton />
      ) : (
        <AppSidebar
          places={places}
          selectedWorkspaceId={board ? null : selectedWorkspace?.id || null}
          diffStatsMap={bulkDiffStatsQuery.data}
          onWorkspaceClick={openWorkspace}
          onNewWorkspace={handleNewWorkspace}
          newWorkspaceActive={!board && !selectedWorkspace && !automationsOpen && !customizeOpen}
          onNewWorkspaceFromGitHub={setGithubPickerRepoId}
          onAddRepository={repoActions.handleOpenProject}
          onCloneRepository={() => repoActions.setShowCloneModal(true)}
          onStartNewProject={() => repoActions.setShowStartNewModal(true)}
          onAddFromGitHub={() => handleAddFromGitHub()}
          addActions={addActions}
          // The connected computer handles archive and workflow changes.
          onArchive={webDirect ? undefined : archiveWorkspace}
          onStatusChange={webDirect ? undefined : handleStatusChange}
          onOpenAutomations={openAutomations}
          automationsActive={automationsOpen}
          onOpenCustomize={openCustomize}
          customizeActive={customizeOpen}
          profile={sidebarProfile}
        />
      )}

      {/* Sidebar resize handle */}
      <SidebarResizeHandle onSizeChange={setSidebarWidth} onDraggingChange={setSidebarDragging} />

      {/* Main Content — swap between app content, settings, automations and Customize */}
      {settingsOpen ? (
        <SettingsPage />
      ) : automationsOpen ? (
        <AutomationsPage />
      ) : customizeOpen ? (
        <CustomizePage />
      ) : board ? (
        <BoardPage key={board.boardId} address={board} profile={sidebarProfile} />
      ) : (
        <MainContent
          selectedWorkspace={selectedWorkspace}
          onArchive={
            selectedWorkspace && !webDirect
              ? () => archiveWorkspace(selectedWorkspace.id)
              : undefined
          }
          prState={derivePRActionState(prStatusQuery, ghIdentity, selectedWorkspace)}
          onOpenProject={repoActions.handleOpenProject}
          onCloneRepository={() => repoActions.setShowCloneModal(true)}
          onStartNewProject={() => repoActions.setShowStartNewModal(true)}
          onAddFromGitHub={handleAddFromGitHub}
          addActions={addActions}
          repos={repos}
          hasWorkspaces={repoGroups.some((group) =>
            group.workspaces.some((workspace) => workspace.state !== "archived")
          )}
          repoGroupsLoading={workspacesQuery.isLoading}
          repoGroupsError={workspacesQuery.isError ? getErrorMessage(workspacesQuery.error) : null}
          onStartWorkspace={handleStartWorkspace}
        />
      )}

      {/* Modals */}

      <CloneRepositoryModal
        show={repoActions.showCloneModal}
        cloning={repoActions.cloning}
        error={repoActions.cloneError}
        statusMessage={repoActions.cloneStatus}
        onClose={repoActions.closeCloneModal}
        onClone={repoActions.handleCloneRepository}
        onClearError={repoActions.clearCloneError}
      />

      <AddRepositoryDialog
        open={!!repoActions.addFromGitHub}
        organizationId={repoActions.addFromGitHub?.organizationId ?? null}
        onClose={repoActions.closeAddFromGitHub}
        onAdded={repoActions.handleCloudRepoAdded}
        projects={repoGroups}
      />

      <StartNewProjectModal
        show={repoActions.showStartNewModal}
        creating={repoActions.startingNew}
        error={repoActions.startNewError}
        statusMessage={repoActions.startNewStatus}
        onClose={repoActions.closeStartNewModal}
        onCreateProject={repoActions.handleStartNewProject}
        onClearError={repoActions.clearStartNewError}
      />

      <GitHubPickerModal
        open={!!githubPickerRepoId}
        onOpenChange={(open) => !open && setGithubPickerRepoId(null)}
        repoId={githubPickerRepoId || ""}
        repoName={githubPickerRepoName}
        onCreateWorkspace={repoActions.handleNewWorkspaceFromGitHub}
      />

      {/* Command Palette (Cmd+K) */}
      <CommandPalette
        hiddenCommands={[
          `chat-view-${chatView(settings)}`,
          ...hiddenAddProjectCommands(windowPlace.location, folderPicker),
          ...(canOpenInApp ? [] : ["open-in-app"]),
          ...(selectedWorkspace ? [] : ["copy-workspace-link"]),
          ...(hasChat ? [] : ["copy-chat-link"]),
          // A workspace from a pull request or branch is local: not from the cloud.
          ...(windowPlace.location === "local" ? [] : ["new-workspace-from"]),
        ]}
        actionOverrides={{
          "chat-view-bubbles": () => showChatView("bubbles"),
          "chat-view-full": () => showChatView("full"),
          "add-from-github": () => handleAddFromGitHub(),
          "open-project": repoActions.handleOpenProject,
          "clone-repository": () => repoActions.setShowCloneModal(true),
          "start-new-project": () => repoActions.setShowStartNewModal(true),
          // A pull request or branch belongs to a project: the one on screen, else the first.
          "new-workspace-from": () => {
            const repoId = selectedWorkspace?.repository_id ?? repos[0]?.id;
            const project = repoGroups.find((g) => g.repo_id === repoId);
            if (!repoId || !project) toast("Add a project first");
            else if (!offersNewFromBranch(windowPlace.location, project))
              toast(
                project.has_folder === false
                  ? `${project.repo_name} is not on this Mac`
                  : `${project.repo_name} is not a GitHub repository`
              );
            else setGithubPickerRepoId(repoId);
          },
          "open-in-app": openInLastApp,
          "copy-workspace-link": () => void copyLink("workspace"),
          "copy-chat-link": () => void copyLink("chat"),
        }}
      />
    </SidebarProvider>
  );
}
