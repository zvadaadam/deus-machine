import { useState, useEffect, useRef, useCallback } from "react";
import { toast } from "sonner";
import type { SessionPanelRef } from "@/features/session";
import { NewWorkspaceModal, CloneRepositoryModal } from "@/features/repository";
import type { Repo } from "@/features/repository/types";
import { SystemPromptModal } from "@/features/session";
import { SettingsSidebar, SettingsPage } from "@/features/settings";
import { useKeyboardShortcuts, useZoom, useIsFullscreen, useTauriDragZone, useWindowResizing } from "@/shared/hooks";
import {
  useWorkspacesByRepo,
  useStats,
  useBulkDiffStats,
  usePRStatus,
  useCreateWorkspace,
  useArchiveWorkspace,
  useSystemPrompt,
  useUpdateSystemPrompt,
} from "@/features/workspace/api";
import { useResizeHandle } from "@/features/workspace";
import { useRepos, useAddRepo } from "@/features/repository/api";
import { useSettings as useSettingsQuery } from "@/features/settings";
import { Button, SidebarProvider, useSidebar } from "@/components/ui";
import { AppSidebar, SidebarSkeleton } from "@/features/sidebar";
import { useWorkspaceStore } from "@/features/workspace/store";
import { useUIStore } from "@/shared/stores/uiStore";
import { ResizeHandle } from "@/shared/components/ResizeHandle";
import type { Workspace } from "@/shared/types";
import { invoke } from "@/platform/tauri";
import { MainContent } from "./MainContent";
import { extractErrorMessage, extractRepoNameFromUrl } from "@/shared/lib/utils";

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

  // TanStack Query hooks - automatic polling and caching
  const workspacesQuery = useWorkspacesByRepo("ready");
  const statsQuery = useStats();

  const repoGroups = workspacesQuery.data || [];
  const loading = workspacesQuery.isLoading || statsQuery.isLoading;

  // Bulk-fetch diff stats for all workspaces (replaces per-item useDiffStats in sidebar)
  const bulkDiffStatsQuery = useBulkDiffStats(repoGroups);

  // Local component state
  const [selectedRepoId, setSelectedRepoId] = useState("");
  const [creating, setCreating] = useState(false);
  const [cloning, setCloning] = useState(false);
  const [showCloneModal, setShowCloneModal] = useState(false);
  const [cloneError, setCloneError] = useState<string | null>(null);

  // Sidebar resize: null = default 344px, number = user-set width
  const [sidebarWidth, setSidebarWidth] = useState<number | null>(null);
  // Tracks drag state to disable sidebar CSS transitions during resize
  const [sidebarDragging, setSidebarDragging] = useState(false);

  // Ref for inserting text from browser element selector
  const workspaceChatPanelRef = useRef<SessionPanelRef | null>(null);

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

  // PR status query
  const prStatusQuery = usePRStatus(selectedWorkspace?.id || null);

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

  // Listen for 'insert-to-chat' events from BrowserPanel
  useEffect(() => {
    const handleInsertToChat = (event: Event) => {
      if (!(event instanceof CustomEvent)) return;
      const raw = (event.detail as { text?: string } | undefined)?.text;
      const text = typeof raw === "string" ? raw.trim() : "";
      if (text && workspaceChatPanelRef.current) {
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
    try {
      const workspace = await createWorkspaceMutation.mutateAsync(selectedRepoId);
      selectWorkspace(workspace);
      setSelectedRepoId("");
      closeNewWorkspaceModal();
    } catch (error) {
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
    (repoId?: string) => {
      if (repoId) {
        setSelectedRepoId(repoId);
      }
      openNewWorkspaceModal();
    },
    [openNewWorkspaceModal]
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

      const folderPath = typeof selected === "string" ? selected : (selected as any).path;

      let repo: Repo;
      try {
        repo = await addRepoMutation.mutateAsync(folderPath);
      } catch (err) {
        // If repo already exists (409 Conflict), use the existing one
        const addError = err as { status?: number; details?: { repo?: Repo } };
        if (addError?.status === 409 && addError?.details?.repo) {
          repo = addError.details.repo;
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
    setCloning(true);
    setCloneError(null);
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
        cloneTarget = await join(await homeDir(), "Projects", repoName);
      } else if (!targetPath.endsWith(repoName) && !targetPath.endsWith(`${repoName}/`)) {
        const { join } = await import("@tauri-apps/api/path");
        cloneTarget = await join(targetPath, repoName);
      }

      await invoke("git_clone", { url: githubUrl, targetPath: cloneTarget });

      let repo: Repo;
      try {
        repo = await addRepoMutation.mutateAsync(cloneTarget);
      } catch (err) {
        const addError = err as { status?: number; details?: { repo?: Repo } };
        if (addError?.status === 409 && addError?.details?.repo) {
          repo = addError.details.repo;
        } else {
          throw err;
        }
      }

      const workspace = await createWorkspaceMutation.mutateAsync(repo.id);
      selectWorkspace(workspace);
      setShowCloneModal(false);
      setCloneError(null);
      toast.success(`"${repo.name}" ready`);
    } catch (error) {
      console.error("Error cloning repository:", error);
      setCloneError(extractErrorMessage(error));
    } finally {
      setCloning(false);
    }
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
        onClose={() => {
          setShowCloneModal(false);
          setCloneError(null);
        }}
        onClone={handleCloneRepository}
        onClearError={() => setCloneError(null)}
      />
    </SidebarProvider>
  );
}
