import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import type { SessionPanelRef } from "@/features/session";
import {
  NewWorkspaceModal,
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
import { useSettings as useSettingsQuery } from "@/features/settings";
import { SidebarProvider, useSidebar } from "@/components/ui";
import { AppSidebar, SidebarSkeleton } from "@/features/sidebar";
import { useWorkspaceStore, workspaceLayoutActions } from "@/features/workspace/store";
import { useSidebarStore } from "@/features/sidebar/store";
import { useUIStore } from "@/shared/stores/uiStore";
import {
  useChatInsertStore,
  chatInsertActions,
  deliverChatInsertPayload,
  deserializeChatInsertPayload,
  isChatInsertForWorkspace,
} from "@/shared/stores/chatInsertStore";
import { ResizeHandle } from "@/shared/components/ResizeHandle";
import type { Workspace } from "@/shared/types";
import { unreadActions } from "@/features/session/store/unreadStore";
import { native } from "@/platform";
import { capabilities } from "@/platform/capabilities";
import { getLastOpenInAppId } from "@/shared/hooks/useLastOpenInApp";
import { track } from "@/platform/analytics";
import { CHAT_INSERT } from "@shared/events";
import { CommandPalette } from "@/features/command-palette";
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
  // Zustand stores - Global state (ID-only; full object derived from React Query below)
  const selectedWorkspaceId = useWorkspaceStore((state) => state.selectedWorkspaceId);
  const selectWorkspace = useWorkspaceStore((state) => state.selectWorkspace);
  const expandRepo = useSidebarStore((s) => s.expandRepo);

  const showNewWorkspaceModal = useUIStore((s) => s.showNewWorkspaceModal);
  const newWorkspaceMode = useUIStore((s) => s.newWorkspaceMode);
  const showSystemPromptModal = useUIStore((s) => s.showSystemPromptModal);
  const settingsOpen = useUIStore((s) => s.settingsOpen);
  const openNewWorkspaceModal = useUIStore((s) => s.openNewWorkspaceModal);
  const closeNewWorkspaceModal = useUIStore((s) => s.closeNewWorkspaceModal);
  const closeSystemPromptModal = useUIStore((s) => s.closeSystemPromptModal);

  // TanStack Query
  const workspacesQuery = useWorkspacesByRepo();

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

  // Queries for repos, settings
  const reposQuery = useRepos();
  const settingsQuery = useSettingsQuery();

  const repos = reposQuery.data || [];
  const username = settingsQuery.data?.user_name || "My Account";

  // GitHub CLI status — gates PR polling
  const ghStatusQuery = useGhStatus();

  // PR status query — gated on gh CLI, polls while agent is working
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
  const pendingWelcomeMessageRef = useRef<{
    message: string;
    workspaceId: string;
    model: string;
  } | null>(null);

  const handleStartWorkspace = useCallback(
    async (repoId: string, message: string, model: string, branch?: string) => {
      try {
        const workspace = await welcomeCreateMutation.mutateAsync(
          branch ? { repositoryId: repoId, source_branch: branch } : repoId
        );
        // Store pending message — will be sent when workspace gets a session
        pendingWelcomeMessageRef.current = {
          message,
          workspaceId: workspace.id,
          model,
        };
        selectWorkspace(workspace.id);
        expandRepo(workspace.repository_id);
      } catch (error) {
        console.error("Failed to create workspace from home:", error);
        toast.error(getErrorMessage(error));
        pendingWelcomeMessageRef.current = null;
      }
    },
    [welcomeCreateMutation, selectWorkspace, expandRepo]
  );

  // Effect: when the pending workspace becomes ready with a session, send the queued message.
  // Uses the SessionPanel ref so the message goes through useSendMessage() → optimistic UI.
  // React effect ordering guarantees child useImperativeHandle runs before parent useEffect,
  // so workspaceChatPanelRef.current is set when this fires.
  useEffect(() => {
    const pending = pendingWelcomeMessageRef.current;
    if (!pending) return;
    if (!selectedWorkspace) return;
    if (selectedWorkspace.id !== pending.workspaceId) return;
    if (selectedWorkspace.state !== "ready" || !selectedWorkspace.current_session_id) return;
    if (!workspaceChatPanelRef.current) return;

    pendingWelcomeMessageRef.current = null;
    workspaceChatPanelRef.current.sendMessage(pending.message, pending.model).catch((error) => {
      console.error("Failed to send welcome message:", error);
      toast.error(getErrorMessage(error));
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
  const anyDialogOpen =
    showNewWorkspaceModal ||
    showSystemPromptModal ||
    commandPaletteOpen ||
    !!githubPickerRepoId ||
    repoActions.showCloneModal ||
    repoActions.showStartNewModal;
  useEffect(() => {
    if (anyDialogOpen) {
      native.browserViews.hideAll().catch(() => {});
    }
  }, [anyDialogOpen]);

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
      native.apps.openIn(lastAppId, path).catch(() => {});
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

  // Subscribe to chatInsertStore for content dispatched from BrowserPanel / DiffViewer / SimulatorPanel
  useEffect(() => {
    const unsubStore = useChatInsertStore.subscribe((state, prevState) => {
      if (!state.pending || state.pending === prevState.pending) return;

      const payload = state.pending;
      chatInsertActions.consume();

      if (!workspaceChatPanelRef.current) return;
      if (!isChatInsertForWorkspace(payload, selectedWorkspaceIdRef.current)) return;

      deliverChatInsertPayload(workspaceChatPanelRef.current, payload);
    });

    const unlistenChat = native.events.on(CHAT_INSERT, (data) => {
      void deserializeChatInsertPayload(data)
        .then((payload) => {
          chatInsertActions.dispatch(payload);
        })
        .catch((error) => {
          console.error("Failed to deserialize detached chat insert:", error);
        });
    });

    return () => {
      unsubStore();
      unlistenChat();
    };
  }, []);

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
          profile={{ username }}
        />
      )}

      {/* Sidebar resize handle */}
      <SidebarResizeHandle onSizeChange={setSidebarWidth} onDraggingChange={setSidebarDragging} />

      {/* Main Content — swap between app content and settings page */}
      {settingsOpen ? (
        <SettingsPage />
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
          onStartWorkspace={handleStartWorkspace}
        />
      )}

      {/* Modals */}
      <NewWorkspaceModal
        show={showNewWorkspaceModal}
        repos={repos}
        selectedRepoId={repoActions.selectedRepoId}
        creating={repoActions.creating}
        onClose={closeNewWorkspaceModal}
        onRepoChange={repoActions.setSelectedRepoId}
        onCreate={
          newWorkspaceMode === "from-github"
            ? () => {
                const repoId = repoActions.selectedRepoId;
                closeNewWorkspaceModal();
                if (repoId) setGithubPickerRepoId(repoId);
              }
            : repoActions.createWorkspaceFromModal
        }
        mode={newWorkspaceMode}
      />

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
