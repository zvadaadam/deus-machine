import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { useDeusCloudSession } from "@/shared/hooks/useDeusCloudSession";
import { apiClient } from "@/shared/api/client";
import type { SessionPanelRef } from "@/features/session";
import {
  NewWorkspaceModal,
  NewWorkspacePromptModal,
  CloneRepositoryModal,
  StartNewProjectModal,
} from "@/features/repository";
import { SystemPromptModal } from "@/features/session";
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
import { useSidebarStore } from "@/features/sidebar/store";
import { useUIStore } from "@/shared/stores/uiStore";
import { ResizeHandle } from "@/shared/components/ResizeHandle";
import type { Workspace } from "@/shared/types";
import { unreadActions } from "@/features/session/store/unreadStore";
import { native } from "@/platform";
import { capabilities } from "@/platform/capabilities";
import { getLastOpenInAppId } from "@/shared/hooks/useLastOpenInApp";
import { track } from "@/platform/analytics";
import { CommandPalette } from "@/features/command-palette";
import { AutomationsPage, useAutomations } from "@/features/automations";
import { CONFIGURE_CLOUD_ENV } from "@/features/session/lib/sessionPrompts";
import { getStoredModel } from "@/features/repository/ui/HomeView";
import { DEFAULT_MODEL } from "@/shared/agents";
import { GitHubPickerModal } from "@/features/sidebar/ui/GitHubPickerModal";
import { useConnectionStateInit } from "@/features/connection";
import { MainContent } from "./MainContent";
import { useRepoActions } from "./hooks/useRepoActions";
import { useSystemPrompt, useUpdateSystemPrompt } from "@/features/workspace/api";
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

  const showNewWorkspaceModal = useUIStore((s) => s.showNewWorkspaceModal);
  const newWorkspaceMode = useUIStore((s) => s.newWorkspaceMode);
  const newWorkspaceDraft = useUIStore((s) => s.newWorkspaceDraft);
  const showSystemPromptModal = useUIStore((s) => s.showSystemPromptModal);
  const settingsOpen = useUIStore((s) => s.settingsOpen);
  const automationsOpen = useUIStore((s) => s.automationsOpen);
  const openAutomations = useUIStore((s) => s.openAutomations);
  const openNewWorkspaceModal = useUIStore((s) => s.openNewWorkspaceModal);
  const closeNewWorkspaceModal = useUIStore((s) => s.closeNewWorkspaceModal);
  const closeSystemPromptModal = useUIStore((s) => s.closeSystemPromptModal);

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
    apiClient.post(`/workspaces/${selectedCloudWorkspaceId}/cloud-connect`).catch(() => {
      // Best-effort — an unreachable platform just means no truth refresh.
    });
  }, [selectedCloudWorkspaceId]);

  // Bulk-fetch diff stats for all workspaces (replaces per-item useDiffStats in sidebar)
  const bulkDiffStatsQuery = useBulkDiffStats(repoGroups);

  // Sidebar resize: null = default 344px, number = user-set width
  const [sidebarWidth, setSidebarWidth] = useState<number | null>(null);
  // Tracks drag state to disable sidebar CSS transitions during resize
  const [sidebarDragging, setSidebarDragging] = useState(false);

  // GitHub picker modal state
  const [githubPickerRepoId, setGithubPickerRepoId] = useState<string | null>(null);

  // Ref for inserting text from browser element selector
  const workspaceChatPanelRef = useRef<SessionPanelRef | null>(null);

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

  const repoActions = useRepoActions({
    selectWorkspace,
    openNewWorkspaceModal,
    closeNewWorkspaceModal,
  });

  // --- Home screen send flow ---
  // When the user sends a message from the home screen, we:
  // 1. Create a workspace for the selected repo
  // 2. Select it (transitions to two-panel layout)
  // 3. Queue the message to be sent once the workspace has a session
  const welcomeCreateMutation = useCreateWorkspace();
  // Keyed by workspace: a single slot meant the NEXT started workspace stole
  // the pending prompt — most damagingly the environment-setup turn, which
  // then silently never ran. Delivery stays selection-gated (the send rides
  // the selected panel's ref), so an entry simply waits until its workspace
  // is selected again.
  const pendingWelcomeMessagesRef = useRef(new Map<string, { message: string; model: string }>());
  const welcomeSendsInFlightRef = useRef(new Set<string>());

  const handleStartWorkspace = useCallback(
    async (
      repoId: string,
      message: string,
      model: string,
      branch?: string,
      location?: "local" | "cloud"
    ) => {
      try {
        const workspace = await welcomeCreateMutation.mutateAsync(
          branch || location === "cloud"
            ? { repositoryId: repoId, source_branch: branch, location }
            : repoId
        );
        // Store pending message — will be sent when workspace gets a session
        pendingWelcomeMessagesRef.current.set(workspace.id, { message, model });
        selectWorkspace(workspace.id);
        expandRepo(workspace.repository_id);
      } catch (error) {
        console.error("Failed to create workspace from home:", error);
        toast.error(getErrorMessage(error));
      }
    },
    [welcomeCreateMutation, selectWorkspace, expandRepo]
  );

  // Settings → "Set up with agent": consume the pending request — spin up a
  // cloud workspace on that repo with the environment-onboarding prompt as
  // turn one (the agent persists the recipe via agnt_configure_environment).
  const pendingEnvSetupRepoId = useUIStore((s) => s.pendingEnvSetupRepoId);
  useEffect(() => {
    if (!pendingEnvSetupRepoId) return;
    useUIStore.getState().clearEnvSetupRequest();
    // The setup turn is pinned to Claude regardless of the stored pick — not
    // because the cloud can't run Codex (it can), but because the
    // environment-onboarding prompt is tuned and tested against one agent
    // and this flow must be deterministic.
    const stored = getStoredModel();
    const model = stored.startsWith("claude-code:") ? stored : DEFAULT_MODEL;
    void handleStartWorkspace(
      pendingEnvSetupRepoId,
      CONFIGURE_CLOUD_ENV,
      model,
      undefined,
      "cloud"
    );
  }, [pendingEnvSetupRepoId, handleStartWorkspace]);

  // Effect: when the pending workspace becomes ready with a session, send the queued message.
  // Uses the SessionPanel ref so the message goes through useSendMessage() → optimistic UI.
  // React effect ordering guarantees child useImperativeHandle runs before parent useEffect,
  // so workspaceChatPanelRef.current is set when this fires.
  useEffect(() => {
    if (!selectedWorkspace) return;
    const pending = pendingWelcomeMessagesRef.current.get(selectedWorkspace.id);
    if (!pending) return;
    if (selectedWorkspace.state !== "ready" || !selectedWorkspace.current_session_id) return;
    if (!workspaceChatPanelRef.current) return;

    // Keep the entry until the send RESOLVES: deleting up front turns a
    // transient failure (backend hiccup mid-provision) into a silently lost
    // prompt. The in-flight set stops effect re-runs from double-sending
    // while the first attempt is still settling.
    if (welcomeSendsInFlightRef.current.has(selectedWorkspace.id)) return;
    welcomeSendsInFlightRef.current.add(selectedWorkspace.id);
    const workspaceId = selectedWorkspace.id;
    workspaceChatPanelRef.current
      .sendMessage(pending.message, pending.model)
      .then((sent) => {
        // sendMessage RESOLVES on failure too (it toasts and reports false) —
        // only a true delivery may consume the queued prompt.
        if (sent) pendingWelcomeMessagesRef.current.delete(workspaceId);
      })
      .catch((error) => {
        console.error("Failed to send welcome message:", error);
        toast.error(getErrorMessage(error));
      })
      .finally(() => {
        welcomeSendsInFlightRef.current.delete(workspaceId);
      });
  }, [selectedWorkspace]);

  // Derive repo name for GitHub picker modal from repoGroups
  const githubPickerRepoName = useMemo(() => {
    if (!githubPickerRepoId) return "";
    const group = repoGroups.find((g) => g.repo_id === githubPickerRepoId);
    return group?.repo_name ?? "";
  }, [githubPickerRepoId, repoGroups]);

  // Hide native WebContentsViews when any dialog is open — they render above
  // the DOM so dialogs would appear behind them. BrowserTab's own visible
  // effect handles re-showing when the dialog closes.
  const commandPaletteOpen = useUIStore((s) => s.commandPaletteOpen);
  // Note: <webview> elements stack normally under dialogs/modals — no
  // hideAll IPC dance needed when dialogs open.

  // --- System prompt (inline — small scope, one modal) ---

  const systemPromptQuery = useSystemPrompt(selectedWorkspace?.id || null);
  const updateSystemPromptMutation = useUpdateSystemPrompt();
  // Track user edits separately; reset to null when modal closes so the
  // derived value from the query takes over again (no useEffect + setState).
  const [systemPromptEdit, setSystemPromptEdit] = useState<string | null>(null);
  const systemPromptDraft = systemPromptEdit ?? (systemPromptQuery.data || "");
  const setSystemPromptDraft = useCallback((value: string) => setSystemPromptEdit(value), []);

  async function saveSystemPrompt() {
    if (!selectedWorkspace) return;
    try {
      await updateSystemPromptMutation.mutateAsync({
        workspaceId: selectedWorkspace.id,
        systemPrompt: systemPromptDraft,
      });
      closeSystemPromptModal();
      setSystemPromptEdit(null);
    } catch (error) {
      console.error("Failed to save system prompt:", error);
      toast.error(getErrorMessage(error));
    }
  }

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
        toast.error(getErrorMessage(error));
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
        { onError: (error) => toast.error(getErrorMessage(error)) }
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

  // Keyboard shortcuts
  useKeyboardShortcuts({
    onRefresh: async () => {
      workspacesQuery.refetch();
      if (selectedWorkspace) {
        prStatusQuery.refetch();
      }
    },
    onEscape: () => {
      if (showNewWorkspaceModal) {
        closeNewWorkspaceModal();
      } else if (showSystemPromptModal) {
        closeSystemPromptModal();
      }
    },
    onOpenInApp: capabilities.openInExternalApp ? openInLastApp : undefined,
    selectedWorkspace,
    modalStates: {
      showNewWorkspaceModal,
      showSystemPromptModal,
    },
  });

  const handleWorkspaceClick = useCallback(
    (workspace: Workspace) => {
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
          repositories={repoGroups}
          selectedWorkspaceId={selectedWorkspace?.id || null}
          diffStatsMap={bulkDiffStatsQuery.data}
          onWorkspaceClick={handleWorkspaceClick}
          onNewWorkspace={repoActions.handleNewWorkspace}
          onNewWorkspaceFromGitHub={setGithubPickerRepoId}
          onAddRepository={repoActions.handleOpenProject}
          onCloneRepository={() => repoActions.setShowCloneModal(true)}
          onStartNewProject={() => repoActions.setShowStartNewModal(true)}
          onArchive={archiveWorkspace}
          onStatusChange={handleStatusChange}
          onNewSession={() => selectWorkspace(null)}
          onOpenAutomations={openAutomations}
          automationsActive={automationsOpen}
          profile={sidebarProfile}
        />
      )}

      {/* Sidebar resize handle */}
      <SidebarResizeHandle onSizeChange={setSidebarWidth} onDraggingChange={setSidebarDragging} />

      {/* Main Content — swap between app content, settings and automations */}
      {settingsOpen ? (
        <SettingsPage />
      ) : automationsOpen ? (
        <AutomationsPage />
      ) : (
        <MainContent
          selectedWorkspace={selectedWorkspace}
          prStatus={prStatusQuery.data ?? null}
          ghStatus={ghStatusQuery.data}
          workspaceChatPanelRef={workspaceChatPanelRef}
          onCreateWorkspace={openNewWorkspaceModal}
          onOpenProject={repoActions.handleOpenProject}
          onCloneRepository={() => repoActions.setShowCloneModal(true)}
          onStartNewProject={() => repoActions.setShowStartNewModal(true)}
          repos={repos}
          repoGroups={repoGroups}
          onStartWorkspace={handleStartWorkspace}
          onWorkspaceClick={handleWorkspaceClick}
        />
      )}

      {/* Modals */}
      {newWorkspaceMode === "from-github" ? (
        <NewWorkspaceModal
          show={showNewWorkspaceModal}
          repos={repos}
          selectedRepoId={repoActions.selectedRepoId}
          creating={repoActions.creating}
          onClose={closeNewWorkspaceModal}
          onRepoChange={repoActions.setSelectedRepoId}
          onCreate={() => {
            const repoId = repoActions.selectedRepoId;
            closeNewWorkspaceModal();
            if (repoId) setGithubPickerRepoId(repoId);
          }}
          mode="from-github"
        />
      ) : (
        <NewWorkspacePromptModal
          key={newWorkspaceDraft ?? "blank"}
          initialPrompt={newWorkspaceDraft ?? undefined}
          show={showNewWorkspaceModal}
          repos={repos}
          selectedRepoId={repoActions.selectedRepoId}
          creating={repoActions.creating}
          onClose={closeNewWorkspaceModal}
          onRepoChange={repoActions.setSelectedRepoId}
          onSubmit={({ repoId, prompt, branch, location, model }) => {
            closeNewWorkspaceModal();
            if (prompt) {
              // Composer semantics: create, then the prompt rides as turn one.
              void handleStartWorkspace(repoId, prompt, model, branch, location);
            } else {
              void repoActions.createAndSelectWorkspace(repoId, location, branch);
            }
          }}
        />
      )}

      <SystemPromptModal
        show={showSystemPromptModal && !!selectedWorkspace}
        workspaceName={selectedWorkspace?.slug || ""}
        systemPrompt={systemPromptDraft}
        loading={systemPromptQuery.isLoading}
        saving={updateSystemPromptMutation.isPending}
        onClose={() => {
          closeSystemPromptModal();
          setSystemPromptEdit(null);
        }}
        onChange={setSystemPromptDraft}
        onSave={saveSystemPrompt}
      />

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
          "open-in-app": openInLastApp,
        }}
      />
    </SidebarProvider>
  );
}
