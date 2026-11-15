import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { useDeusCloudSession } from "@/shared/hooks/useDeusCloudSession";
import { api } from "@shared/api";
import { call } from "@/platform/ws";
import type { ThinkingLevel } from "@/shared/agents";
import { CloneRepositoryModal, StartNewProjectModal } from "@/features/repository";
import { SettingsSidebar, SettingsPage } from "@/features/settings";
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
import { useWorkspaceStore, workspaceLayoutActions } from "@/features/workspace/store";
import { openNewWorkspace } from "@/features/workspace/lib/newWorkspace";
import { pendingFirstMessages } from "@/features/workspace/store/workspaceStartStore";
import { useFirstMessageDelivery } from "@/features/session/hooks/useFirstMessageDelivery";
import { useSidebarStore } from "@/features/sidebar/store";
import {
  filterByLocation,
  followSelection,
  workspaceToRestore,
  type WorkspaceLocation,
} from "@/features/sidebar/lib/location";
import { uiActions, useUIStore } from "@/shared/stores/uiStore";
import { ResizeHandle } from "@/shared/components/ResizeHandle";
import type { Workspace } from "@/shared/types";
import { unreadActions } from "@/features/session/store/unreadStore";
import { native } from "@/platform";
import { capabilities } from "@/platform/capabilities";
import { isCloudDirectWebMode } from "@/shared/config/webDirectMode";
import { getLastOpenInAppId } from "@/shared/hooks/useLastOpenInApp";
import { track } from "@/platform/analytics";
import { CommandPalette } from "@/features/command-palette";
import { AutomationsPage, useAutomations } from "@/features/automations";
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
  const storedLocation = useSidebarStore((s) => s.location);

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

  // Where this window's workspaces run. The hosted web app has only the cloud;
  // elsewhere the sidebar lists one location, the rest of the app the full list.
  const webDirect = isCloudDirectWebMode();
  const location: WorkspaceLocation = webDirect ? "cloud" : storedLocation;
  const sidebarRepoGroups = useMemo(
    () => (webDirect ? repoGroups : filterByLocation(repoGroups, location)),
    [webDirect, repoGroups, location]
  );

  // The location follows a newly selected workspace (from anywhere), so the
  // sidebar always contains it; a refresh of the same selection never undoes
  // a manual switch.
  const followedIdRef = useRef<string | null>(null);
  useEffect(() => {
    if (webDirect) return;
    const store = useSidebarStore.getState();
    const next = followSelection(
      { followedId: followedIdRef.current, location: store.location },
      selectedWorkspaceId,
      selectedWorkspace
    );
    if (next.followedId && next.followedId !== followedIdRef.current) {
      store.rememberSelection(next.location, next.followedId);
    }
    followedIdRef.current = next.followedId;
    if (next.location !== store.location) store.setLocation(next.location);
  }, [webDirect, selectedWorkspaceId, selectedWorkspace]);

  const selectedWorkspaceIdRef = useRef(selectedWorkspaceId);
  useEffect(() => {
    selectedWorkspaceIdRef.current = selectedWorkspaceId;
  });

  // Opening a cloud workspace attaches its session channel (Durable Object
  // side — does NOT wake the VM). The snapshot that comes back is how deus
  // learns an old sandbox is paused: the row updates and the chat shows
  // "Sandbox paused — wakes on your next message". Idempotent server-side.
  const selectedCloudWorkspaceId =
    selectedWorkspace?.kind === "cloud" ? selectedWorkspace.id : null;
  useEffect(() => {
    if (!selectedCloudWorkspaceId) return;
    call(api.connectCloudWorkspace, { workspaceId: selectedCloudWorkspaceId }).catch(() => {
      // Best-effort — an unreachable platform just means no truth refresh.
    });
  }, [selectedCloudWorkspaceId]);

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

  // PR status query — gated on GitHub auth, polls while agent is working
  const prStatusQuery = usePRStatus(selectedWorkspace?.id || null, {
    ghInstalled: ghStatusQuery.data?.isInstalled,
    ghAuthenticated: ghStatusQuery.data?.isAuthenticated,
    sessionStatus: selectedWorkspace?.session_status ?? undefined,
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
      thinkingLevel?: ThinkingLevel
    ) => {
      try {
        const workspace = await welcomeCreateMutation.mutateAsync(
          branch || location ? { repositoryId: repoId, source_branch: branch, location } : repoId
        );
        // Store pending message — will be sent when workspace gets a session
        pendingFirstMessages.set(workspace.id, { message, model, thinkingLevel });
        selectWorkspace(workspace.id);
        expandRepo(workspace.repository_id);
        return true;
      } catch (error) {
        console.error("Failed to create workspace from home:", error);
        toast.error(getErrorMessage(error));
        return false;
      }
    },
    [welcomeCreateMutation, selectWorkspace, expandRepo]
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
      pendingEnvSetup.location
    );
  }, [pendingEnvSetup, handleStartWorkspace]);

  // Derive repo name for GitHub picker modal from repoGroups
  const githubPickerRepoName = useMemo(() => {
    if (!githubPickerRepoId) return "";
    const group = repoGroups.find((g) => g.repo_id === githubPickerRepoId);
    return group?.repo_name ?? "";
  }, [githubPickerRepoId, repoGroups]);

  // --- Archive with undo (ref-stable for memoized sidebar items) ---

  const archiveWorkspaceMutation = useArchiveWorkspace();
  const unarchiveMutation = useUnarchiveWorkspace();

  // Ref-stable archive handler: archiveWorkspaceMutation and selectedWorkspace
  // change frequently (every render / every workspace click), so we capture
  // them in refs to keep the callback identity stable. This matters because
  // onArchive flows through the entire sidebar tree to every memoized WorkspaceItem.
  const archiveMutationRef = useRef(archiveWorkspaceMutation);
  const unarchiveMutationRef = useRef(unarchiveMutation);
  const selectedWorkspaceRef = useRef(selectedWorkspace);
  useEffect(() => {
    archiveMutationRef.current = archiveWorkspaceMutation;
    unarchiveMutationRef.current = unarchiveMutation;
    selectedWorkspaceRef.current = selectedWorkspace;
  });

  const archiveWorkspace = useCallback(
    async (workspaceId: string) => {
      try {
        await archiveMutationRef.current.mutateAsync(workspaceId);
        if (selectedWorkspaceRef.current?.id === workspaceId) {
          selectWorkspace(null);
        }
        toast("Workspace archived", {
          duration: 5000,
          action: {
            label: "Undo",
            onClick: () => {
              unarchiveMutationRef.current.mutateAsync(workspaceId).catch((error) => {
                toast.error(getErrorMessage(error));
              });
            },
          },
        });
      } catch (error) {
        console.error("Error archiving workspace:", error);
        toast.error(
          isCloudDirectWebMode()
            ? "Archiving is done from the desktop app for now"
            : getErrorMessage(error)
        );
      }
    },
    [selectWorkspace]
  );

  // --- Workflow status change (ref-stable like archive) ---

  const statusMutation = useUpdateWorkspaceStatus();
  const statusMutationRef = useRef(statusMutation);
  useEffect(() => {
    statusMutationRef.current = statusMutation;
  });

  const handleStatusChange = useCallback(
    (workspaceId: string, status: import("@shared/enums").WorkspaceStatus) => {
      statusMutationRef.current.mutate(
        { workspaceId, status },
        {
          onError: (error) =>
            toast.error(
              isCloudDirectWebMode()
                ? "Workflow status is set from the desktop app for now"
                : getErrorMessage(error)
            ),
        }
      );
    },
    []
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

  function openInLastApp() {
    const lastAppId = getLastOpenInAppId();
    const path = selectedWorkspace?.workspace_path;
    if (lastAppId && path) {
      track("open_in_app", { app_id: lastAppId });
      native.apps.openIn(lastAppId, path).catch((err) => {
        console.warn("[MainLayout] Failed to open workspace in external app:", err);
      });
    }
  }

  const handleWorkspaceClick = useCallback(
    (workspace: Workspace) => {
      // The Automations view overlays MainContent — a workspace click while
      // it is open must land ON the workspace, not silently under the view.
      // Same for the Customize view.
      uiActions.closeAutomations();
      uiActions.closeCustomize();
      selectWorkspace(workspace.id);
      expandRepo(workspace.repository_id);
      // Only mark the active tab's session as read — other tabs keep their
      // unread dots until the user actually switches to them.
      const layout = workspaceLayoutActions.getLayout(workspace.id);
      const activeSessionId = layout.activeChatTabSessionId || workspace.current_session_id;
      if (activeSessionId) {
        unreadActions.markRead(activeSessionId);
      }
    },
    [selectWorkspace, expandRepo]
  );

  // A manual switch (header menu, ⌃1 / ⌃2): back to the workspace last selected
  // there this session, through the row-click path, or Home.
  const repoGroupsRef = useRef(repoGroups);
  useEffect(() => {
    repoGroupsRef.current = repoGroups;
  });
  const switchLocation = useCallback(
    (next: WorkspaceLocation) => {
      const store = useSidebarStore.getState();
      if (next === store.location) return;
      store.setLocation(next);
      const groups = repoGroupsRef.current;
      const restoreId = workspaceToRestore(groups, store.lastSelectedByLocation, next);
      const restore = restoreId
        ? groups.flatMap((g) => g.workspaces).find((w) => w.id === restoreId)
        : undefined;
      if (restore) handleWorkspaceClick(restore);
      else selectWorkspace(null);
    },
    [handleWorkspaceClick, selectWorkspace]
  );

  // Keyboard shortcuts
  useKeyboardShortcuts({
    onRefresh: async () => {
      workspacesQuery.refetch();
      if (selectedWorkspace) {
        prStatusQuery.refetch();
      }
    },
    onOpenInApp: capabilities.openInExternalApp ? openInLastApp : undefined,
    onSwitchLocation: webDirect ? undefined : switchLocation,
  });

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
          repositories={sidebarRepoGroups}
          location={location}
          onSwitchLocation={webDirect ? undefined : switchLocation}
          selectedWorkspaceId={selectedWorkspace?.id || null}
          diffStatsMap={bulkDiffStatsQuery.data}
          onWorkspaceClick={handleWorkspaceClick}
          onNewWorkspace={handleNewWorkspace}
          newWorkspaceActive={!selectedWorkspace && !automationsOpen && !customizeOpen}
          onNewWorkspaceFromGitHub={setGithubPickerRepoId}
          onAddRepository={repoActions.handleOpenProject}
          onCloneRepository={() => repoActions.setShowCloneModal(true)}
          onStartNewProject={() => repoActions.setShowStartNewModal(true)}
          // Archive + workflow status are Mac-backend mutations; web-direct has no
          // transport for them, so the sidebar gets no handlers and never renders the
          // hover archive button or the status menu (the toasts above stay as a net).
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
      ) : (
        <MainContent
          selectedWorkspace={selectedWorkspace}
          prStatus={prStatusQuery.data ?? null}
          ghStatus={ghStatusQuery.data}
          onOpenProject={repoActions.handleOpenProject}
          onCloneRepository={() => repoActions.setShowCloneModal(true)}
          onStartNewProject={() => repoActions.setShowStartNewModal(true)}
          repos={repos}
          repoGroups={repoGroups}
          repoGroupsLoading={workspacesQuery.isLoading}
          repoGroupsError={workspacesQuery.isError ? getErrorMessage(workspacesQuery.error) : null}
          onStartWorkspace={handleStartWorkspace}
          onWorkspaceClick={handleWorkspaceClick}
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
        actionOverrides={{
          "open-project": repoActions.handleOpenProject,
          "clone-repository": () => repoActions.setShowCloneModal(true),
          "start-new-project": () => repoActions.setShowStartNewModal(true),
          // A pull request or branch belongs to a project: the one on screen, else the first.
          "new-workspace-from": () => {
            const repoId = selectedWorkspace?.repository_id ?? repos[0]?.id;
            if (repoId) setGithubPickerRepoId(repoId);
            else toast("Add a project first");
          },
          "open-in-app": openInLastApp,
        }}
      />
    </SidebarProvider>
  );
}
