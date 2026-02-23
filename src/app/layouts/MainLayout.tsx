import { useState, useEffect, useRef, useCallback } from "react";
import { toast } from "sonner";
import type { SessionPanelRef } from "@/features/session";
import { NewWorkspaceModal, CloneRepositoryModal } from "@/features/repository";
import type { Repo } from "@/features/repository/types";
import { SystemPromptModal } from "@/features/session";
import { SettingsSidebar, SettingsPage } from "@/features/settings";
import {
  useKeyboardShortcuts,
  useZoom,
  useIsFullscreen,
  useTauriDragZone,
  useWindowResizing,
} from "@/shared/hooks";
import { useQueryClient } from "@tanstack/react-query";
import {
  useWorkspacesByRepo,
  useStats,
  useBulkDiffStats,
  usePRStatus,
  useGhStatus,
  useCreateWorkspace,
  useArchiveWorkspace,
  useSystemPrompt,
  useUpdateSystemPrompt,
} from "@/features/workspace/api";
import { WorkspaceService } from "@/features/workspace/api/workspace.service";
import { queryKeys } from "@/shared/api/queryKeys";
import { useResizeHandle } from "@/features/workspace";
import { useRepos, useAddRepo } from "@/features/repository/api";
import { useSettings as useSettingsQuery } from "@/features/settings";
import { SidebarProvider, useSidebar } from "@/components/ui";
import { AppSidebar, SidebarSkeleton } from "@/features/sidebar";
import { useWorkspaceStore } from "@/features/workspace/store";
import { useUIStore } from "@/shared/stores/uiStore";
import { ResizeHandle } from "@/shared/components/ResizeHandle";
import type { Workspace } from "@/shared/types";
import { invoke } from "@/platform/tauri";
import { CommandPalette } from "@/features/command-palette";
import { MainContent } from "./MainContent";
import { extractErrorMessage, extractRepoNameFromUrl } from "@/shared/lib/utils";
import { createOptimisticWorkspace } from "@/features/workspace/lib/workspace.utils";

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
  // Zustand stores - Global state
  const selectedWorkspace = useWorkspaceStore((state) => state.selectedWorkspace);
  const selectWorkspace = useWorkspaceStore((state) => state.selectWorkspace);

  const showNewWorkspaceModal = useUIStore((s) => s.showNewWorkspaceModal);
  const showSystemPromptModal = useUIStore((s) => s.showSystemPromptModal);
  const settingsOpen = useUIStore((s) => s.settingsOpen);
  const openNewWorkspaceModal = useUIStore((s) => s.openNewWorkspaceModal);
  const closeNewWorkspaceModal = useUIStore((s) => s.closeNewWorkspaceModal);
  const closeSystemPromptModal = useUIStore((s) => s.closeSystemPromptModal);

  // TanStack Query
  const queryClient = useQueryClient();
  const workspacesQuery = useWorkspacesByRepo();
  const statsQuery = useStats();

  const repoGroups = workspacesQuery.data || [];
  const loading = workspacesQuery.isLoading || statsQuery.isLoading;

  // Sync Zustand selectedWorkspace with React Query data.
  // The store holds a snapshot from when the user clicked — it goes stale when
  // the backend updates workspace fields (state, active_session_id, session_status).
  // Without this sync, ChatArea never sees the session created by the init pipeline.
  useEffect(() => {
    if (!selectedWorkspace || !repoGroups.length) return;
    const fresh = repoGroups
      .flatMap((g) => g.workspaces)
      .find((w) => w.id === selectedWorkspace.id);
    if (!fresh) return;
    if (
      fresh.active_session_id !== selectedWorkspace.active_session_id ||
      fresh.state !== selectedWorkspace.state ||
      fresh.session_status !== selectedWorkspace.session_status ||
      fresh.init_step !== selectedWorkspace.init_step
    ) {
      // When workspace transitions to "ready", clear any stale diff caches.
      // During "initializing", incomplete git state can produce garbage diffs
      // that get cached. Clearing ensures the first "ready" fetch is clean.
      if (selectedWorkspace.state === "initializing" && fresh.state === "ready") {
        queryClient.removeQueries({ queryKey: queryKeys.workspaces.diffStats(fresh.id) });
        queryClient.removeQueries({ queryKey: queryKeys.workspaces.diffFiles(fresh.id) });
        queryClient.removeQueries({ queryKey: queryKeys.workspaces.uncommittedFiles(fresh.id) });
      }
      selectWorkspace(fresh);
    }
  }, [repoGroups, selectedWorkspace, selectWorkspace, queryClient]);

  // Bulk-fetch diff stats for all workspaces (replaces per-item useDiffStats in sidebar)
  const bulkDiffStatsQuery = useBulkDiffStats(repoGroups);

  // Local component state
  const [selectedRepoId, setSelectedRepoId] = useState("");
  const [creating, setCreating] = useState(false);
  const [cloning, setCloning] = useState(false);
  const [showCloneModal, setShowCloneModal] = useState(false);
  const [cloneError, setCloneError] = useState<string | null>(null);
  const [cloneStatus, setCloneStatus] = useState<string | null>(null);

  // Sidebar resize: null = default 344px, number = user-set width
  const [sidebarWidth, setSidebarWidth] = useState<number | null>(null);
  // Tracks drag state to disable sidebar CSS transitions during resize
  const [sidebarDragging, setSidebarDragging] = useState(false);

  // Ref for inserting text from browser element selector
  const workspaceChatPanelRef = useRef<SessionPanelRef | null>(null);

  // Generation counter: prevents stale clone invocations from mutating state.
  // Each call to handleCloneRepository captures its generation; if the counter
  // advances (via close or a new clone), earlier invocations bail out.
  const cloneGenerationRef = useRef(0);

  // Queries for repos, settings, system prompt
  const reposQuery = useRepos();
  const settingsQuery = useSettingsQuery();
  const systemPromptQuery = useSystemPrompt(selectedWorkspace?.id || null);

  // Local draft state for system prompt modal
  const [systemPromptDraft, setSystemPromptDraft] = useState("");

  // Initialize system prompt draft when modal opens
  useEffect(() => {
    if (showSystemPromptModal && systemPromptQuery.data !== undefined) {
      setSystemPromptDraft(systemPromptQuery.data || "");
    }
  }, [showSystemPromptModal, systemPromptQuery.data]);

  const repos = reposQuery.data || [];
  const username = settingsQuery.data?.user_name || "My Account";

  // GitHub CLI status — gates PR polling (like Codex)
  const ghStatusQuery = useGhStatus();

  // PR status query — gated on gh CLI, polls while agent is working
  const prStatusQuery = usePRStatus(selectedWorkspace?.id || null, {
    ghInstalled: ghStatusQuery.data?.isInstalled,
    ghAuthenticated: ghStatusQuery.data?.isAuthenticated,
    sessionStatus: selectedWorkspace?.session_status ?? undefined,
  });

  // Mutations
  const createWorkspaceMutation = useCreateWorkspace();
  const archiveWorkspaceMutation = useArchiveWorkspace();
  const addRepoMutation = useAddRepo();
  const updateSystemPromptMutation = useUpdateSystemPrompt();

  // Zoom (Cmd+=/Cmd+-/Cmd+0)
  useZoom();

  // Track fullscreen state — toggles `.fullscreen` class on <html> for CSS
  useIsFullscreen();

  // Global drag zone — window-level mousedown in the top 48px triggers
  // startDragging(), mirroring Arc's full-width transparent overlay approach.
  useTauriDragZone();

  // Disable CSS transitions during native window resize to prevent content "sticking"
  useWindowResizing();

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
    selectedWorkspace,
    modalStates: {
      showNewWorkspaceModal,
      showSystemPromptModal,
    },
  });

  // Listen for 'insert-to-chat' events from BrowserPanel / DiffViewer
  useEffect(() => {
    const handleInsertToChat = (event: Event) => {
      if (!(event instanceof CustomEvent) || !workspaceChatPanelRef.current) return;
      const detail = event.detail as { text?: string; element?: Record<string, unknown>; files?: File[] } | undefined;

      // File attachment (e.g., browser screenshot)
      if (detail?.files?.length) {
        workspaceChatPanelRef.current.addFiles(detail.files);
        return;
      }

      // Element insertion from InSpec mode
      if (detail?.element) {
        workspaceChatPanelRef.current.addInspectedElement(detail.element as {
          ref: string;
          tagName: string;
          path: string;
          innerText?: string;
          context?: "local" | "external";
          reactComponent?: string;
          file?: string;
          line?: string;
          styles?: string;
          props?: string;
          attributes?: string;
          innerHTML?: string;
        });
        return;
      }

      // Plain text insertion (e.g., from DiffViewer)
      const text = typeof detail?.text === "string" ? detail.text.trim() : "";
      if (text) {
        workspaceChatPanelRef.current.insertText(text);
      }
    };

    window.addEventListener("insert-to-chat", handleInsertToChat);
    return () => window.removeEventListener("insert-to-chat", handleInsertToChat);
  }, []);

  // Ref-stable archive handler: archiveWorkspaceMutation and selectedWorkspace
  // change frequently (every render / every workspace click), so we capture
  // them in refs to keep the callback identity stable. This matters because
  // onArchive flows through the entire sidebar tree to every memoized WorkspaceItem.
  const archiveMutationRef = useRef(archiveWorkspaceMutation);
  archiveMutationRef.current = archiveWorkspaceMutation;
  const selectedWorkspaceRef = useRef(selectedWorkspace);
  selectedWorkspaceRef.current = selectedWorkspace;

  const archiveWorkspace = useCallback(
    async (workspaceId: string) => {
      try {
        await archiveMutationRef.current.mutateAsync(workspaceId);
        if (selectedWorkspaceRef.current?.id === workspaceId) {
          selectWorkspace(null);
        }
      } catch (error) {
        console.error("Error archiving workspace:", error);
        toast.error(extractErrorMessage(error));
      }
    },
    [selectWorkspace]
  );

  async function createWorkspace() {
    if (!selectedRepoId) {
      toast.error("Please select a repository");
      return;
    }

    setCreating(true);

    // Optimistically select a placeholder so the UI immediately shows
    // the "Setting up..." state while the backend creates the workspace.
    const repoGroup = repoGroups.find((g) => g.repo_id === selectedRepoId);
    const optimistic = createOptimisticWorkspace(selectedRepoId, repoGroup?.repo_name ?? "");
    const repoIdToCreate = selectedRepoId;
    selectWorkspace(optimistic);
    setSelectedRepoId("");
    closeNewWorkspaceModal();

    try {
      const workspace = await createWorkspaceMutation.mutateAsync(repoIdToCreate);
      selectWorkspace(workspace);
    } catch (error) {
      selectWorkspace(null);
      console.error("Error creating workspace:", error);
      toast.error(extractErrorMessage(error));
    } finally {
      setCreating(false);
    }
  }

  const handleWorkspaceClick = useCallback(
    (workspace: Workspace) => {
      selectWorkspace(workspace);
    },
    [selectWorkspace]
  );

  const handleNewWorkspace = useCallback(
    async (repoId?: string) => {
      // When repoId is known (clicked "+" on a specific repo), skip the modal
      if (repoId) {
        setCreating(true);

        // Optimistically select a placeholder so the UI immediately shows
        // the "Setting up..." state instead of waiting for the HTTP round-trip.
        const repoGroup = repoGroups.find((g) => g.repo_id === repoId);
        const optimistic = createOptimisticWorkspace(repoId, repoGroup?.repo_name ?? "");
        selectWorkspace(optimistic);

        try {
          const workspace = await createWorkspaceMutation.mutateAsync(repoId);
          selectWorkspace(workspace);
        } catch (error) {
          selectWorkspace(null);
          console.error("Error creating workspace:", error);
          toast.error(extractErrorMessage(error));
        } finally {
          setCreating(false);
        }
        return;
      }
      // No repo context — show the modal so user can pick one
      openNewWorkspaceModal();
    },
    [openNewWorkspaceModal, createWorkspaceMutation, selectWorkspace, repoGroups]
  );

  async function saveSystemPrompt(newPrompt: string) {
    if (!selectedWorkspace) return;

    try {
      await updateSystemPromptMutation.mutateAsync({
        workspaceId: selectedWorkspace.id,
        systemPrompt: newPrompt,
      });
      closeSystemPromptModal();
    } catch (error) {
      console.error("Failed to save system prompt:", error);
      toast.error(extractErrorMessage(error));
    }
  }

  async function handleOpenProject() {
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const selected = await open({
        directory: true,
        multiple: false,
        title: "Select Project Directory",
      });

      if (!selected) return;

      const folderPath =
        typeof selected === "string" ? selected : (selected as { path: string }).path;

      let repo: Repo;
      try {
        repo = await addRepoMutation.mutateAsync(folderPath);
      } catch (err) {
        // If repo already exists (409 Conflict), use the existing one.
        // API error shape: { status: 409, details: { error: "...", details: repoObject } }
        const addError = err as { status?: number; details?: { details?: Repo } };
        const existingRepo = addError?.details?.details;
        if (addError?.status === 409 && existingRepo?.id) {
          repo = existingRepo;
        } else {
          throw err;
        }
      }

      // Auto-create first workspace and select it for seamless onboarding
      const workspace = await createWorkspaceMutation.mutateAsync(repo.id);
      selectWorkspace(workspace);
      toast.success(`"${repo.name}" ready`);
    } catch (error) {
      console.error("Error adding repository:", error);
      const message = extractErrorMessage(error);
      toast.error(message);
    }
  }

  async function handleCloneRepository(githubUrl: string, targetPath: string) {
    // Advance generation so any in-flight clone from a previous invocation bails out.
    const generation = ++cloneGenerationRef.current;
    const isStale = () => generation !== cloneGenerationRef.current;

    setCloning(true);
    setCloneError(null);
    setCloneStatus(null);
    try {
      const repoName = extractRepoNameFromUrl(githubUrl);
      if (!repoName) {
        setCloneError("Invalid repository URL");
        setCloning(false);
        return;
      }

      let cloneTarget = targetPath;
      if (!cloneTarget) {
        const { homeDir, join } = await import("@tauri-apps/api/path");
        cloneTarget = await join(await homeDir(), "Developer", repoName);
      } else if (!targetPath.endsWith(repoName) && !targetPath.endsWith(`${repoName}/`)) {
        const { join } = await import("@tauri-apps/api/path");
        cloneTarget = await join(targetPath, repoName);
      }

      // Phase 1: Git clone (progress events shown by modal)
      await invoke("git_clone", { url: githubUrl, targetPath: cloneTarget });
      if (isStale()) return;

      // Phase 2: Register repository
      setCloneStatus("Adding repository...");
      let repo: Repo;
      try {
        repo = await addRepoMutation.mutateAsync(cloneTarget);
      } catch (err) {
        // If repo already exists (409 Conflict), use the existing one.
        // API error shape: { status: 409, details: { error: "...", details: repoObject } }
        const addError = err as { status?: number; details?: { details?: Repo } };
        const existingRepo = addError?.details?.details;
        if (addError?.status === 409 && existingRepo?.id) {
          repo = existingRepo;
        } else {
          throw err;
        }
      }
      if (isStale()) return;

      // Phase 3: Create workspace (returns immediately as 'initializing')
      setCloneStatus("Setting up workspace...");
      const workspace = await createWorkspaceMutation.mutateAsync(repo.id);
      if (isStale()) return;

      // Phase 4: Wait for workspace to become 'ready' (git worktree runs async)
      const readyWorkspace = await waitForWorkspaceReady(workspace.id, isStale);
      if (isStale()) return;

      // Force sidebar to show the new workspace immediately
      await queryClient.refetchQueries({ queryKey: queryKeys.workspaces.all });

      selectWorkspace(readyWorkspace || workspace);
      setShowCloneModal(false);
      setCloneError(null);
      setCloneStatus(null);

      if (readyWorkspace) {
        toast.success(`"${repo.name}" ready`);
      } else {
        toast.info(`"${repo.name}" cloned — workspace is still setting up`);
      }
    } catch (error) {
      if (!isStale()) {
        console.error("Error cloning repository:", error);
        setCloneError(extractErrorMessage(error));
        setCloneStatus(null);
      }
    } finally {
      if (!isStale()) {
        setCloning(false);
      }
    }
  }

  /** Poll workspace until state becomes 'ready' or timeout (15s). */
  async function waitForWorkspaceReady(
    workspaceId: string,
    isStale: () => boolean
  ): Promise<Workspace | null> {
    const maxWaitMs = 15_000;
    const pollMs = 400;
    const deadline = Date.now() + maxWaitMs;

    while (Date.now() < deadline) {
      if (isStale()) return null;
      let ws: Workspace | undefined;
      try {
        ws = await WorkspaceService.fetchById(workspaceId);
      } catch {
        // fetchById failed — backend might be busy, keep trying
      }
      if (ws?.state === "ready") return ws;
      if (ws?.state === "error") throw new Error("Workspace setup failed");
      await new Promise((r) => setTimeout(r, pollMs));
    }
    // Timed out — workspace might still become ready via polling
    return null;
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
          repositories={repoGroups}
          selectedWorkspaceId={selectedWorkspace?.id || null}
          diffStatsMap={bulkDiffStatsQuery.data}
          onWorkspaceClick={handleWorkspaceClick}
          onNewWorkspace={handleNewWorkspace}
          onAddRepository={handleOpenProject}
          onCloneRepository={() => setShowCloneModal(true)}
          onArchive={archiveWorkspace}
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
          onOpenProject={handleOpenProject}
          onCloneRepository={() => setShowCloneModal(true)}
        />
      )}

      {/* Modals */}
      <NewWorkspaceModal
        show={showNewWorkspaceModal}
        repos={repos}
        selectedRepoId={selectedRepoId}
        creating={creating}
        onClose={closeNewWorkspaceModal}
        onRepoChange={setSelectedRepoId}
        onCreate={createWorkspace}
      />

      <SystemPromptModal
        show={showSystemPromptModal && !!selectedWorkspace}
        workspaceName={selectedWorkspace?.directory_name || ""}
        systemPrompt={systemPromptDraft}
        loading={systemPromptQuery.isLoading}
        saving={updateSystemPromptMutation.isPending}
        onClose={closeSystemPromptModal}
        onChange={setSystemPromptDraft}
        onSave={() => saveSystemPrompt(systemPromptDraft)}
      />

      <CloneRepositoryModal
        show={showCloneModal}
        cloning={cloning}
        error={cloneError}
        statusMessage={cloneStatus}
        onClose={() => {
          // Advance generation so any in-flight clone invocation becomes stale
          cloneGenerationRef.current++;
          setShowCloneModal(false);
          setCloneError(null);
          setCloneStatus(null);
          setCloning(false);
        }}
        onClone={handleCloneRepository}
        onClearError={() => setCloneError(null)}
      />

      {/* Command Palette (Cmd+K) */}
      <CommandPalette
        actionOverrides={{
          "open-project": handleOpenProject,
          "clone-repository": () => setShowCloneModal(true),
        }}
      />
    </SidebarProvider>
  );
}
