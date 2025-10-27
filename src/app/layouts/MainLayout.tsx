import { useState, useEffect, useRef, useMemo } from "react";
import { toast } from "sonner";
import { SessionPanel } from "@/features/session";
import type { SessionPanelRef } from "@/features/session";
import { TerminalPanel } from "@/features/terminal";
import {
  NewWorkspaceModal,
  WelcomeView,
  CloneRepositoryModal,
} from "@/features/repository";
import { DiffModal, FileChangesPanel, MainContentTabBar } from "@/features/workspace";
import { BrowserPanel } from "@/features/browser";
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
  useSidebar,
} from "@/components/ui";
import { AppSidebar, SidebarSkeleton } from "@/features/sidebar";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { FileText, Package, GitPullRequest, Archive, Square, Terminal as TerminalIcon, FolderOpen, Sparkles, FileCode, Monitor, X } from "lucide-react";
import { useWorkspaceStore } from "@/features/workspace/store";
import { useUIStore } from "@/shared/stores/uiStore";
import { WorkspaceHeader } from "./components/WorkspaceHeader";
import type { Tab } from "@/features/workspace/ui/MainContentTabs";
import type {
  Workspace,
  Repo,
} from "@/shared/types";

/**
 * Main Content Component - CSS Grid layout with browser-style tabs
 * Grid structure: [Main Content (flexible)] [Right Panel (400px)]
 */
function MainContent({
  selectedWorkspace,
  workspaceChatPanelRef,
  recentWorkspaces,
  rightPanelTab,
  onRightPanelTabChange,
  onCreateWorkspace,
  onOpenProject,
  onCloneRepository,
  onWorkspaceClick,
}: {
  selectedWorkspace: Workspace | null;
  workspaceChatPanelRef: React.RefObject<SessionPanelRef | null>;
  recentWorkspaces: Workspace[];
  rightPanelTab: 'changes' | 'terminal';
  onRightPanelTabChange: (tab: 'changes' | 'terminal') => void;
  onCreateWorkspace: () => void;
  onOpenProject: () => void;
  onCloneRepository: () => void;
  onWorkspaceClick: (workspace: Workspace) => void;
}) {
  const { setOpen: setSidebarOpen } = useSidebar();

  // State for main content tabs (chat sessions)
  const [mainTabs, setMainTabs] = useState<Tab[]>([
    { id: 'chat-1', label: 'Chat #1', type: 'chat', closeable: false }
  ]);
  const [activeMainTabId, setActiveMainTabId] = useState('chat-1');

  // State for browser overlay
  const [isBrowserOpen, setIsBrowserOpen] = useState(false);

  // Collapse sidebar when browser opens (but allow manual toggle)
  useEffect(() => {
    if (isBrowserOpen) {
      setSidebarOpen(false);
    }
    // Don't auto-restore sidebar when browser closes - let user control it
  }, [isBrowserOpen, setSidebarOpen]);

  // Handle browser toggle
  const handleBrowserToggle = () => {
    setIsBrowserOpen(prev => !prev);
  };

  // Handle tab changes
  const handleMainTabChange = (tabId: string) => {
    setActiveMainTabId(tabId);
  };

  // Handle tab close
  const handleMainTabClose = (tabId: string) => {
    const newTabs = mainTabs.filter(t => t.id !== tabId);
    setMainTabs(newTabs);
    // If closing active tab, switch to first tab
    if (tabId === activeMainTabId && newTabs.length > 0) {
      setActiveMainTabId(newTabs[0].id);
    }
  };

  // Handle add new tab
  const handleMainTabAdd = () => {
    const newId = `chat-${mainTabs.length + 1}`;
    const newTab: Tab = {
      id: newId,
      label: `Chat #${mainTabs.length + 1}`,
      type: 'chat',
      closeable: true
    };
    setMainTabs([...mainTabs, newTab]);
    setActiveMainTabId(newId);
  };

  return (
    <SidebarInset className="min-w-0">
      {/**
       * CSS Grid Layout: Main Content | Right Panel/Browser
       *
       * Architecture:
       * - When browser closed: Main (flex) | Right Panel (400px)
       * - When browser open: Main (flex, shrunk) | Browser (400px)
       * - Browser replaces right panel in the grid to naturally shrink main content
       */}
      <div
        className="flex-1 min-w-0 rounded-lg bg-background/70 backdrop-blur-[20px] border border-border/40 vibrancy-shadow overflow-hidden transition-colors duration-200"
        style={{
          display: 'grid',
          gridTemplateColumns: selectedWorkspace
            ? isBrowserOpen
              ? 'minmax(400px, 1fr) 400px'  // Main (shrunk) | Browser
              : 'minmax(500px, 1fr) 400px'   // Main | Right Panel
            : '1fr',
          height: '100%',
          gap: '0',
        }}
      >
        {/* MAIN CONTENT AREA - Browser-style tabs for chat sessions */}
        {selectedWorkspace ? (
          <div className="flex flex-col h-full overflow-hidden border-r border-border/40">
            {/* 1. Workspace Header - Fixed height (branch name, browser button) */}
            <WorkspaceHeader
              branch={selectedWorkspace.branch}
              workspacePath={`${selectedWorkspace.root_path}/.conductor/${selectedWorkspace.directory_name}`}
              onBrowserToggle={handleBrowserToggle}
              showBrowserButton={true}
            />

            {/* 2. Tab Bar - Fixed height (Chat #1, Chat #2, +) */}
            <MainContentTabBar
              tabs={mainTabs}
              activeTabId={activeMainTabId}
              onTabChange={handleMainTabChange}
              onTabClose={handleMainTabClose}
              onTabAdd={handleMainTabAdd}
            />

            {/* 3. Tab Content - Flexible height, scrollable (SessionPanel) */}
            <div className="flex-1 min-h-0 overflow-hidden flex flex-col">
              {selectedWorkspace.active_session_id && (
                <SessionPanel
                  ref={workspaceChatPanelRef}
                  sessionId={selectedWorkspace.active_session_id}
                  embedded={true}
                />
              )}
            </div>
          </div>
        ) : (
          <WelcomeView
            recentWorkspaces={recentWorkspaces}
            onCreateWorkspace={onCreateWorkspace}
            onOpenProject={onOpenProject}
            onCloneRepository={onCloneRepository}
            onWorkspaceClick={onWorkspaceClick}
          />
        )}

        {/* RIGHT PANEL OR BROWSER - Mutually exclusive in grid */}
        {selectedWorkspace && (
          isBrowserOpen ? (
            /* BROWSER - Slides in with animation, replaces right panel in grid */
            <div
              className="flex flex-col h-full overflow-hidden bg-background border-l border-border/40 animate-in slide-in-from-right duration-300"
              style={{
                animation: 'slideInFromRight 300ms cubic-bezier(0.23, 1, 0.32, 1)'
              }}
            >
              {/* Browser Header */}
              <div className="flex items-center justify-between px-4 py-3 border-b border-border/60 bg-background/50 backdrop-blur-sm flex-shrink-0">
                <h2 className="text-lg font-semibold text-foreground">Browser</h2>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => setIsBrowserOpen(false)}
                  className="h-8 w-8"
                  title="Close browser"
                >
                  <X className="h-4 w-4" />
                </Button>
              </div>

              {/* Browser Content */}
              <div className="flex-1 overflow-hidden">
                <BrowserPanel workspaceId={selectedWorkspace.id} />
              </div>
            </div>
          ) : (
            /* RIGHT PANEL - Changes & Terminal */
            <div className="flex flex-col h-full overflow-hidden">
              <Tabs value={rightPanelTab} onValueChange={(v) => onRightPanelTabChange(v as any)} className="h-full flex flex-col overflow-hidden">
                <div className="border-b border-border/60 bg-background/50 backdrop-blur-sm flex-shrink-0">
                  <TabsList className="h-11 w-full justify-start rounded-none bg-transparent p-0 px-2 gap-1">
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
                  <TerminalPanel
                    workspacePath={`${selectedWorkspace.root_path}/.conductor/${selectedWorkspace.directory_name}`}
                    workspaceName={selectedWorkspace.directory_name}
                  />
                </TabsContent>
              </Tabs>
            </div>
          )
        )}
      </div>
    </SidebarInset>
  );
}

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

  // Right panel active tab (Changes or Terminal only - Browser is now a separate overlay)
  const [rightPanelTab, setRightPanelTab] = useState<'changes' | 'terminal'>('changes');

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
      <MainContent
        selectedWorkspace={selectedWorkspace}
        workspaceChatPanelRef={workspaceChatPanelRef}
        recentWorkspaces={recentWorkspaces}
        rightPanelTab={rightPanelTab}
        onRightPanelTabChange={setRightPanelTab}
        onCreateWorkspace={handleCreateWorkspace}
        onOpenProject={handleOpenProject}
        onCloneRepository={handleOpenCloneModal}
        onWorkspaceClick={handleWorkspaceClick}
      />

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
