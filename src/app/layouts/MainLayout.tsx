import { useState, useEffect, useRef, useMemo } from "react";
import { toast } from "sonner";
import { SessionPanel } from "@/features/session";
import type { SessionPanelRef } from "@/features/session";
import { CollapsibleTerminalPanel } from "@/features/terminal";
import {
  NewWorkspaceModal,
  WelcomeView,
  CloneRepositoryModal,
} from "@/features/repository";
import { DiffViewer, FileChangesPanel, FileBrowserPanel, MainContentTabBar } from "@/features/workspace";
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
  Skeleton,
  SidebarProvider,
  SidebarInset,
  Tabs,
  TabsList,
  TabsTrigger,
  TabsContent,
  useSidebar,
} from "@/components/ui";
import { Empty, EmptyHeader, EmptyMedia, EmptyTitle, EmptyDescription, EmptyContent } from "@/components/ui/empty";
import { AppSidebar, SidebarSkeleton } from "@/features/sidebar";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { Package, GitPullRequest, Archive, Square, Sparkles, FileCode, Monitor, X, FolderOpen } from "lucide-react";
import { useWorkspaceStore } from "@/features/workspace/store";
import { useUIStore } from "@/shared/stores/uiStore";
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
  onCreateWorkspace,
  onOpenProject,
  onCloneRepository,
  onWorkspaceClick,
}: {
  selectedWorkspace: Workspace | null;
  workspaceChatPanelRef: React.RefObject<SessionPanelRef | null>;
  recentWorkspaces: Workspace[];
  onCreateWorkspace: () => void;
  onOpenProject: () => void;
  onCloneRepository: () => void;
  onWorkspaceClick: (workspace: Workspace) => void;
}) {
  const { open: sidebarOpen, setOpen: setSidebarOpen } = useSidebar();

  // Right panel view tab (Files or Changes)
  const [rightPanelViewTab, setRightPanelViewTab] = useState<'files' | 'changes'>('changes');

  // State for main content tabs (chat sessions)
  const [mainTabs, setMainTabs] = useState<Tab[]>([
    { id: 'chat-1', label: 'Chat #1', type: 'chat', closeable: false }
  ]);
  const [activeMainTabId, setActiveMainTabId] = useState('chat-1');

  // State for browser overlay
  const [isBrowserOpen, setIsBrowserOpen] = useState(false);

  /**
   * Sidebar Auto-Management for Browser
   *
   * UX Goal: Maximize browser space when it opens, restore user's workspace when it closes
   *
   * Behavior:
   * 1. Browser opens → save sidebar state, auto-close if open (give browser max space)
   * 2. User manually opens sidebar while browser is active → respect their choice
   * 3. Browser closes:
   *    - If user never reopened sidebar → restore to saved state
   *    - If user reopened sidebar → keep it open (respect their intent)
   */
  const [sidebarWasOpenBeforeBrowser, setSidebarWasOpenBeforeBrowser] = useState(false);
  const prevBrowserOpenRef = useRef(isBrowserOpen);

  useEffect(() => {
    const browserJustOpened = isBrowserOpen && !prevBrowserOpenRef.current;
    const browserJustClosed = !isBrowserOpen && prevBrowserOpenRef.current;

    if (browserJustOpened) {
      // Save current state before making changes
      setSidebarWasOpenBeforeBrowser(sidebarOpen);
      // Auto-close sidebar to give browser maximum space
      if (sidebarOpen) {
        setSidebarOpen(false);
      }
    }

    if (browserJustClosed) {
      // Restore sidebar only if user never reopened it while browser was active
      // Logic: If sidebar is still closed AND it was open before → restore it
      if (!sidebarOpen && sidebarWasOpenBeforeBrowser) {
        setSidebarOpen(true);
      }
      // Reset saved state
      setSidebarWasOpenBeforeBrowser(false);
    }

    // Track current browser state for next render
    prevBrowserOpenRef.current = isBrowserOpen;
  }, [isBrowserOpen, sidebarOpen, setSidebarOpen, sidebarWasOpenBeforeBrowser]);

  // Handle browser toggle
  const handleBrowserToggle = () => {
    setIsBrowserOpen(prev => !prev);
  };

  // Handle branch rename
  const handleBranchRename = (newName: string) => {
    // TODO: Implement backend call to rename branch via git
    console.log('Branch rename requested:', selectedWorkspace?.branch, '→', newName);
    // For now, just log. Full implementation would:
    // 1. Validate branch name (git rules)
    // 2. Call backend API to rename branch
    // 3. Update workspace state
    // 4. Handle errors gracefully
  };

  // Handle tab changes
  const handleMainTabChange = (tabId: string) => {
    setActiveMainTabId(tabId);
  };

  // Handle tab close
  const handleMainTabClose = (tabId: string) => {
    const currentIndex = mainTabs.findIndex(t => t.id === tabId);
    const newTabs = mainTabs.filter(t => t.id !== tabId);
    setMainTabs(newTabs);
    // If closing active tab, switch to previous tab (or next if closing first tab)
    if (tabId === activeMainTabId && newTabs.length > 0) {
      const targetIndex = currentIndex > 0 ? currentIndex - 1 : 0;
      setActiveMainTabId(newTabs[targetIndex].id);
    }
  };

  // Monotonic chat index to avoid ID collisions after closes
  const nextChatIndexRef = useRef(2); // chat-1 exists by default

  // Handle add new tab
  const handleMainTabAdd = () => {
    const idx = nextChatIndexRef.current++;
    const newId = `chat-${idx}`;
    const newTab: Tab = {
      id: newId,
      label: `Chat #${idx}`,
      type: 'chat',
      closeable: true
    };
    setMainTabs(prevTabs => [...prevTabs, newTab]);
    setActiveMainTabId(newId);
  };

  // Keyboard shortcut: Cmd+T to open new chat tab
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      // ⌘T or Ctrl+T - New chat tab
      if ((e.metaKey || e.ctrlKey) && e.key === 't' && selectedWorkspace) {
        // Ignore when typing in inputs/textarea/contenteditable
        const ae = document.activeElement as HTMLElement | null;
        const isTextField =
          !!ae &&
          (ae.tagName === 'INPUT' ||
            ae.tagName === 'TEXTAREA' ||
            ae.isContentEditable ||
            ae.getAttribute('role') === 'textbox');
        if (isTextField) return;

        e.preventDefault(); // Prevent browser's "new tab" action
        handleMainTabAdd();
      }
    }

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [selectedWorkspace]);

  /**
   * Open a diff as a new tab (or switch to existing)
   *
   * Behavior:
   * - If tab already exists for this file → switch to it and update content
   * - If tab doesn't exist → create new tab after current active tab
   * - Tab label shows filename only (truncated if needed)
   *
   * @param fileData - File path, diff content, and change statistics
   */
  const handleOpenDiffTab = (fileData: {
    file: string;
    diff: string;
    additions: number;
    deletions: number;
  }) => {
    const fileName = fileData.file.split('/').pop() || fileData.file;

    // Check if tab already exists for this file
    const existingTabIndex = mainTabs.findIndex(
      t => t.type === 'diff' && t.data?.filePath === fileData.file
    );

    if (existingTabIndex !== -1) {
      // Tab exists - switch to it and update content
      const existingTab = mainTabs[existingTabIndex];
      setActiveMainTabId(existingTab.id);

      // Update diff content
      setMainTabs(tabs =>
        tabs.map((t, i) =>
          i === existingTabIndex
            ? {
                ...t,
                data: {
                  ...t.data,
                  diff: fileData.diff,
                  additions: fileData.additions,
                  deletions: fileData.deletions,
                },
              }
            : t
        )
      );
    } else {
      // Create new tab
      const newTab: Tab = {
        id: `diff-${Date.now()}`,
        label: fileName,
        type: 'diff',
        closeable: true,
        data: {
          filePath: fileData.file,
          diff: fileData.diff,
          additions: fileData.additions,
          deletions: fileData.deletions,
        },
      };

      // Insert after current active tab
      const activeIndex = mainTabs.findIndex(t => t.id === activeMainTabId);
      const insertIndex = activeIndex >= 0 ? activeIndex + 1 : mainTabs.length;

      const newTabs = [
        ...mainTabs.slice(0, insertIndex),
        newTab,
        ...mainTabs.slice(insertIndex),
      ];

      setMainTabs(newTabs);
      setActiveMainTabId(newTab.id);
    }
  };

  /**
   * Update an existing diff tab with new data
   *
   * Used for async diff loading:
   * 1. Tab opens with "Loading..." message
   * 2. API fetches actual diff
   * 3. This function updates the tab with real data
   *
   * @param filePath - File path to identify which tab to update
   * @param updates - Partial updates to tab data (diff, additions, deletions)
   */
  const handleUpdateDiffTab = (
    filePath: string,
    updates: { diff?: string; additions?: number; deletions?: number }
  ) => {
    setMainTabs(tabs =>
      tabs.map(t =>
        t.type === 'diff' && t.data?.filePath === filePath
          ? {
              ...t,
              data: {
                ...t.data,
                ...updates,
              },
            }
          : t
      )
    );
  };

  return (
    <SidebarInset className="min-w-0">
      {/**
       * CSS Grid Layout: Main Content | Right Panel/Browser
       *
       * Architecture:
       * - When browser closed: Main (flex, min 500px) | Right Panel (fixed 400px)
       * - When browser open: Main (flex, min 350px, 1fr) | Browser (min 700px, 2fr)
       *
       * Why browser gets more space:
       * - Web pages need significant horizontal space (700-800px+)
       * - Chat works well in narrower space (vertical scrolling)
       * - 2fr growth factor: browser gets 2x extra space as viewport grows
       *
       * Example with 1200px total:
       * - Main: ~400px (min 350px + some flex)
       * - Browser: ~800px (min 700px + 2x flex)
       */}
      <div
        className="flex-1 min-w-0 rounded-lg bg-background/70 backdrop-blur-[20px] border border-border/40 vibrancy-shadow overflow-hidden transition-colors duration-200"
        style={{
          display: 'grid',
          gridTemplateColumns: selectedWorkspace
            ? isBrowserOpen
              ? 'minmax(350px, 1fr) minmax(700px, 2fr)'  // Main (smaller) | Browser (LARGER, grows 2x faster)
              : 'minmax(500px, 1fr) 400px'   // Main | Right Panel
            : '1fr',
          height: '100%',
          gap: '0',
        }}
      >
        {/* MAIN CONTENT AREA - Browser-style tabs for chat sessions */}
        {selectedWorkspace ? (
          <div className="flex flex-col h-full overflow-hidden border-r border-border/40">
            {/* Tab Bar with integrated workspace header (branch name, browser button, tabs) */}
            <MainContentTabBar
              tabs={mainTabs}
              activeTabId={activeMainTabId}
              onTabChange={handleMainTabChange}
              onTabClose={handleMainTabClose}
              onTabAdd={handleMainTabAdd}
              repositoryName={selectedWorkspace.root_path.split('/').filter(Boolean).pop()}
              branch={selectedWorkspace.branch}
              workspacePath={`${selectedWorkspace.root_path}/.conductor/${selectedWorkspace.directory_name}`}
              isBrowserOpen={isBrowserOpen}
              onBrowserToggle={handleBrowserToggle}
              onBranchRename={handleBranchRename}
            />

            {/* 3. Tab Content - Flexible height, scrollable (renders based on active tab type) */}
            <div className="flex-1 min-h-0 overflow-hidden flex flex-col">
              {(() => {
                // Find the active tab
                const activeTab = mainTabs.find(t => t.id === activeMainTabId);

                // Render content based on tab type
                if (activeTab?.type === 'chat') {
                  // Chat tab - show SessionPanel
                  return selectedWorkspace.active_session_id ? (
                    <SessionPanel
                      ref={workspaceChatPanelRef}
                      sessionId={selectedWorkspace.active_session_id}
                      embedded={true}
                    />
                  ) : null;
                }

                if (activeTab?.type === 'diff') {
                  // Diff tab - show DiffViewer
                  return (
                    <DiffViewer
                      filePath={activeTab.data?.filePath}
                      diff={activeTab.data?.diff}
                      additions={activeTab.data?.additions}
                      deletions={activeTab.data?.deletions}
                    />
                  );
                }

                // Future: 'file' type for full file viewer
                if (activeTab?.type === 'file') {
                  // TODO: Implement FileViewer component
                  return null;
                }

                // Fallback - no active tab or unknown type
                return null;
              })()}
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

        {/* RIGHT PANEL OR BROWSER - Layered with transforms */}
        {selectedWorkspace && (
          <div className="relative h-full overflow-hidden">
            {/* RIGHT PANEL - Always rendered, hidden when browser open */}
            <div className={`flex flex-col h-full overflow-hidden transition-opacity duration-300 ${isBrowserOpen ? 'opacity-0 pointer-events-none' : 'opacity-100'}`}>
              {/* Top Section: Files/Changes Tabs */}
              <Tabs value={rightPanelViewTab} onValueChange={(v) => setRightPanelViewTab(v as any)} className="flex-1 flex flex-col overflow-hidden min-h-0">
                <div className="border-b border-border/40 flex-shrink-0">
                  <TabsList className="h-8 w-full justify-start rounded-none bg-transparent p-0 px-2 gap-0">
                    <TabsTrigger
                      value="files"
                      className="relative rounded-none border-b border-b-transparent data-[state=active]:border-b-foreground data-[state=inactive]:text-muted-foreground/60 px-3 py-1.5 transition-[border-color,color] duration-200 ease-out"
                    >
                      <span className="text-xs font-medium">Files</span>
                    </TabsTrigger>
                    <TabsTrigger
                      value="changes"
                      className="relative rounded-none border-b border-b-transparent data-[state=active]:border-b-foreground data-[state=inactive]:text-muted-foreground/60 px-3 py-1.5 transition-[border-color,color] duration-200 ease-out"
                    >
                      <span className="text-xs font-medium">Changes</span>
                    </TabsTrigger>
                  </TabsList>
                </div>

                {/* Files Tab */}
                <TabsContent
                  value="files"
                  className="m-0 flex-1 overflow-hidden data-[state=active]:flex data-[state=active]:flex-col data-[state=inactive]:hidden"
                >
                  <FileBrowserPanel selectedWorkspace={selectedWorkspace} />
                </TabsContent>

                {/* Changes Tab */}
                <TabsContent
                  value="changes"
                  className="m-0 flex-1 overflow-hidden data-[state=active]:flex data-[state=active]:flex-col data-[state=inactive]:hidden"
                >
                  <FileChangesPanel
                    selectedWorkspace={selectedWorkspace}
                    onOpenDiffTab={handleOpenDiffTab}
                    onUpdateDiffTab={handleUpdateDiffTab}
                  />
                </TabsContent>
              </Tabs>

              {/* Bottom Section: Collapsible Terminal */}
              <CollapsibleTerminalPanel
                workspacePath={`${selectedWorkspace.root_path}/.conductor/${selectedWorkspace.directory_name}`}
                workspaceName={selectedWorkspace.directory_name}
              />
            </div>

            {/* BROWSER - Slides in from right, overlays right panel */}
            <div
              className={`absolute inset-0 flex flex-col h-full overflow-hidden bg-background border-l border-border transition-transform duration-300 ease-[cubic-bezier(0.23,1,0.32,1)] ${
                isBrowserOpen ? 'translate-x-0' : 'translate-x-full'
              }`}
            >
              <BrowserPanel
                workspaceId={selectedWorkspace.id}
                onClose={() => setIsBrowserOpen(false)}
              />
            </div>
          </div>
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
    openNewWorkspaceModal,
    closeNewWorkspaceModal,
    openSystemPromptModal,
    closeSystemPromptModal,
    closeSettingsModal,
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
          // Keep default 3rem (48px) - works with shadcn's size-8 (32px) button design
          "--sidebar-width-icon": "3rem",
        } as React.CSSProperties
      }
    >
      {/* Inset Sidebar - transparent, sits on top of #root background */}
      {loading ? (
        <SidebarSkeleton />
      ) : repoGroups.length === 0 ? (
        <div className="space-standard">
          <Empty className="border-0">
            <EmptyHeader>
              <EmptyMedia>
                <FolderOpen className="h-16 w-16 text-muted-foreground/40" />
              </EmptyMedia>
              <EmptyTitle>No Workspaces</EmptyTitle>
              <EmptyDescription>
                Create a new workspace to get started
              </EmptyDescription>
            </EmptyHeader>
            <EmptyContent>
              <Button
                variant="default"
                onClick={() => handleNewWorkspace()}
                size="sm"
              >
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
