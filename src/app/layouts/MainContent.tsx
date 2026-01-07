import { useState, useEffect, useRef, useCallback } from "react";
import { SessionPanel } from "@/features/session";
import type { SessionPanelRef } from "@/features/session";
import { CollapsibleTerminalPanel } from "@/features/terminal";
import { WelcomeView } from "@/features/repository";
import {
  MainContentTabBar,
  useWorkspaceLayout,
  useFileChanges,
  WorkspaceService,
} from "@/features/workspace";
import { FileChangesPanel } from "@/features/file-changes";
import { FileBrowserPanel, FileViewer } from "@/features/file-browser";
import { BrowserPanel } from "@/features/browser";
import {
  Button,
  SidebarInset,
  Tabs,
  TabsList,
  TabsTrigger,
  TabsContent,
  useSidebar,
} from "@/components/ui";
import { FolderOpen, ChevronsRight } from "lucide-react";
import type { RightPanelTab } from "@/features/workspace/store";
import type { Tab } from "@/features/workspace/ui/MainContentTabs";
import type { Workspace } from "@/shared/types";

interface MainContentProps {
  selectedWorkspace: Workspace | null;
  workspaceChatPanelRef: React.MutableRefObject<SessionPanelRef | null>;
  recentWorkspaces: Workspace[];
  onCreateWorkspace: () => void;
  onOpenProject: () => void;
  onCloneRepository: () => void;
  onWorkspaceClick: (workspace: Workspace) => void;
}

/**
 * Main Content Component - CSS Grid layout with browser-style tabs
 * Grid structure: [Main Content (flexible)] [Right Panel (400px)]
 */
export function MainContent({
  selectedWorkspace,
  workspaceChatPanelRef,
  recentWorkspaces,
  onCreateWorkspace,
  onOpenProject,
  onCloneRepository,
  onWorkspaceClick,
}: MainContentProps) {
  const { open: sidebarOpen, setOpen: setSidebarOpen } = useSidebar();

  // Workspace layout - reads directly from store, no bidirectional sync needed
  const {
    rightPanelTab,
    rightPanelExpanded,
    selectedFilePath,
    setRightPanelTab,
    setRightPanelExpanded,
    setSelectedFilePath,
  } = useWorkspaceLayout(selectedWorkspace?.id ?? null);

  // Fetch file changes for the workspace
  const { data: fileChanges = [] } = useFileChanges(
    selectedWorkspace?.id ?? null,
    selectedWorkspace?.session_status
  );

  // Callback to fetch diff for a specific file
  const fetchDiff = useCallback(
    async (filePath: string) => {
      if (!selectedWorkspace) {
        return { diff: "No workspace selected" };
      }
      try {
        const data = await WorkspaceService.fetchFileDiff(selectedWorkspace.id, filePath);
        return { diff: data.diff || "No diff available" };
      } catch (error) {
        console.error("Failed to fetch diff:", error);
        return { diff: "Error loading diff:" };
      }
    },
    [selectedWorkspace]
  );

  // Selected file for diff viewing (transient data not persisted)
  const [selectedFile, setSelectedFile] = useState<{
    path: string;
    diff: string;
    additions: number;
    deletions: number;
  } | null>(null);

  // Selected file for file browser viewing (full file content from working tree)
  const [browserSelectedFile, setBrowserSelectedFile] = useState<string | null>(null);

  // Track workspace changes to clear stale state
  const prevWorkspaceIdRef = useRef<string | null>(null);

  // State for main content tabs (chat sessions)
  const [mainTabs, setMainTabs] = useState<Tab[]>([
    { id: "chat-1", label: "Chat #1", type: "chat", closeable: false },
  ]);
  const [activeMainTabId, setActiveMainTabId] = useState("chat-1");

  /**
   * Sidebar Auto-Management for Right Panel Expansion
   *
   * UX Goal: Maximize panel space when it expands, restore workspace when it collapses
   *
   * Behavior:
   * 1. Panel expands → save sidebar state, auto-close if open
   * 2. User manually opens sidebar while panel is expanded → respect their choice
   * 3. Panel collapses → restore to saved state if user never reopened sidebar
   */
  const sidebarWasOpenBeforeExpansionRef = useRef(false);
  const prevPanelExpandedRef = useRef(rightPanelExpanded);

  useEffect(() => {
    const panelJustExpanded = rightPanelExpanded && !prevPanelExpandedRef.current;
    const panelJustCollapsed = !rightPanelExpanded && prevPanelExpandedRef.current;

    if (panelJustExpanded) {
      sidebarWasOpenBeforeExpansionRef.current = sidebarOpen;
      if (sidebarOpen) {
        setSidebarOpen(false);
      }
    }

    if (panelJustCollapsed) {
      if (!sidebarOpen && sidebarWasOpenBeforeExpansionRef.current) {
        setSidebarOpen(true);
      }
      sidebarWasOpenBeforeExpansionRef.current = false;
    }

    prevPanelExpandedRef.current = rightPanelExpanded;
  }, [rightPanelExpanded, sidebarOpen, setSidebarOpen]);

  // Handle workspace changes and file validation
  // Using ref comparison to avoid cascading renders
  const currentWorkspaceId = selectedWorkspace?.id ?? null;
  if (currentWorkspaceId !== prevWorkspaceIdRef.current) {
    prevWorkspaceIdRef.current = currentWorkspaceId;
    // Note: selectedFile will be reset via the handlers below
  }

  // Validate selected file exists in current workspace
  useEffect(() => {
    // Early return for no workspace or no file path
    if (!selectedWorkspace || !selectedFilePath) {
      return;
    }

    // Skip validation until file changes are loaded
    if (fileChanges.length === 0) {
      return;
    }

    // Validate file exists in current workspace's file changes
    const fileExists = fileChanges.some((fc) => fc.file === selectedFilePath);
    if (!fileExists) {
      // File doesn't exist in this workspace - clear invalid selection
      setSelectedFilePath(null);
    }
  }, [selectedWorkspace, selectedFilePath, fileChanges, setSelectedFilePath]);

  // Handle branch rename
  const handleBranchRename = (newName: string) => {
    if (import.meta.env.DEV)
      console.log("Branch rename requested:", selectedWorkspace?.branch, "→", newName);
  };

  // Tab management handlers
  const handleMainTabChange = (tabId: string) => {
    setActiveMainTabId(tabId);
  };

  const handleMainTabClose = (tabId: string) => {
    const currentIndex = mainTabs.findIndex((t) => t.id === tabId);
    const newTabs = mainTabs.filter((t) => t.id !== tabId);
    setMainTabs(newTabs);
    if (tabId === activeMainTabId && newTabs.length > 0) {
      const targetIndex = currentIndex > 0 ? currentIndex - 1 : 0;
      setActiveMainTabId(newTabs[targetIndex].id);
    }
  };

  // Monotonic chat index to avoid ID collisions after closes
  const nextChatIndexRef = useRef(2);

  const handleMainTabAdd = () => {
    const idx = nextChatIndexRef.current++;
    const newId = `chat-${idx}`;
    const newTab: Tab = {
      id: newId,
      label: `Chat #${idx}`,
      type: "chat",
      closeable: true,
    };
    setMainTabs((prevTabs) => [...prevTabs, newTab]);
    setActiveMainTabId(newId);
  };

  // Keyboard shortcut: Cmd+T to open new chat tab
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === "t" && selectedWorkspace) {
        const ae = document.activeElement as HTMLElement | null;
        const isTextField =
          !!ae &&
          (ae.tagName === "INPUT" ||
            ae.tagName === "TEXTAREA" ||
            ae.isContentEditable ||
            ae.getAttribute("role") === "textbox");
        if (isTextField) return;

        e.preventDefault();
        handleMainTabAdd();
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [selectedWorkspace]);

  /**
   * Handle tab change in right panel
   */
  const handleRightPanelTabChange = useCallback(
    (tab: RightPanelTab) => {
      const previousTab = rightPanelTab;
      setRightPanelTab(tab);

      // Restore last opened file when returning to Changes tab
      if (
        tab === "changes" &&
        rightPanelExpanded &&
        selectedFilePath &&
        previousTab !== "changes"
      ) {
        setSelectedFile({
          path: selectedFilePath,
          diff: "Loading...",
          additions: 0,
          deletions: 0,
        });
      } else if (tab !== "changes" && tab !== "files") {
        setSelectedFile(null);
      }

      // Auto-expand for browser
      if (tab === "browser" && !rightPanelExpanded) {
        setRightPanelExpanded(true);
      }
    },
    [rightPanelTab, rightPanelExpanded, selectedFilePath, setRightPanelTab, setRightPanelExpanded]
  );

  /**
   * Collapse panel to narrow mode
   */
  const handlePanelCollapse = useCallback(() => {
    setRightPanelExpanded(false);
    setSelectedFile(null);
    setSelectedFilePath(null);
    if (rightPanelTab === "browser") {
      setRightPanelTab("changes");
    }
  }, [rightPanelTab, setRightPanelExpanded, setSelectedFilePath, setRightPanelTab]);

  return (
    <SidebarInset className="min-w-0">
      {/**
       * CSS Grid Layout: Main Content | Right Panel
       *
       * Panel Modes:
       * - Narrow (400px): File list, changes list
       * - Wide (2fr, ~700px+): File diff viewer, browser
       */}
      <div
        className="bg-background/70 border-border/40 min-w-0 flex-1 overflow-hidden rounded-lg border shadow-sm backdrop-blur-[20px] transition-all duration-300 ease-[cubic-bezier(0.23,1,0.32,1)]"
        style={{
          display: "grid",
          gridTemplateColumns: selectedWorkspace
            ? rightPanelExpanded
              ? "minmax(350px, 1fr) minmax(700px, 2fr)"
              : "minmax(500px, 1fr) 400px"
            : "1fr",
          height: "100%",
          gap: "0",
        }}
      >
        {/* MAIN CONTENT AREA - Browser-style tabs for chat sessions */}
        {selectedWorkspace ? (
          <div className="border-border/40 flex h-full flex-col overflow-hidden border-r">
            <MainContentTabBar
              tabs={mainTabs}
              activeTabId={activeMainTabId}
              onTabChange={handleMainTabChange}
              onTabClose={handleMainTabClose}
              onTabAdd={handleMainTabAdd}
              repositoryName={selectedWorkspace.root_path.split("/").filter(Boolean).pop()}
              branch={selectedWorkspace.branch}
              workspacePath={`${selectedWorkspace.root_path}/.conductor/${selectedWorkspace.directory_name}`}
              onBranchRename={handleBranchRename}
            />

            {/* Tab Content - Chat sessions */}
            <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
              {(() => {
                const activeTab = mainTabs.find((t) => t.id === activeMainTabId);
                if (activeTab?.type === "chat") {
                  return selectedWorkspace.active_session_id ? (
                    <SessionPanel
                      ref={workspaceChatPanelRef}
                      sessionId={selectedWorkspace.active_session_id}
                      embedded={true}
                    />
                  ) : null;
                }
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
          <div className="flex h-full flex-col overflow-hidden">
            <Tabs
              value={rightPanelTab}
              onValueChange={(v) => handleRightPanelTabChange(v as RightPanelTab)}
              className="flex min-h-0 flex-1 flex-col overflow-hidden"
            >
              <div className="bg-background/50 border-border flex h-12 flex-shrink-0 items-center border-b backdrop-blur-sm">
                <TabsList className="flex-1">
                  <TabsTrigger value="changes" className="min-w-[88px] justify-center">
                    Changes
                  </TabsTrigger>
                  <TabsTrigger value="files" className="min-w-[88px] justify-center">
                    Files
                  </TabsTrigger>
                  <TabsTrigger value="browser" className="min-w-[88px] justify-center">
                    Browser
                  </TabsTrigger>
                </TabsList>

                {rightPanelExpanded && (
                  <div className="border-border/30 flex h-full items-center border-l px-3">
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

              {/* Tab Content */}
              <>
                {/* Changes Tab - New tree view with unified scroll */}
                <TabsContent
                  value="changes"
                  className="m-0 h-full overflow-hidden data-[state=inactive]:hidden"
                >
                  <FileChangesPanel
                    selectedWorkspace={selectedWorkspace}
                    fileChanges={fileChanges}
                    fetchDiff={fetchDiff}
                    isExpanded={rightPanelExpanded}
                    onFileSelect={(path) => {
                      setSelectedFilePath(path);
                      setRightPanelExpanded(true);
                    }}
                  />
                </TabsContent>

                {/* Files Tab */}
                <TabsContent
                  value="files"
                  className="m-0 h-full overflow-hidden data-[state=inactive]:hidden"
                >
                  <div className="flex h-full overflow-hidden">
                    <div
                      className={`flex-shrink-0 transition-all duration-300 ease-[cubic-bezier(0.23,1,0.32,1)] ${
                        rightPanelExpanded ? "border-border/40 w-[280px] border-r" : "flex-1"
                      }`}
                    >
                      <FileBrowserPanel
                        selectedWorkspace={selectedWorkspace}
                        onFileClick={(path) => {
                          setBrowserSelectedFile(path);
                          setRightPanelExpanded(true);
                        }}
                      />
                    </div>

                    {rightPanelExpanded && (
                      <div className="animate-in slide-in-from-right-2 flex-1 overflow-hidden duration-300">
                        {browserSelectedFile ? (
                          <FileViewer filePath={browserSelectedFile} />
                        ) : (
                          <div className="flex h-full items-center justify-center">
                            <div className="max-w-sm text-center">
                              <FolderOpen className="text-muted-foreground/30 mx-auto mb-4 h-16 w-16" />
                              <h3 className="text-foreground/60 mb-2 text-sm font-medium">
                                Browse and select a file
                              </h3>
                              <p className="text-muted-foreground/50 text-xs">
                                Explore the file tree and click on any file to view it
                              </p>
                            </div>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                </TabsContent>

                {/* Browser Tab */}
                <TabsContent
                  value="browser"
                  className="m-0 h-full overflow-hidden data-[state=inactive]:hidden"
                >
                  <BrowserPanel workspaceId={selectedWorkspace.id} />
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
