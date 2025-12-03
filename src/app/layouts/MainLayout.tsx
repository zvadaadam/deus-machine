import { useState, useEffect, useRef, useMemo } from "react";
import { toast } from "sonner";
import type { SessionPanelRef } from "@/features/session";
import { NewWorkspaceModal, CloneRepositoryModal } from "@/features/repository";
import type { Repo } from "@/features/repository/types";
import { SystemPromptModal } from "@/features/session";
import { SettingsModal } from "@/features/settings";
import { useKeyboardShortcuts } from "@/shared/hooks";
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
import { Button, SidebarProvider } from "@/components/ui";
import {
  Empty,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
  EmptyDescription,
  EmptyContent,
} from "@/components/ui/empty";
import { AppSidebar, SidebarSkeleton } from "@/features/sidebar";
import { FolderOpen } from "lucide-react";
import { useWorkspaceStore } from "@/features/workspace/store";
import { useUIStore } from "@/shared/stores/uiStore";
import type { Workspace } from "@/shared/types";
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

  // Memoize recent workspaces
  const recentWorkspaces = useMemo(() => {
    return repoGroups
      .flatMap((g) => g.workspaces)
      .sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime())
      .slice(0, 15);
  }, [repoGroups]);

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
      } else if (!targetPath.includes(repoName)) {
        const { join } = await import("@tauri-apps/api/path");
        cloneTarget = await join(targetPath, repoName);
      }

      const { invoke } = await import("@tauri-apps/api/core");
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
          "--sidebar-width": "280px",
          "--sidebar-width-mobile": "280px",
          "--sidebar-width-icon": "3rem",
        } as React.CSSProperties
      }
    >
      {/* Sidebar */}
      {loading ? (
        <SidebarSkeleton />
      ) : repoGroups.length === 0 ? (
        <div className="p-4">
          <Empty className="border-0">
            <EmptyHeader>
              <EmptyMedia>
                <FolderOpen className="text-muted-foreground/40 h-16 w-16" aria-hidden="true" />
              </EmptyMedia>
              <EmptyTitle>No Workspaces</EmptyTitle>
              <EmptyDescription>Create a new workspace to get started</EmptyDescription>
            </EmptyHeader>
            <EmptyContent>
              <Button variant="default" onClick={() => handleNewWorkspace()} size="sm">
                + Create Workspace
              </Button>
            </EmptyContent>
          </Empty>
        </div>
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
        workspaceChatPanelRef={workspaceChatPanelRef}
        recentWorkspaces={recentWorkspaces}
        onCreateWorkspace={openNewWorkspaceModal}
        onOpenProject={handleOpenProject}
        onCloneRepository={() => setShowCloneModal(true)}
        onWorkspaceClick={handleWorkspaceClick}
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
