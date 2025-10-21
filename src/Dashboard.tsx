import { useState, useEffect, useRef } from "react";
import { toast } from "sonner";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import { WorkspaceChatPanel } from "./WorkspaceChatPanel";
import type { WorkspaceChatPanelRef } from "./WorkspaceChatPanel";
import { TerminalPanel } from "./TerminalPanel";
import { getBaseURL } from "./config/api.config";
import { formatTokenCount } from "./utils";
import {
  NewWorkspaceModal,
  DiffModal,
  SystemPromptModal,
  SettingsModal,
  WelcomeView,
  CloneRepositoryModal,
} from "./features/dashboard/components";
import { BrowserPanel } from "./features/browser/components";
import {
  useDashboardData,
  useFileChanges,
  useKeyboardShortcuts,
} from "./hooks";
import {
  Button,
  Badge,
  EmptyState,
  Skeleton,
  SidebarProvider,
  SidebarInset,
  SidebarTrigger,
  Tabs,
  TabsList,
  TabsTrigger,
  TabsContent,
} from "./components/ui";
import { AppSidebar } from "./components/app-sidebar";
import { Card, CardHeader, CardTitle, CardContent } from "./components/ui/card";
import { Separator } from "./components/ui/separator";
import { FileText, Package, GitPullRequest, Archive, Square, Globe, Terminal as TerminalIcon, FolderOpen, Sparkles, FileCode, Monitor } from "lucide-react";
import { useWorkspaceStore, useUIStore } from "./stores";
import { OpenInDropdown } from "./components/OpenInDropdown";
import { BranchName } from "./components/BranchName";
import type {
  Workspace,
  Repo,
} from "./types";

/**
 * OpenDevs Dashboard - Main application interface
 * Manages workspaces, file changes, and git diff visualization
 */

// BASE_URL is now async - use getBaseURL()

export function Dashboard() {

  // Zustand stores - Global state
  const selectedWorkspace = useWorkspaceStore((state) => state.selectedWorkspace);
  const selectWorkspace = useWorkspaceStore((state) => state.selectWorkspace);
  const diffStats = useWorkspaceStore((state) => state.diffStats);
  const setMultipleDiffStats = useWorkspaceStore((state) => state.setMultipleDiffStats);

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

  // Dashboard data hook - manages workspaces, stats
  const {
    repoGroups,
    stats,
    status,
    loading,
    diffStats: hookDiffStats,
    loadWorkspaces,
    refreshDiffStats,
  } = useDashboardData();

  // Sync hook diffStats to store
  useEffect(() => {
    if (Object.keys(hookDiffStats).length > 0) {
      setMultipleDiffStats(hookDiffStats);
    }
  }, [hookDiffStats, setMultipleDiffStats]);

  // Local component state (not global)
  const [repos, setRepos] = useState<Repo[]>([]);
  const [selectedRepoId, setSelectedRepoId] = useState('');
  const [creating, setCreating] = useState(false);
  const [loadingDiff, setLoadingDiff] = useState(false);

  // Ref to Workspace chat panel for inserting text from browser element selector
  const workspaceChatPanelRef = useRef<WorkspaceChatPanelRef | null>(null);

  // System Prompt Editor (local state - specific to this feature)
  const [systemPrompt, setSystemPrompt] = useState('');
  const [loadingSystemPrompt, setLoadingSystemPrompt] = useState(false);
  const [savingSystemPrompt, setSavingSystemPrompt] = useState(false);

  // Clone Repository Modal (local state)
  const [showCloneModal, setShowCloneModal] = useState(false);
  const [cloning, setCloning] = useState(false);

  // User profile (local state)
  const [username, setUsername] = useState('Developer');

  // File changes hook - manages file changes, PR status, dev servers
  const {
    fileChanges,
    prStatus,
    devServers,
    clearCache,
  } = useFileChanges({
    workspaceId: selectedWorkspace?.id || null,
    diffStats,
  });


  useEffect(() => {
    if (showNewWorkspaceModal && repos.length === 0) {
      (async () => {
        const baseURL = await getBaseURL();
        fetch(`${baseURL}/repos`)
          .then(res => {
            if (!res.ok) throw new Error(`Failed to load repos: ${res.status}`);
            return res.json();
          })
          .then(data => setRepos(data))
          .catch(err => console.error('Failed to load repos:', err));
      })();
    }
  }, [showNewWorkspaceModal, repos.length]);

  // Load username from settings
  useEffect(() => {
    (async () => {
      try {
        const baseURL = await getBaseURL();
        const response = await fetch(`${baseURL}/settings`);
        if (!response.ok) throw new Error(`Failed to load settings: ${response.status}`);
        const settings = await response.json();
        if (settings.user_name) {
          setUsername(settings.user_name);
        }
      } catch (error) {
        console.error('Failed to load username:', error);
      }
    })();
  }, []);

  // Keyboard shortcuts hook
  useKeyboardShortcuts({
    onRefresh: async () => {
      // Refresh workspaces and diffs
      const workspaces = await loadWorkspaces();
      if (workspaces && workspaces.length > 0) {
        const allWorkspaces = workspaces.flatMap((g: any) => g.workspaces);
        await refreshDiffStats(allWorkspaces);
      }

      if (selectedWorkspace) {
        // Clear file changes cache to force reload
        clearCache(selectedWorkspace.id);
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
      const res = await fetch(`${await getBaseURL()}/workspaces/${workspaceId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ state: 'archived' })
      });

      if (!res.ok) {
        throw new Error(`Failed to archive workspace: ${res.statusText}`);
      }

      console.log('✅ Workspace archived');
      // Refresh workspace list
      const workspaces = await loadWorkspaces();
      if (workspaces && workspaces.length > 0) {
        const allWorkspaces = workspaces.flatMap((g: any) => g.workspaces);
        await refreshDiffStats(allWorkspaces);
      }
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
      const res = await fetch(`${await getBaseURL()}/workspaces`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ repository_id: selectedRepoId })
      });

      if (!res.ok) {
        throw new Error(`Failed to create workspace: ${res.statusText}`);
      }

      const workspace = await res.json();
      console.log('✅ Workspace created:', workspace.directory_name);

      setSelectedRepoId('');
      closeNewWorkspaceModal();

      // Refresh workspace list and load diff stats
      const workspaces = await loadWorkspaces();
      if (workspaces && workspaces.length > 0) {
        const allWorkspaces = workspaces.flatMap((g: any) => g.workspaces);
        await refreshDiffStats(allWorkspaces);
      }
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

  /**
   * Load and display diff for a specific file
   */
  async function handleFileClick(file: string) {
    if (!selectedWorkspace) return;

    setLoadingDiff(true);
    openDiffModal(file, ''); // Open with empty diff first

    try {
      const res = await fetch(`${await getBaseURL()}/workspaces/${selectedWorkspace.id}/diff-file?file=${encodeURIComponent(file)}`);
      if (!res.ok) throw new Error(`Failed to load diff: ${res.status}`);
      const data = await res.json();
      openDiffModal(file, data.diff || 'No diff available'); // Update with actual diff
    } catch (error) {
      console.error('Failed to load diff:', error);
      openDiffModal(file, 'Error loading diff');
    } finally {
      setLoadingDiff(false);
    }
  }

  /**
   * Open system prompt editor and load current CLAUDE.md
   */
  async function openSystemPromptEditor() {
    if (!selectedWorkspace) return;

    openSystemPromptModal();
    setLoadingSystemPrompt(true);
    setSystemPrompt('');

    try {
      const res = await fetch(`${await getBaseURL()}/workspaces/${selectedWorkspace.id}/system-prompt`);
      const data = await res.json();
      setSystemPrompt(data.system_prompt || '');
    } catch (error) {
      console.error('Failed to load system prompt:', error);
      toast.error(`Failed to load system prompt: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setLoadingSystemPrompt(false);
    }
  }

  /**
   * Save system prompt (CLAUDE.md) to workspace
   */
  async function saveSystemPrompt() {
    if (!selectedWorkspace) return;

    setSavingSystemPrompt(true);
    try {
      const res = await fetch(`${await getBaseURL()}/workspaces/${selectedWorkspace.id}/system-prompt`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ system_prompt: systemPrompt })
      });

      if (!res.ok) {
        throw new Error('Failed to save system prompt');
      }

      console.log('✅ System prompt saved');
      closeSystemPromptModal();
    } catch (error) {
      console.error('Failed to save system prompt:', error);
      toast.error(`Failed to save system prompt: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setSavingSystemPrompt(false);
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

      const folderPath = typeof selected === 'string' ? selected : selected.path;

      // Call backend to add repository
      const baseURL = await getBaseURL();
      const res = await fetch(`${baseURL}/repos`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ root_path: folderPath })
      });

      if (!res.ok) {
        const error = await res.json();
        throw new Error(error.error || 'Failed to add repository');
      }

      const repo = await res.json();
      console.log('✅ Repository added:', repo);

      // Refresh workspace list
      const workspaces = await loadWorkspaces();
      if (workspaces && workspaces.length > 0) {
        const allWorkspaces = workspaces.flatMap((g: any) => g.workspaces);
        await refreshDiffStats(allWorkspaces);
      }

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
      const httpsPattern = /^https:\/\/github\.com\/[\w-]+\/[\w.-]+(\.git)?$/;
      const sshPattern = /^git@github\.com:[\w-]+\/[\w.-]+(\.git)?$/;
      if (!httpsPattern.test(githubUrl) && !sshPattern.test(githubUrl)) {
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

      // Validate target path to prevent cloning into sensitive directories
      const sensitivePatterns = [
        '/System', '/usr', '/bin', '/etc', '/var',
        await join(homePath, '.ssh'),
        await join(homePath, '.config')
      ];

      const normalizedTarget = cloneTarget.toLowerCase();
      if (sensitivePatterns.some(p => normalizedTarget.startsWith(p.toLowerCase()))) {
        toast.error('Cannot clone to system directories');
        setCloning(false);
        return;
      }

      // Clone using git command (via backend or directly)
      // For now, use simple git clone via Node child_process on backend
      // TODO: Implement backend endpoint for git clone

      const baseURL = await getBaseURL();

      // For now, let's use a workaround: shell command via Tauri
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

      // Add cloned repository to database
      const res = await fetch(`${baseURL}/repos`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ root_path: cloneTarget })
      });

      if (!res.ok) {
        const error = await res.json();
        throw new Error(error.error || 'Failed to add repository');
      }

      const repo = await res.json();
      console.log('✅ Repository added to database:', repo);

      // Refresh workspace list
      const workspaces = await loadWorkspaces();
      if (workspaces && workspaces.length > 0) {
        const allWorkspaces = workspaces.flatMap((g: any) => g.workspaces);
        await refreshDiffStats(allWorkspaces);
      }

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
    <SidebarProvider>
      {/* Inset Sidebar - transparent, sits on top of #root background */}
      {loading ? (
        <div className="p-4 space-y-3">
          <Skeleton className="h-6 w-full" />
          <Skeleton className="h-4 w-4/5" />
          <Skeleton className="h-4 w-[90%]" />
          <Skeleton className="h-4 w-3/4" />
        </div>
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
          diffStats={diffStats}
          onWorkspaceClick={handleWorkspaceClick}
          onNewWorkspace={handleNewWorkspace}
          onAddRepository={() => selectWorkspace(null)}
          onArchive={archiveWorkspace}
          profile={{
            username: username
          }}
        />
      )}

      {/* Main Content with SidebarInset - tight spacing for modern feel */}
      <SidebarInset className="min-h-0 min-w-0 overflow-hidden">
        <div className="flex flex-1 flex-col gap-2 pt-2 pr-2 pb-2 min-h-0">
          <PanelGroup
            direction="horizontal"
            autoSaveId="conductor-root-layout"
            className="flex-1 rounded-lg bg-white/70 dark:bg-black/60 backdrop-blur-[20px] border border-border/40 vibrancy-shadow overflow-hidden transition-colors duration-200 min-h-0"
          >
      {/* MAIN CONTENT */}
      <Panel id="center" minSize={30} className="flex flex-col min-h-0 min-w-0 overflow-x-hidden">
        <div className="flex-1 flex flex-col min-h-0">
        {selectedWorkspace ? (
          <>
            {/* Workspace Header - with SidebarTrigger */}
            <div className="border-b border-border/60 bg-background/50 backdrop-blur-sm px-4 py-3 elevation-1 flex-shrink-0">
              <div className="flex items-center justify-between">
                {/* Left: SidebarTrigger, separator, and Branch name */}
                <div className="flex items-center gap-3">
                  <SidebarTrigger className="-ml-1" />
                  <Separator orientation="vertical" className="h-4" />
                  <BranchName branch={selectedWorkspace.branch} />
                </div>

                {/* Right: Open in dropdown */}
                <OpenInDropdown
                  workspacePath={`${selectedWorkspace.root_path}/.conductor/${selectedWorkspace.directory_name}`}
                />
              </div>
            </div>

            {/* Messages take full area */}
            <div className="flex-1 flex flex-col min-h-0">
              {selectedWorkspace.active_session_id && (
                <WorkspaceChatPanel
                  ref={workspaceChatPanelRef}
                  sessionId={selectedWorkspace.active_session_id}
                  embedded={true}
                />
              )}
            </div>
          </>
        ) : (
          <WelcomeView
            recentWorkspaces={
              repoGroups
                .flatMap(g => g.workspaces)
                .sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime())
                .slice(0, 15)
            }
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
          <Panel id="right" defaultSize={23} minSize={15} maxSize={40} className="flex flex-col min-h-0 min-w-0 overflow-x-hidden">
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
                {fileChanges.length > 0 && (
                  <Badge variant="secondary" className="ml-2 px-1.5 py-0 text-xs">
                    {fileChanges.length}
                  </Badge>
                )}
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
            <div className="h-full flex flex-col">
              {/* Dev Servers Section */}
              {selectedWorkspace && devServers.length > 0 && (
                <div className="border-b border-border/50 bg-background/30">
                  <div className="px-4 py-2.5 sticky top-0 z-10 bg-background/50 backdrop-blur-sm border-b border-border/30">
                    <h3 className="text-caption font-semibold text-muted-foreground uppercase tracking-wider">Dev Servers</h3>
                  </div>
                  <div className="p-3 space-y-2">
                    {devServers.map((server, index) => (
                      <a
                        key={index}
                        href={server.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="flex items-center gap-3 p-2.5 rounded-lg hover:bg-sidebar-accent/60 transition-[background-color,box-shadow] duration-200 ease-out no-underline group elevation-1 hover:elevation-2"
                        title={`Open ${server.name} in browser`}
                      >
                        <div className="flex-shrink-0 w-8 h-8 rounded-md bg-primary/10 flex items-center justify-center">
                          <Monitor className="w-4 h-4 text-primary" />
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="text-body-sm font-medium truncate group-hover:text-primary transition-colors">{server.name}</div>
                          <div className="text-caption text-muted-foreground truncate font-mono">{server.url}</div>
                        </div>
                        <div className="h-2 w-2 rounded-full bg-success flex-shrink-0" />
                      </a>
                    ))}
                  </div>
                </div>
              )}

              {/* File Changes */}
              <div className="flex-1 overflow-y-auto">
                <div className="px-4 py-2.5 sticky top-0 z-10 border-b border-border/50 bg-background/50 backdrop-blur-sm">
                  <h3 className="text-caption font-semibold text-muted-foreground uppercase tracking-wider">File Changes</h3>
                </div>
                <div className="p-3">
                  {selectedWorkspace && fileChanges.length > 0 ? (
                    <div className="space-y-1">
                      {fileChanges.map((file, index) => (
                        <div
                          key={index}
                          className="flex items-center justify-between p-2.5 rounded-lg hover:bg-sidebar-accent/60 cursor-pointer transition-[background-color,box-shadow] duration-200 ease-out group elevation-1 hover:elevation-2"
                          onClick={() => handleFileClick(file.file)}
                          title="Click to view diff"
                        >
                          <div className="flex-1 min-w-0">
                            <div className="text-body-sm font-medium truncate group-hover:text-primary transition-colors">{file.file.split('/').pop()}</div>
                            <div className="text-caption text-muted-foreground truncate font-mono">{file.file}</div>
                          </div>
                          <div className="flex items-center gap-1.5 text-xs flex-shrink-0 ml-3">
                            {file.additions > 0 && (
                              <span className="text-success font-semibold px-1.5 py-0.5 bg-success/10 rounded">+{file.additions}</span>
                            )}
                            {file.deletions > 0 && (
                              <span className="text-destructive font-semibold px-1.5 py-0.5 bg-destructive/10 rounded">-{file.deletions}</span>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : selectedWorkspace ? (
                    <div className="p-8">
                      <EmptyState
                        icon={<Sparkles  />}
                        description="No file changes detected"
                      />
                    </div>
                  ) : (
                    <div className="p-8">
                      <EmptyState
                        icon={<FileCode  />}
                        description="Select a workspace to view file changes"
                      />
                    </div>
                  )}
                </div>
              </div>
            </div>
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
        </div>
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
        systemPrompt={systemPrompt}
        loading={loadingSystemPrompt}
        saving={savingSystemPrompt}
        onClose={() => closeSystemPromptModal()}
        onChange={setSystemPrompt}
        onSave={saveSystemPrompt}
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
