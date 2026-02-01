import { useState, useEffect, useRef } from "react";
import { toast } from "sonner";
import type { SessionPanelRef } from "@/features/session";
import { NewWorkspaceModal, CloneRepositoryModal } from "@/features/repository";
import type { Repo } from "@/features/repository/types";
import { SystemPromptModal } from "@/features/session";
import { SettingsModal } from "@/features/settings";
import { useKeyboardShortcuts, useZoom, useIsFullscreen, useTauriDragZone } from "@/shared/hooks";
import {
  useWorkspacesByRepo,
  useStats,
  usePRStatus,
  useCreateWorkspace,
  useArchiveWorkspace,
  useSystemPrompt,
  useUpdateSystemPrompt,
} from "@/features/workspace/api";
import { useRepos, useAddRepo } from "@/features/repository/api";
import { useSettings as useSettingsQuery } from "@/features/settings";
import { Button, SidebarProvider, Sidebar, SidebarContent } from "@/components/ui";
import { AppSidebar, SidebarSkeleton } from "@/features/sidebar";
import { FolderOpen } from "lucide-react";
import { useWorkspaceStore } from "@/features/workspace/store";
import { useUIStore } from "@/shared/stores/uiStore";
import type { Workspace } from "@/shared/types";
import { invoke } from "@/platform/tauri";
import { MainContent } from "./MainContent";
import { extractErrorMessage, extractRepoNameFromUrl } from "@/shared/lib/utils";

export function MainLayout() {
  // Zustand stores - Global state
  const selectedWorkspace = useWorkspaceStore((state) => state.selectedWorkspace);
  const selectWorkspace = useWorkspaceStore((state) => state.selectWorkspace);

  const {
    showNewWorkspaceModal,
    showSystemPromptModal,
    showSettingsModal,
    openNewWorkspaceModal,
    closeNewWorkspaceModal,
    closeSystemPromptModal,
    closeSettingsModal,
  } = useUIStore();

  // TanStack Query hooks - automatic polling and caching
  const workspacesQuery = useWorkspacesByRepo("ready");
  const statsQuery = useStats();

  const repoGroups = workspacesQuery.data || [];
  const loading = workspacesQuery.isLoading || statsQuery.isLoading;

  // Local component state
  const [selectedRepoId, setSelectedRepoId] = useState("");
  const [creating, setCreating] = useState(false);
  const [cloning, setCloning] = useState(false);
  const [showCloneModal, setShowCloneModal] = useState(false);
  const [cloneError, setCloneError] = useState<string | null>(null);

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
  const username = settingsQuery.data?.user_name || "Developer";

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

  async function archiveWorkspace(workspaceId: string) {
    try {
      await archiveWorkspaceMutation.mutateAsync(workspaceId);
      if (selectedWorkspace?.id === workspaceId) {
        selectWorkspace(null);
      }
    } catch (error) {
      console.error("Error archiving workspace:", error);
      toast.error(extractErrorMessage(error));
    }
  }

  async function createWorkspace() {
    if (!selectedRepoId) {
      toast.error("Please select a repository");
      return;
    }

    setCreating(true);
    try {
      await createWorkspaceMutation.mutateAsync(selectedRepoId);
      setSelectedRepoId("");
      closeNewWorkspaceModal();
    } catch (error) {
      console.error("Error creating workspace:", error);
      toast.error(extractErrorMessage(error));
    } finally {
      setCreating(false);
    }
  }

  function handleWorkspaceClick(workspace: Workspace) {
    selectWorkspace(workspace);
  }

  function handleNewWorkspace(repoId?: string) {
    if (repoId) {
      setSelectedRepoId(repoId);
    }
    openNewWorkspaceModal();
  }

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
      const repo = await addRepoMutation.mutateAsync(folderPath);
      toast.success(`Repository "${repo.name}" added successfully!`);
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
      className="h-screen"
      style={
        {
          "--sidebar-width": "340px",
          "--sidebar-width-mobile": "340px",
        } as React.CSSProperties
      }
    >
      {/* Sidebar */}
      {loading ? (
        <SidebarSkeleton />
      ) : repoGroups.length === 0 ? (
        <Sidebar variant="inset" collapsible="offcanvas" className="p-0">
          <SidebarContent className="flex h-full items-center justify-center">
            <div className="flex flex-col items-center gap-3 text-center">
              <FolderOpen
                className="text-muted-foreground/30 h-10 w-10"
                strokeWidth={1.5}
                aria-hidden="true"
              />
              <div className="space-y-1">
                <p className="text-muted-foreground/70 text-sm font-medium">No Workspaces</p>
                <p className="text-muted-foreground/50 text-xs">Create one to get started</p>
              </div>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => handleNewWorkspace()}
                className="mt-1 text-xs"
              >
                + New Workspace
              </Button>
            </div>
          </SidebarContent>
        </Sidebar>
      ) : (
        <AppSidebar
          repositories={repoGroups}
          selectedWorkspaceId={selectedWorkspace?.id || null}
          onWorkspaceClick={handleWorkspaceClick}
          onNewWorkspace={handleNewWorkspace}
          onAddRepository={handleOpenProject}
          onArchive={archiveWorkspace}
          profile={{ username }}
        />
      )}

      {/* Main Content */}
      <MainContent
        selectedWorkspace={selectedWorkspace}
        prStatus={prStatusQuery.data ?? null}
        workspaceChatPanelRef={workspaceChatPanelRef}
        onCreateWorkspace={openNewWorkspaceModal}
        onOpenProject={handleOpenProject}
        onCloneRepository={() => setShowCloneModal(true)}
      />

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

      <SettingsModal show={showSettingsModal} onClose={closeSettingsModal} />
    </SidebarProvider>
  );
}
