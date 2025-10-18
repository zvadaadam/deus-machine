import { useState, useEffect, useRef } from "react";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import { WorkspaceDetail } from "./WorkspaceDetail";
import { TerminalPanel } from "./TerminalPanel";
import { getBaseURL } from "./config/api.config";
import { formatTokenCount } from "./utils";
import {
  NewWorkspaceModal,
  DiffModal,
  SystemPromptModal,
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
  Tabs,
  TabsList,
  TabsTrigger,
  TabsContent,
} from "./components/ui";
import { AppSidebar } from "./components/app-sidebar";
import { Card, CardHeader, CardTitle, CardContent } from "./components/ui/card";
import { Separator } from "./components/ui/separator";
import { FileText, Package, GitPullRequest, Archive, Square, Globe, Terminal as TerminalIcon } from "lucide-react";
import { useWorkspaceStore, useUIStore } from "./stores";
import { OpenInDropdown } from "./components/OpenInDropdown";
import { BranchName } from "./components/BranchName";
import type {
  Workspace,
  Repo,
} from "./types";

/**
 * Conductor Dashboard - Main application interface
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
    diffModal,
    openNewWorkspaceModal,
    closeNewWorkspaceModal,
    openSystemPromptModal,
    closeSystemPromptModal,
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
  const [compactHandler, setCompactHandler] = useState<(() => void) | null>(null);
  const [createPRHandler, setCreatePRHandler] = useState<(() => void) | null>(null);
  const [stopHandler, setStopHandler] = useState<(() => void) | null>(null);

  // Ref to WorkspaceDetail for inserting text from browser element selector
  const workspaceDetailRef = useRef<{ insertText: (text: string) => void }>(null);

  // System Prompt Editor (local state - specific to this feature)
  const [systemPrompt, setSystemPrompt] = useState('');
  const [loadingSystemPrompt, setLoadingSystemPrompt] = useState(false);
  const [savingSystemPrompt, setSavingSystemPrompt] = useState(false);

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
          .then(res => res.json())
          .then(data => setRepos(data))
          .catch(err => console.error('Failed to load repos:', err));
      })();
    }
  }, [showNewWorkspaceModal, repos.length]);

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
      const customEvent = event as CustomEvent<{ text: string }>;
      if (customEvent.detail?.text && workspaceDetailRef.current) {
        console.log('[Dashboard] 🎯 Inserting element data to chat');
        workspaceDetailRef.current.insertText(customEvent.detail.text);
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
      alert(`Error: ${error}`);
    }
  }

  /**
   * Create a new workspace with git worktree
   */
  async function createWorkspace() {
    if (!selectedRepoId) {
      alert('Please select a repository');
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
      alert(`Error: ${error}`);
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
      alert('Failed to load system prompt');
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
      alert('Failed to save system prompt');
    } finally {
      setSavingSystemPrompt(false);
    }
  }

  return (
    <SidebarProvider>
      {/* Floating Sidebar */}
      {loading ? (
        <div className="p-4 space-y-3">
          <Skeleton className="h-6 w-full" />
          <Skeleton className="h-4 w-4/5" />
          <Skeleton className="h-4 w-[90%]" />
          <Skeleton className="h-4 w-3/4" />
        </div>
      ) : repoGroups.length === 0 ? (
        <div className="p-4">
          <EmptyState
            icon="📁"
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
          profile={{
            username: "Developer"
          }}
        />
      )}

      {/* Main Content with SidebarInset */}
      <SidebarInset className="overflow-x-hidden overflow-y-hidden min-w-0">
      <PanelGroup
        direction="horizontal"
        autoSaveId="conductor-root-layout"
        className="app-container"
      >
      {/* MAIN CONTENT */}
      <Panel id="center" minSize={30} style={{ minWidth: 0, overflowX: 'hidden' }}>
        <div className="panel-content main-content">
        {selectedWorkspace ? (
          <>
            {/* Workspace Header - Simplified */}
            <div className="border-b border-border px-4 py-3">
              <div className="flex items-center justify-between">
                {/* Left: Branch name with inline badge */}
                <BranchName branch={selectedWorkspace.branch} />

                {/* Right: Open in dropdown */}
                <OpenInDropdown
                  workspacePath={`${selectedWorkspace.root_path}/.conductor/${selectedWorkspace.directory_name}`}
                />
              </div>
            </div>

            {/* Messages take full area */}
            <div className="main-body">
              {selectedWorkspace.active_session_id && (
                <div className="content-section workspace-messages-section" style={{ margin: 0, border: 'none', borderRadius: 0, padding: 0 }}>
                  <div className="section-content" style={{ height: '100%' }}>
                    <WorkspaceDetail
                      ref={workspaceDetailRef}
                      workspaceId={selectedWorkspace.id}
                      sessionId={selectedWorkspace.active_session_id}
                      onClose={() => {}}
                      embedded={true}
                      onCompact={(handler) => setCompactHandler(() => handler)}
                      onCreatePR={(handler) => setCreatePRHandler(() => handler)}
                      onStop={(handler) => setStopHandler(() => handler)}
                    />
                  </div>
                </div>
              )}
            </div>
          </>
        ) : (
          <div className="main-body">
            <EmptyState
              icon="👈"
              title="No Workspace Selected"
              description="Select a workspace from the sidebar to view its details and start working"
              animate
            />

            {stats && (
              <Card className="m-4">
                <CardHeader>
                  <CardTitle>Overview</CardTitle>
                </CardHeader>
                <CardContent className="space-y-3">
                  <div className="flex justify-between items-center">
                    <span className="text-sm text-muted-foreground">Workspaces</span>
                    <span className="font-semibold">{stats.workspaces} <span className="text-xs text-muted-foreground">({stats.workspaces_ready} ready, {stats.workspaces_archived} archived)</span></span>
                  </div>
                  <Separator />
                  <div className="flex justify-between items-center">
                    <span className="text-sm text-muted-foreground">Repositories</span>
                    <span className="font-semibold">{stats.repos}</span>
                  </div>
                  <Separator />
                  <div className="flex justify-between items-center">
                    <span className="text-sm text-muted-foreground">Sessions</span>
                    <span className="font-semibold">{stats.sessions} <span className="text-xs text-muted-foreground">({stats.sessions_working} working, {stats.sessions_compacting} compacting)</span></span>
                  </div>
                  <Separator />
                  <div className="flex justify-between items-center">
                    <span className="text-sm text-muted-foreground">Messages</span>
                    <span className="font-semibold">{stats.messages.toLocaleString()}</span>
                  </div>
                  <Separator />
                  <div className="flex justify-between items-center">
                    <span className="text-sm text-muted-foreground">Status</span>
                    <Badge variant={status === 'Connected' ? 'ready' : 'error'}>{status}</Badge>
                  </div>
                </CardContent>
              </Card>
            )}
          </div>
        )}
        </div>
      </Panel>

      <PanelResizeHandle className="resize-handle" />

      {/* RIGHT PANEL - Browser, File Changes & Terminal */}
      <Panel id="right" defaultSize={23} minSize={15} maxSize={40} style={{ minWidth: 0, overflowX: 'hidden' }}>
        <Tabs defaultValue="browser" className="h-full flex flex-col overflow-hidden">
          <div className="border-b border-border">
            <TabsList className="h-10 w-full justify-start rounded-none bg-transparent p-0">
              <TabsTrigger
                value="browser"
                className="rounded-none border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:bg-transparent px-4"
              >
                <Globe className="h-4 w-4 mr-2" />
                Browser
              </TabsTrigger>
              <TabsTrigger
                value="changes"
                className="rounded-none border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:bg-transparent px-4"
              >
                <FileText className="h-4 w-4 mr-2" />
                Changes
                {fileChanges.length > 0 && (
                  <Badge variant="secondary" className="ml-2 px-1.5 py-0 text-xs">
                    {fileChanges.length}
                  </Badge>
                )}
              </TabsTrigger>
              <TabsTrigger
                value="terminal"
                className="rounded-none border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:bg-transparent px-4"
              >
                <TerminalIcon className="h-4 w-4 mr-2" />
                Terminal
              </TabsTrigger>
            </TabsList>
          </div>

          {/* Browser Tab */}
          <TabsContent value="browser" className="flex-1 m-0 overflow-hidden">
            {selectedWorkspace ? (
              <BrowserPanel workspaceId={selectedWorkspace.id} />
            ) : (
              <div className="h-full flex items-center justify-center">
                <EmptyState
                  icon="🌐"
                  description="Select a workspace to use the browser"
                />
              </div>
            )}
          </TabsContent>

          {/* File Changes Tab */}
          <TabsContent value="changes" className="flex-1 m-0 overflow-hidden">
            <div className="h-full flex flex-col">
              {/* Dev Servers Section */}
              {selectedWorkspace && devServers.length > 0 && (
                <div className="border-b border-border">
                  <div className="px-4 py-2 bg-muted/30">
                    <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Dev Servers</h3>
                  </div>
                  <div className="p-2 space-y-1">
                    {devServers.map((server, index) => (
                      <a
                        key={index}
                        href={server.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="flex items-center gap-2 p-2 rounded-md hover:bg-muted/50 transition-colors no-underline group"
                        title={`Open ${server.name} in browser`}
                      >
                        <span className="text-base">
                          {server.type === 'vite' ? '⚡' :
                           server.type === 'webpack' ? '📦' :
                           server.type === 'angular' ? '🅰️' :
                           server.type === 'node' ? '🟢' : '🌐'}
                        </span>
                        <div className="flex-1 min-w-0">
                          <div className="text-sm font-medium truncate group-hover:text-primary transition-colors">{server.name}</div>
                          <div className="text-xs text-muted-foreground truncate">{server.url}</div>
                        </div>
                        <div className="h-2 w-2 rounded-full bg-green-500 flex-shrink-0" />
                      </a>
                    ))}
                  </div>
                </div>
              )}

              {/* File Changes */}
              <div className="flex-1 overflow-y-auto">
                <div className="px-4 py-2 bg-muted/30 sticky top-0 z-10 border-b border-border">
                  <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">File Changes</h3>
                </div>
                <div className="p-2">
                  {selectedWorkspace && fileChanges.length > 0 ? (
                    <div className="space-y-1">
                      {fileChanges.map((file, index) => (
                        <div
                          key={index}
                          className="flex items-center justify-between p-2 rounded-md hover:bg-muted/50 cursor-pointer transition-colors group"
                          onClick={() => handleFileClick(file.file)}
                          title="Click to view diff"
                        >
                          <div className="flex-1 min-w-0">
                            <div className="text-sm font-medium truncate group-hover:text-primary transition-colors">{file.file.split('/').pop()}</div>
                            <div className="text-xs text-muted-foreground truncate font-mono">{file.file}</div>
                          </div>
                          <div className="flex items-center gap-1 text-xs flex-shrink-0 ml-2">
                            {file.additions > 0 && (
                              <span className="text-green-600 font-medium">+{file.additions}</span>
                            )}
                            {file.deletions > 0 && (
                              <span className="text-red-600 font-medium">-{file.deletions}</span>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : selectedWorkspace ? (
                    <div className="p-8">
                      <EmptyState
                        icon="✨"
                        description="No file changes detected"
                      />
                    </div>
                  ) : (
                    <div className="p-8">
                      <EmptyState
                        icon="📄"
                        description="Select a workspace to view file changes"
                      />
                    </div>
                  )}
                </div>
              </div>
            </div>
          </TabsContent>

          {/* Terminal Tab */}
          <TabsContent value="terminal" className="flex-1 m-0 overflow-hidden">
            {selectedWorkspace ? (
              <TerminalPanel
                workspacePath={`${selectedWorkspace.root_path}/.conductor/${selectedWorkspace.directory_name}`}
                workspaceName={selectedWorkspace.directory_name}
              />
            ) : (
              <div className="h-full flex items-center justify-center">
                <EmptyState
                  icon="💻"
                  description="Select a workspace to use the terminal"
                />
              </div>
            )}
          </TabsContent>
        </Tabs>
      </Panel>
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
        systemPrompt={systemPrompt}
        loading={loadingSystemPrompt}
        saving={savingSystemPrompt}
        onClose={() => closeSystemPromptModal()}
        onChange={setSystemPrompt}
        onSave={saveSystemPrompt}
      />
    </SidebarProvider>
  );
}
