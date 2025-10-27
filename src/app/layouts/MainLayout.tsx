import { useState, useEffect, useRef, useMemo } from "react";
import { toast } from "sonner";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import { SessionPanel } from "@/features/session";
import type { SessionPanelRef } from "@/features/session";
import { TerminalPanel } from "@/features/terminal";
import {
  NewWorkspaceModal,
  WelcomeView,
  CloneRepositoryModal,
} from "@/features/repository";
import { DiffModal, FileChangesPanel } from "@/features/workspace";
import { SystemPromptModal } from "@/features/session";
import { SettingsModal } from "@/features/settings";
import { BrowserPanel } from "@/features/browser";
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
import {
  useRepos,
  useAddRepo,
} from "@/features/repository/api";
import { useSettings as useSettingsQuery } from "@/features/settings";
import {
  Button,
  Badge,
  EmptyState,
  Skeleton,
  SidebarProvider,
  SidebarInset,
  Tabs,
  TabsList,
  TabsTrigger,
  TabsContent,
} from "@/components/ui";
import { AppSidebar, SidebarSkeleton } from "@/features/sidebar";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { FileText, Package, GitPullRequest, Archive, Square, Globe, Terminal as TerminalIcon, FolderOpen, Sparkles, FileCode, Monitor } from "lucide-react";
import { useWorkspaceStore } from "@/features/workspace/store";
import { useUIStore } from "@/shared/stores/uiStore";
import { WorkspaceHeader } from "./components/WorkspaceHeader";
import type {
  Workspace,
  Repo,
} from "@/shared/types";

/**
 * Main Layout - Application layout with sidebar and workspace panels
 * Manages workspaces, file changes, and git diff visualization
 */

export function MainLayout() {

  // Zustand stores - Global state
  const selectedWorkspace = useWorkspaceStore((state) => state.selectedWorkspace);
  const selectWorkspace = useWorkspaceStore((state) => state.selectWorkspace);

  const {
    showNewWorkspaceModal,
    showSystemPromptModal,
    showSettingsModal,
    diffModal,
    openNewWorkspaceModal,
    closeNewWorkspaceModal,
    openSystemPromptModal,
    closeSystemPromptModal,
    closeSettingsModal,
    openDiffModal,
    closeDiffModal,
  } = useUIStore();

  // TanStack Query hooks - automatic polling and caching
  const workspacesQuery = useWorkspacesByRepo('ready');
  const statsQuery = useStats();

  const repoGroups = workspacesQuery.data || [];
  const stats = statsQuery.data || null;
  const loading = workspacesQuery.isLoading || statsQuery.isLoading;
  const status = workspacesQuery.isError ? 'Error loading workspaces' : 'Connected';

  // Local component state (not global)
  const [selectedRepoId, setSelectedRepoId] = useState('');
  const [creating, setCreating] = useState(false);
  const [loadingDiff, setLoadingDiff] = useState(false);
  const [cloning, setCloning] = useState(false);

  // Ref to Workspace chat panel for inserting text from browser element selector
  const workspaceChatPanelRef = useRef<SessionPanelRef | null>(null);

  // Clone Repository Modal (local state)
  const [showCloneModal, setShowCloneModal] = useState(false);

  // Queries for repos, settings, system prompt
  const reposQuery = useRepos();
  const settingsQuery = useSettingsQuery();
  const systemPromptQuery = useSystemPrompt(selectedWorkspace?.id || null);

  // Local draft state for system prompt modal (controlled component)
  const [systemPromptDraft, setSystemPromptDraft] = useState('');

  // Initialize system prompt draft when modal opens
  useEffect(() => {
    if (showSystemPromptModal && systemPromptQuery.data !== undefined) {
      setSystemPromptDraft(systemPromptQuery.data || '');
    }
  }, [showSystemPromptModal, systemPromptQuery.data]);

  const repos = reposQuery.data || [];
  const username = settingsQuery.data?.user_name || 'Developer';

  // PR status query
  const prStatusQuery = usePRStatus(selectedWorkspace?.id || null);
  const prStatus = prStatusQuery.data || null;

  // Mutations
  const createWorkspaceMutation = useCreateWorkspace();
  const archiveWorkspaceMutation = useArchiveWorkspace();
  const addRepoMutation = useAddRepo();
  const updateSystemPromptMutation = useUpdateSystemPrompt();


  // Repos and settings loaded automatically via TanStack Query

  // Keyboard shortcuts hook
  useKeyboardShortcuts({
    onRefresh: async () => {
      // Refetch all queries
      workspacesQuery.refetch();
      if (selectedWorkspace) {
        prStatusQuery.refetch();
      }
    },
    onEscape: () => {
      if (showNewWorkspaceModal) {
        closeNewWorkspaceModal();
      } else if (diffModal) {
        closeDiffModal();
      } else if (showSystemPromptModal) {
        closeSystemPromptModal();
      }
    },
    selectedWorkspace,
    modalStates: {
      showNewWorkspaceModal,
      selectedFile: diffModal?.file || null,
      showSystemPromptModal,
    },
  });

  // Memoize recent workspaces computation to avoid recalculating on every render
  const recentWorkspaces = useMemo(() => {
    return repoGroups
      .flatMap(g => g.workspaces)
      .sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime())
      .slice(0, 15);
  }, [repoGroups]);

  // Listen for 'insert-to-chat' events from BrowserPanel (element selector)
  useEffect(() => {
    const handleInsertToChat = (event: Event) => {
      if (!(event instanceof CustomEvent)) return;
      const raw = (event.detail as { text?: string } | undefined)?.text;
      const text = typeof raw === 'string' ? raw.trim() : '';
      if (text && workspaceChatPanelRef.current) {
        console.log('[Dashboard] 🎯 Inserting element data to chat');
        workspaceChatPanelRef.current.insertText(text);
      }
    };

    window.addEventListener('insert-to-chat', handleInsertToChat);
    return () => window.removeEventListener('insert-to-chat', handleInsertToChat);
  }, []);

  /**
   * Archive a workspace (sets state to 'archived')
   */
  async function archiveWorkspace(workspaceId: string) {
    try {
      await archiveWorkspaceMutation.mutateAsync(workspaceId);
      console.log('✅ Workspace archived');
      if (selectedWorkspace?.id === workspaceId) {
        selectWorkspace(null);
      }
    } catch (error) {
      console.error('Error archiving workspace:', error);
      toast.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Create a new workspace with git worktree
   */
  async function createWorkspace() {
    if (!selectedRepoId) {
      toast.error('Please select a repository');
      return;
    }

    setCreating(true);
    try {
      const workspace = await createWorkspaceMutation.mutateAsync(selectedRepoId);
      console.log('✅ Workspace created:', workspace.directory_name);

      setSelectedRepoId('');
      closeNewWorkspaceModal();
    } catch (error) {
      console.error('Error creating workspace:', error);
      toast.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setCreating(false);
    }
  }

  /**
   * Select a workspace to view its details
   */
  function handleWorkspaceClick(workspace: Workspace) {
    selectWorkspace(workspace);
  }

  /**
   * Handle creating a new workspace with optional repo pre-selection
   */
  function handleNewWorkspace(repoId?: string) {
    if (repoId) {
      setSelectedRepoId(repoId);
    }
    openNewWorkspaceModal();
  }

  // Note: handleFileClick moved to FileChangesPanel component

  /**
   * Open system prompt editor and load current CLAUDE.md
   */
  async function openSystemPromptEditor() {
    if (!selectedWorkspace) return;
    openSystemPromptModal();
    // System prompt loaded automatically via useSystemPrompt hook
  }

  /**
   * Save system prompt (CLAUDE.md) to workspace
   */
  async function saveSystemPrompt(newPrompt: string) {
    if (!selectedWorkspace) return;

    try {
      await updateSystemPromptMutation.mutateAsync({
        workspaceId: selectedWorkspace.id,
        systemPrompt: newPrompt,
      });
      console.log('✅ System prompt saved');
      closeSystemPromptModal();
    } catch (error) {
      console.error('Failed to save system prompt:', error);
      toast.error(`Failed to save system prompt: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Handle creating a new workspace
   * Opens the NewWorkspaceModal to select a repository
   */
  function handleCreateWorkspace() {
    openNewWorkspaceModal();
  }

  /**
   * Handle opening a project from local folder
   * Uses Tauri dialog picker to select a directory
   */
  async function handleOpenProject() {
    try {
      // Use Tauri's dialog plugin to select a directory
      const { open } = await import('@tauri-apps/plugin-dialog');
      const selected = await open({
        directory: true,
        multiple: false,
        title: 'Select Project Directory',
      });

      if (!selected) {
        // User cancelled
        return;
      }

      const folderPath = typeof selected === 'string' ? selected : (selected as any).path;

      // Add repository via mutation
      const repo = await addRepoMutation.mutateAsync(folderPath);
      console.log('✅ Repository added:', repo);
      toast.success(`Repository "${repo.name}" added successfully!`);
    } catch (error) {
      console.error('Error adding repository:', error);
      toast.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Handle opening clone repository modal
   */
  function handleOpenCloneModal() {
    setShowCloneModal(true);
  }

  /**
   * Handle cloning a repository from GitHub
   */
  async function handleCloneRepository(githubUrl: string, targetPath: string) {
    setCloning(true);
    try {
      // Validate GitHub URL format - accept both HTTPS and SSH
      const sshPattern = /^git@github\.com:[\w-]+\/[\w.-]+(\.git)?$/;
      let isValid = false;
      if (sshPattern.test(githubUrl)) {
        isValid = true;
      } else {
        try {
          const u = new URL(githubUrl);
          const parts = u.pathname.replace(/\.git$/, '').split('/').filter(Boolean);
          isValid = (u.protocol === 'https:' && u.hostname === 'github.com' && parts.length >= 2);
        } catch {}
      }
      if (!isValid) {
        toast.error('Please enter a valid GitHub repository URL (HTTPS or SSH)');
        setCloning(false);
        return;
      }

      // Use Tauri path API to get home directory
      const { homeDir, join } = await import('@tauri-apps/api/path');
      const { exists, mkdir } = await import('@tauri-apps/plugin-fs');
      const homePath = await homeDir();
      const defaultProjectsDir = await join(homePath, 'Projects');

      // Ensure Projects directory exists
      if (!(await exists(defaultProjectsDir))) {
        await mkdir(defaultProjectsDir, { recursive: true });
      }

      // Extract repo name from GitHub URL (works for both HTTPS and SSH)
      let repoName = 'repo';
      if (githubUrl.startsWith('git@')) {
        // SSH format: git@github.com:user/repo.git
        repoName = githubUrl.split(':')[1]?.split('/').pop()?.replace(/\.git$/, '') || 'repo';
      } else {
        // HTTPS format: https://github.com/user/repo.git
        repoName = new URL(githubUrl).pathname.split('/').filter(Boolean).pop()?.replace(/\.git$/, '') || 'repo';
      }
      const cloneTarget = targetPath || await join(defaultProjectsDir, repoName);

      // Validate target path to prevent cloning outside home directory
      const { normalize } = await import('@tauri-apps/api/path');
      const normalizedHome = await normalize(homePath);
      const normalizedTarget = await normalize(cloneTarget);
      const { sep } = await import('@tauri-apps/api/path');
      if (!normalizedTarget.startsWith(normalizedHome + sep) && normalizedTarget !== normalizedHome) {
        toast.error('Please clone inside your home directory');
        setCloning(false);
        return;
      }

      // Clone using git command (via backend or directly)
      // For now, use simple git clone via Node child_process on backend
      // TODO: Implement backend endpoint for git clone

      // Use Tauri shell command for git clone
      const { Command } = await import('@tauri-apps/plugin-shell');
      const output = await Command.create('git', [
        'clone',
        githubUrl,
        cloneTarget
      ]).execute();

      if (output.code !== 0) {
        throw new Error(output.stderr || 'Git clone failed');
      }

      console.log('✅ Repository cloned to:', cloneTarget);

      // Add cloned repository via mutation
      const repo = await addRepoMutation.mutateAsync(cloneTarget);
      console.log('✅ Repository added to database:', repo);

      setShowCloneModal(false);
      toast.success(`Repository "${repo.name}" cloned and added successfully!`);
    } catch (error) {
      console.error('Error cloning repository:', error);
      toast.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
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
        } as React.CSSProperties
      }
    >
      {/* Inset Sidebar - transparent, sits on top of #root background */}
      {loading ? (
        <SidebarSkeleton />
      ) : repoGroups.length === 0 ? (
        <div className="space-standard">
          <EmptyState
            icon={<FolderOpen />}
            title="No Workspaces"
            description="Create a new workspace to get started"
            action={
              <Button
                variant="default"
                onClick={() => handleNewWorkspace()}
                size="sm"
              >
                + Create Workspace
              </Button>
            }
          />
        </div>
      ) : (
        <AppSidebar
          repositories={repoGroups}
          selectedWorkspaceId={selectedWorkspace?.id || null}
          onWorkspaceClick={handleWorkspaceClick}
          onNewWorkspace={handleNewWorkspace}
          onAddRepository={handleOpenProject}
          onArchive={archiveWorkspace}
          profile={{
            username: username
          }}
        />
      )}

      {/* Main Content with SidebarInset */}
      <SidebarInset className="min-w-0">
        <PanelGroup
          direction="horizontal"
          autoSaveId="conductor-root-layout"
          className="flex-1 min-w-0 rounded-lg bg-background/70 backdrop-blur-[20px] border border-border/40 vibrancy-shadow overflow-hidden transition-colors duration-200"
        >
      {/* MAIN CONTENT */}
      <Panel id="center" defaultSize={62} minSize={30} maxSize={75} className="flex flex-col min-h-0 min-w-0 overflow-x-hidden">
        <div className="flex-1 flex flex-col min-h-0 min-w-0">
        {selectedWorkspace ? (
          <>
            {/* Workspace Header */}
            <WorkspaceHeader
              branch={selectedWorkspace.branch}
              workspacePath={`${selectedWorkspace.root_path}/.conductor/${selectedWorkspace.directory_name}`}
            />

            {/* Messages take full area */}
            <div className="flex-1 flex flex-col min-h-0 min-w-0">
              {selectedWorkspace.active_session_id && (
                <SessionPanel
                  ref={workspaceChatPanelRef}
                  sessionId={selectedWorkspace.active_session_id}
                  embedded={true}
                />
              )}
            </div>
          </>
        ) : (
          <WelcomeView
            recentWorkspaces={recentWorkspaces}
            onCreateWorkspace={handleCreateWorkspace}
            onOpenProject={handleOpenProject}
            onCloneRepository={handleOpenCloneModal}
            onWorkspaceClick={handleWorkspaceClick}
          />
        )}
        </div>
      </Panel>

      {/* Only show right panel when workspace is selected */}
      {selectedWorkspace && (
        <>
          <PanelResizeHandle className="relative z-10 w-1.5 h-full flex-none cursor-col-resize select-none touch-none before:content-[''] before:absolute before:top-0 before:bottom-0 before:left-1/2 before:w-0.5 before:-translate-x-1/2 before:bg-border before:transition-colors before:duration-150 hover:before:bg-primary data-[resize-handle-active]:before:bg-primary" />

          {/* RIGHT PANEL - Browser, File Changes & Terminal */}
          <Panel id="right" defaultSize={38} minSize={25} maxSize={70} className="flex flex-col min-h-0 min-w-0 overflow-x-hidden">
        <Tabs defaultValue="browser" className="h-full min-h-0 flex flex-col overflow-hidden">
          <div className="border-b border-border/60 bg-background/50 backdrop-blur-sm">
            <TabsList className="h-11 w-full justify-start rounded-none bg-transparent p-0 px-2 gap-1">
              <TabsTrigger
                value="browser"
                className="relative rounded-t-md rounded-b-none border-b-2 border-b-transparent data-[state=active]:border-b-primary data-[state=active]:bg-primary/5 px-3 py-2 transition-[background-color,border-color] duration-200 ease-out"
              >
                <Globe className="h-4 w-4 mr-2" />
                <span className="text-body-sm font-medium">Browser</span>
              </TabsTrigger>
              <TabsTrigger
                value="changes"
                className="relative rounded-t-md rounded-b-none border-b-2 border-b-transparent data-[state=active]:border-b-primary data-[state=active]:bg-primary/5 px-3 py-2 transition-[background-color,border-color] duration-200 ease-out"
              >
                <FileText className="h-4 w-4 mr-2" />
                <span className="text-body-sm font-medium">Changes</span>
              </TabsTrigger>
              <TabsTrigger
                value="terminal"
                className="relative rounded-t-md rounded-b-none border-b-2 border-b-transparent data-[state=active]:border-b-primary data-[state=active]:bg-primary/5 px-3 py-2 transition-[background-color,border-color] duration-200 ease-out"
              >
                <TerminalIcon className="h-4 w-4 mr-2" />
                <span className="text-body-sm font-medium">Terminal</span>
              </TabsTrigger>
            </TabsList>
          </div>

          {/* Browser Tab */}
          <TabsContent
            value="browser"
            className="m-0 flex-1 overflow-hidden data-[state=active]:flex data-[state=active]:flex-col data-[state=inactive]:hidden"
          >
            {selectedWorkspace ? (
              <BrowserPanel workspaceId={selectedWorkspace.id} />
            ) : (
              <div className="h-full flex items-center justify-center">
                <EmptyState
                  icon={<Globe  />}
                  description="Select a workspace to use the browser"
                />
              </div>
            )}
          </TabsContent>

          {/* File Changes Tab */}
          <TabsContent
            value="changes"
            className="m-0 flex-1 overflow-hidden data-[state=active]:flex data-[state=active]:flex-col data-[state=inactive]:hidden"
          >
            <FileChangesPanel selectedWorkspace={selectedWorkspace} />
          </TabsContent>

          {/* Terminal Tab */}
          <TabsContent
            value="terminal"
            className="m-0 flex-1 overflow-hidden data-[state=active]:flex data-[state=active]:flex-col data-[state=inactive]:hidden"
          >
            {selectedWorkspace ? (
              <TerminalPanel
                workspacePath={`${selectedWorkspace.root_path}/.conductor/${selectedWorkspace.directory_name}`}
                workspaceName={selectedWorkspace.directory_name}
              />
            ) : (
              <div className="h-full flex items-center justify-center">
                <EmptyState
                  icon={<TerminalIcon  />}
                  description="Select a workspace to use the terminal"
                />
              </div>
            )}
          </TabsContent>
        </Tabs>
          </Panel>
        </>
      )}
      </PanelGroup>
      </SidebarInset>

      {/* Modals */}
      <NewWorkspaceModal
        show={showNewWorkspaceModal}
        repos={repos}
        selectedRepoId={selectedRepoId}
        creating={creating}
        onClose={() => closeNewWorkspaceModal()}
        onRepoChange={setSelectedRepoId}
        onCreate={createWorkspace}
      />

      <DiffModal
        selectedFile={diffModal?.file || null}
        fileDiff={diffModal?.diff || ''}
        loading={loadingDiff}
        onClose={closeDiffModal}
      />

      <SystemPromptModal
        show={showSystemPromptModal && !!selectedWorkspace}
        workspaceName={selectedWorkspace?.directory_name || ""}
        systemPrompt={systemPromptDraft}
        loading={systemPromptQuery.isLoading}
        saving={updateSystemPromptMutation.isPending}
        onClose={() => closeSystemPromptModal()}
        onChange={setSystemPromptDraft}
        onSave={() => saveSystemPrompt(systemPromptDraft)}
      />

      <CloneRepositoryModal
        show={showCloneModal}
        cloning={cloning}
        onClose={() => setShowCloneModal(false)}
        onClone={handleCloneRepository}
      />

      <SettingsModal
        show={showSettingsModal}
        onClose={closeSettingsModal}
      />
    </SidebarProvider>
  );
}
