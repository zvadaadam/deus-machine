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
import { Package, GitPullRequest, Archive, Square, Sparkles, FileCode, Monitor, FolderOpen, ChevronsRight } from "lucide-react";
import { useWorkspaceStore, useWorkspaceLayoutStore } from "@/features/workspace/store";
import type { RightPanelTab } from "@/features/workspace/store";
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

  // Workspace layout store - per-workspace persistence (extract methods to avoid re-renders)
  const setLayoutState = useWorkspaceLayoutStore((state) => state.setLayout);
  const getLayoutState = useWorkspaceLayoutStore((state) => state.getLayout);

  const workspaceLayout = selectedWorkspace
    ? getLayoutState(selectedWorkspace.id)
    : null;

  // Right panel tab (Changes, Files, or Browser)
  const [rightPanelTab, setRightPanelTab] = useState<RightPanelTab>(
    workspaceLayout?.activeRightTab || 'changes'
  );

  // Right panel expansion state (narrow 400px vs wide 2fr)
  const [rightPanelExpanded, setRightPanelExpanded] = useState(
    workspaceLayout?.rightPanelExpanded || false
  );

  // Selected file for diff viewing
  const [selectedFile, setSelectedFile] = useState<{ path: string; diff: string; additions: number; deletions: number } | null>(null);

  // State for main content tabs (chat sessions - only chat, no more diff tabs)
  const [mainTabs, setMainTabs] = useState<Tab[]>([
    { id: 'chat-1', label: 'Chat #1', type: 'chat', closeable: false }
  ]);
  const [activeMainTabId, setActiveMainTabId] = useState('chat-1');

  /**
   * Sidebar Auto-Management for Right Panel Expansion
   *
   * UX Goal: Maximize panel space when it expands (file/browser), restore workspace when it collapses
   *
   * Behavior:
   * 1. Panel expands → save sidebar state, auto-close if open (give panel max space)
   * 2. User manually opens sidebar while panel is expanded → respect their choice
   * 3. Panel collapses:
   *    - If user never reopened sidebar → restore to saved state
   *    - If user reopened sidebar → keep it open (respect their intent)
   */
  const [sidebarWasOpenBeforeExpansion, setSidebarWasOpenBeforeExpansion] = useState(false);
  const prevPanelExpandedRef = useRef(rightPanelExpanded);

  useEffect(() => {
    const panelJustExpanded = rightPanelExpanded && !prevPanelExpandedRef.current;
    const panelJustCollapsed = !rightPanelExpanded && prevPanelExpandedRef.current;

    if (panelJustExpanded) {
      // Save current state before making changes
      setSidebarWasOpenBeforeExpansion(sidebarOpen);
      // Auto-close sidebar to give panel maximum space
      if (sidebarOpen) {
        setSidebarOpen(false);
      }
    }

    if (panelJustCollapsed) {
      // Restore sidebar only if user never reopened it while panel was expanded
      if (!sidebarOpen && sidebarWasOpenBeforeExpansion) {
        setSidebarOpen(true);
      }
      // Reset saved state
      setSidebarWasOpenBeforeExpansion(false);
    }

    // Track current panel state for next render
    prevPanelExpandedRef.current = rightPanelExpanded;
  }, [rightPanelExpanded, sidebarOpen, setSidebarOpen, sidebarWasOpenBeforeExpansion]);

  // Sync state to persistence store
  useEffect(() => {
    if (selectedWorkspace) {
      setLayoutState(selectedWorkspace.id, {
        rightPanelExpanded,
        activeRightTab: rightPanelTab,
        sidebarCollapsed: !sidebarOpen,
        selectedFile: selectedFile ? { path: selectedFile.path, source: 'changes' } : null,
      });
    }
  }, [selectedWorkspace?.id, rightPanelExpanded, rightPanelTab, sidebarOpen, selectedFile, setLayoutState]);

  // Restore layout state when workspace changes
  useEffect(() => {
    if (!selectedWorkspace) {
      setSelectedFile(null);
      return;
    }

    const layout = getLayoutState(selectedWorkspace.id);
    setRightPanelTab(layout.activeRightTab);
    setRightPanelExpanded(layout.rightPanelExpanded);

    if (layout.selectedFile && layout.activeRightTab !== 'browser') {
      setSelectedFile({
        path: layout.selectedFile.path,
        diff: 'Loading diff...',
        additions: 0,
        deletions: 0,
      });
    } else {
      setSelectedFile(null);
    }
  }, [selectedWorkspace?.id, getLayoutState]);

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
   * Handle tab change in right panel
   *
   * Jony Ive principle: Switching tabs should show the tab content clearly,
   * not auto-open files or maintain state from other tabs. User decides what opens.
   *
   * Panel width behavior:
   * - Browser → Changes/Files: Keep panel expanded, restore last file if available
   * - Changes/Files: User manually controls with file selection or close button
   * - Browser: Auto-expand if needed (browser needs space)
   */
  const handleRightPanelTabChange = (tab: RightPanelTab) => {
    const previousTab = rightPanelTab;
    setRightPanelTab(tab);

    // Restore last opened file when returning to Changes tab (if panel is expanded)
    if (tab === 'changes' && rightPanelExpanded && selectedWorkspace) {
      const layout = getLayoutState(selectedWorkspace.id);
      if (layout.selectedFile && previousTab !== 'changes') {
        // User is returning to Changes tab from another tab
        // Restore their last viewed file
        // Note: We'll need to trigger the file load via FileChangesPanel
        // For now, just set the state - the actual diff will be loaded on click
        setSelectedFile({
          path: layout.selectedFile.path,
          diff: 'Loading...',
          additions: 0,
          deletions: 0,
        });
      }
    } else if (tab !== 'changes' && tab !== 'files') {
      // Switching to browser or other tab - clear selection
      setSelectedFile(null);
    }

    // Only auto-expand for browser (never auto-collapse for Changes/Files)
    if (tab === 'browser' && !rightPanelExpanded) {
      setRightPanelExpanded(true);
    }
  };

  /**
   * Handle file click - opens file diff in right panel
   * Replaces old tab-based approach with panel-based approach
   *
   * @param fileData - File path, diff content, and change statistics
   */
  const handleFileClick = (fileData: {
    file: string;
    diff: string;
    additions: number;
    deletions: number;
  }) => {
    // Set selected file
    setSelectedFile({
      path: fileData.file,
      diff: fileData.diff,
      additions: fileData.additions,
      deletions: fileData.deletions,
    });

    // Expand panel to show file
    setRightPanelExpanded(true);
  };

  /**
   * Update file diff content (for async loading)
   *
   * Used when FileChangesPanel/FileBrowserPanel loads diff asynchronously
   */
  const handleUpdateFile = (
    filePath: string,
    updates: { diff?: string; additions?: number; deletions?: number }
  ) => {
    setSelectedFile(current => {
      if (current?.path === filePath) {
        return {
          ...current,
          diff: updates.diff !== undefined ? updates.diff : current.diff,
          additions: updates.additions !== undefined ? updates.additions : current.additions,
          deletions: updates.deletions !== undefined ? updates.deletions : current.deletions,
        };
      }
      return current;
    });
  };

  /**
   * Collapse panel to narrow mode
   * Works for all tabs: Changes, Files, Browser
   * Also clears selected file (no intermediate empty state)
   */
  const handlePanelCollapse = () => {
    setRightPanelExpanded(false);
    setSelectedFile(null); // Clear file - no intermediate empty state
    // If on browser tab, switch to changes (browser doesn't have narrow mode)
    if (rightPanelTab === 'browser') {
      setRightPanelTab('changes');
    }
  };

  return (
    <SidebarInset className="min-w-0">
      {/**
       * CSS Grid Layout: Main Content | Right Panel
       *
       * New Architecture (Unified Panel System):
       * - Panel collapsed: Main (flex, min 500px) | Right Panel (fixed 400px)
       * - Panel expanded: Main (flex, min 350px, 1fr) | Right Panel (min 700px, 2fr)
       *
       * Panel Modes:
       * - Narrow (400px): File list, changes list
       * - Wide (2fr, ~700px+): File diff viewer, browser
       *
       * Why expanded panel gets more space:
       * - File diffs & web pages need horizontal space (700-800px+)
       * - Chat works well in narrower column (vertical scrolling)
       * - 2fr growth factor: panel gets 2x extra space as viewport grows
       *
       * Example with 1200px total:
       * - Collapsed: Main ~800px | Panel 400px
       * - Expanded: Main ~400px | Panel ~800px
       */}
      <div
        className="flex-1 min-w-0 rounded-lg bg-background/70 backdrop-blur-[20px] border border-border/40 vibrancy-shadow overflow-hidden transition-all duration-300 ease-[cubic-bezier(0.23,1,0.32,1)]"
        style={{
          display: 'grid',
          gridTemplateColumns: selectedWorkspace
            ? rightPanelExpanded
              ? 'minmax(350px, 1fr) minmax(700px, 2fr)'  // Main (compressed) | Panel (EXPANDED)
              : 'minmax(500px, 1fr) 400px'               // Main | Panel (narrow)
            : '1fr',
          height: '100%',
          gap: '0',
        }}
      >
        {/* MAIN CONTENT AREA - Browser-style tabs for chat sessions */}
        {selectedWorkspace ? (
          <div className="flex flex-col h-full overflow-hidden border-r border-border/40">
            {/* Tab Bar with integrated workspace header (branch name, tabs) - No more browser button */}
            <MainContentTabBar
              tabs={mainTabs}
              activeTabId={activeMainTabId}
              onTabChange={handleMainTabChange}
              onTabClose={handleMainTabClose}
              onTabAdd={handleMainTabAdd}
              repositoryName={selectedWorkspace.root_path.split('/').filter(Boolean).pop()}
              branch={selectedWorkspace.branch}
              workspacePath={`${selectedWorkspace.root_path}/.conductor/${selectedWorkspace.directory_name}`}
              onBranchRename={handleBranchRename}
            />

            {/* Tab Content - Chat sessions only (diffs now in right panel) */}
            <div className="flex-1 min-h-0 overflow-hidden flex flex-col">
              {(() => {
                // Find the active tab
                const activeTab = mainTabs.find(t => t.id === activeMainTabId);

                // Only chat tabs exist now - diffs moved to right panel
                if (activeTab?.type === 'chat') {
                  return selectedWorkspace.active_session_id ? (
                    <SessionPanel
                      ref={workspaceChatPanelRef}
                      sessionId={selectedWorkspace.active_session_id}
                      embedded={true}
                    />
                  ) : null;
                }

                // Fallback - no active tab
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

        {/* RIGHT PANEL - Unified system for Changes/Files/Browser/File Diffs */}
        {selectedWorkspace && (
          <div className="flex flex-col h-full overflow-hidden">
            {/* Panel Header with Tabs - h-12 (48px) aligned with session panel context bar */}
            <Tabs value={rightPanelTab} onValueChange={(v) => handleRightPanelTabChange(v as RightPanelTab)} className="flex-1 flex flex-col overflow-hidden min-h-0">
              <div className="border-b border-border/50 bg-background/50 backdrop-blur-sm flex-shrink-0 flex items-center h-12 px-3">
                {/* Tab Triggers - Segmented control styling */}
                <TabsList className="mr-auto">
                  <TabsTrigger
                    value="changes"
                    className="min-w-[88px] justify-center"
                  >
                    Changes
                  </TabsTrigger>
                  <TabsTrigger
                    value="files"
                    className="min-w-[88px] justify-center"
                  >
                    Files
                  </TabsTrigger>
                  <TabsTrigger
                    value="browser"
                    className="min-w-[88px] justify-center"
                  >
                    Browser
                  </TabsTrigger>
                </TabsList>

                {/* Panel Controls - Collapse button when expanded */}
                {rightPanelExpanded && (
                  <div className="flex items-center px-3 border-l border-border/30">
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-9 w-9 rounded-lg"
                      onClick={handlePanelCollapse}
                      title="Collapse panel"
                    >
                      <ChevronsRight className="h-[18px] w-[18px]" />
                    </Button>
                  </div>
                )}
              </div>

              {/* Tab Content - Split layout for Changes/Files with diff viewer */}
              <>
                {/* Changes Tab - Split: File List + Diff Viewer */}
                <TabsContent
                  value="changes"
                  className="m-0 h-full overflow-hidden data-[state=inactive]:hidden"
                >
                  <div className="flex h-full overflow-hidden">
                    {/* File List - Fixed width when expanded, full width when collapsed */}
                    <div className={`flex-shrink-0 transition-all duration-300 ease-[cubic-bezier(0.23,1,0.32,1)] ${
                      rightPanelExpanded
                        ? 'w-[280px] border-r border-border/40'  // Expanded: always 280px (consistency)
                        : 'flex-1'                                // Collapsed: full width
                    }`}>
                      <FileChangesPanel
                        selectedWorkspace={selectedWorkspace}
                        onOpenDiffTab={handleFileClick}
                        onUpdateDiffTab={handleUpdateFile}
                        selectedFilePath={selectedFile?.path}
                      />
                    </div>

                    {/* Right Side - Diff Viewer or Empty State */}
                    {rightPanelExpanded && (
                      <div className="flex-1 overflow-hidden animate-in slide-in-from-right-2 duration-300">
                        {selectedFile ? (
                          <DiffViewer
                            filePath={selectedFile.path}
                            diff={selectedFile.diff}
                            additions={selectedFile.additions}
                            deletions={selectedFile.deletions}
                          />
                        ) : (
                          <div className="h-full flex items-center justify-center">
                            <div className="text-center max-w-sm">
                              <FileCode className="h-16 w-16 text-muted-foreground/30 mx-auto mb-4" />
                              <h3 className="text-sm font-medium text-foreground/60 mb-2">
                                Select a file to view changes
                              </h3>
                              <p className="text-xs text-muted-foreground/50">
                                Click on any file from the list to see its diff
                              </p>
                            </div>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                </TabsContent>

                {/* Files Tab - Split: File Browser + Diff Viewer */}
                <TabsContent
                  value="files"
                  className="m-0 h-full overflow-hidden data-[state=inactive]:hidden"
                >
                  <div className="flex h-full overflow-hidden">
                    {/* File Browser - Fixed width when expanded, full width when collapsed */}
                    <div className={`flex-shrink-0 transition-all duration-300 ease-[cubic-bezier(0.23,1,0.32,1)] ${
                      rightPanelExpanded
                        ? 'w-[280px] border-r border-border/40'  // Expanded: always 280px (consistency)
                        : 'flex-1'                                // Collapsed: full width
                    }`}>
                      <FileBrowserPanel
                        selectedWorkspace={selectedWorkspace}
                        onFileClick={(path) => {
                          // TODO: Load file content and show in diff viewer
                          console.log('File browser click:', path);
                        }}
                      />
                    </div>

                    {/* Right Side - Diff Viewer or Empty State */}
                    {rightPanelExpanded && (
                      <div className="flex-1 overflow-hidden animate-in slide-in-from-right-2 duration-300">
                        {selectedFile ? (
                          <DiffViewer
                            filePath={selectedFile.path}
                            diff={selectedFile.diff}
                            additions={selectedFile.additions}
                            deletions={selectedFile.deletions}
                          />
                        ) : (
                          <div className="h-full flex items-center justify-center">
                            <div className="text-center max-w-sm">
                              <FolderOpen className="h-16 w-16 text-muted-foreground/30 mx-auto mb-4" />
                              <h3 className="text-sm font-medium text-foreground/60 mb-2">
                                Browse and select a file
                              </h3>
                              <p className="text-xs text-muted-foreground/50">
                                Explore the file tree and click on any file to view it
                              </p>
                            </div>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                </TabsContent>

                {/* Browser Tab - Full width, no split */}
                <TabsContent
                  value="browser"
                  className="m-0 h-full overflow-hidden data-[state=inactive]:hidden"
                >
                  <BrowserPanel
                    workspaceId={selectedWorkspace.id}
                  />
                </TabsContent>
              </>
            </Tabs>

            {/* Bottom Section: Collapsible Terminal */}
            <CollapsibleTerminalPanel
              workspacePath={`${selectedWorkspace.root_path}/.conductor/${selectedWorkspace.directory_name}`}
              workspaceName={selectedWorkspace.directory_name}
            />
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
        <div className="p-4">
          <Empty className="border-0">
            <EmptyHeader>
              <EmptyMedia>
                <FolderOpen className="h-16 w-16 text-muted-foreground/40" aria-hidden="true" />
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
