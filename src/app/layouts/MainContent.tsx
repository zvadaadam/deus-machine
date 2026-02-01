import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { toast } from "sonner";
import { SessionPanel } from "@/features/session";
import type { SessionPanelRef } from "@/features/session";
import { TerminalPanel } from "@/features/terminal";
import { WelcomeView } from "@/features/repository";
import {
  MainContentTabBar,
  useWorkspaceLayout,
  useFileChanges,
  WorkspaceService,
  useResizeHandle,
} from "@/features/workspace";
import { ConfigPanel } from "@/features/workspace/ui/ConfigPanel";
import { DesignPanel } from "@/features/workspace/ui/DesignPanel";
import { PRStatusBar } from "@/features/workspace/ui/PRStatusBar";
import { RightSidecar } from "@/features/workspace/ui/RightSidecar";
import { FileChangesPanel } from "@/features/file-changes";
import { FileBrowserPanel, FileViewer } from "@/features/file-browser";
import { BrowserPanel } from "@/features/browser";
import { SidebarInset, Tabs, TabsContent, useSidebar } from "@/components/ui";
import { FolderOpen, PanelLeft } from "lucide-react";
import { cn } from "@/shared/lib/utils";
import type { RightPanelTab, RightSideTab } from "@/features/workspace/store";
import type { Tab } from "@/features/workspace/ui/MainContentTabs";
import type { Workspace, PRStatus } from "@/shared/types";

interface MainContentProps {
  selectedWorkspace: Workspace | null;
  prStatus: PRStatus | null;
  workspaceChatPanelRef: React.MutableRefObject<SessionPanelRef | null>;
  onCreateWorkspace: () => void;
  onOpenProject: () => void;
  onCloneRepository: () => void;
}

/**
 * Main Content Component - CSS Grid layout with browser-style tabs
 * Grid structure: [Main Content (flexible)] [Right Panel (400px)]
 */
export function MainContent({
  selectedWorkspace,
  prStatus,
  workspaceChatPanelRef,
  onCreateWorkspace,
  onOpenProject,
  onCloneRepository,
}: MainContentProps) {
  const { open: sidebarOpen, setOpen: setSidebarOpen, toggleSidebar } = useSidebar();

  // Workspace layout - reads directly from store, no bidirectional sync needed
  const selectedWorkspaceId = selectedWorkspace?.id ?? null;

  const {
    rightSideTab,
    rightPanelTab,
    rightPanelExpanded,
    selectedFilePath,
    rightPanelWidth,
    setRightSideTab,
    setRightPanelTab,
    setRightPanelExpanded,
    setSelectedFilePath,
    setRightPanelWidth,
  } = useWorkspaceLayout(selectedWorkspaceId);

  // Fetch file changes for the workspace
  const { data: fileChangesData } = useFileChanges(
    selectedWorkspaceId,
    selectedWorkspace?.session_status
  );
  // Stable empty array reference to prevent unnecessary re-renders in child effects
  const fileChanges = useMemo(() => fileChangesData ?? [], [fileChangesData]);

  // Callback to fetch diff for a specific file
  const fetchDiff = useCallback(
    async (filePath: string) => {
      if (!selectedWorkspaceId) {
        throw new Error("No workspace selected");
      }
      try {
        const data = await WorkspaceService.fetchFileDiff(selectedWorkspaceId, filePath);
        return {
          diff: data.diff ?? "",
          oldContent: data.oldContent ?? null,
          newContent: data.newContent ?? null,
        };
      } catch (error) {
        console.error("Failed to fetch diff:", error);
        throw error instanceof Error ? error : new Error("Unknown error");
      }
    },
    [selectedWorkspaceId]
  );

  // Selected file for file browser viewing (full file content from working tree)
  const [browserSelectedFile, setBrowserSelectedFile] = useState<string | null>(null);

  // Track workspace changes to clear stale state
  const prevWorkspaceIdRef = useRef<string | null>(null);

  // State for main content tabs (chat sessions)
  const [mainTabs, setMainTabs] = useState<Tab[]>([
    { id: "chat-1", label: "Chat #1", type: "chat", closeable: false },
  ]);
  const [activeMainTabId, setActiveMainTabId] = useState("chat-1");
  const createPRHandlerRef = useRef<(() => void) | null>(null);
  const [hasCreatePRHandler, setHasCreatePRHandler] = useState(false);

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

  // Track workspace changes - clear stale file selections
  const currentWorkspaceId = selectedWorkspace?.id ?? null;
  useEffect(() => {
    if (currentWorkspaceId !== prevWorkspaceIdRef.current) {
      prevWorkspaceIdRef.current = currentWorkspaceId;

      setBrowserSelectedFile(null);
      createPRHandlerRef.current = null;

      setHasCreatePRHandler(false);
    }
  }, [currentWorkspaceId]);

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

  const handleMainTabAdd = useCallback(() => {
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
  }, []);

  const handleCreatePR = useCallback(() => {
    const handler = createPRHandlerRef.current;
    if (!handler) {
      toast.error("No active session available to create a PR.");
      return;
    }
    handler();
  }, []);

  const handleOpenPR = useCallback(() => {
    if (!prStatus?.pr_url) {
      toast.error("PR link not available.");
      return;
    }
    window.open(prStatus.pr_url, "_blank", "noopener,noreferrer");
  }, [prStatus]);

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
  }, [handleMainTabAdd, selectedWorkspace]);

  /**
   * Handle file selection from FileChangesPanel.
   * Memoized to prevent unstable callback reference from re-triggering child effects.
   */
  const handleFileSelect = useCallback(
    (path: string | null) => {
      setSelectedFilePath(path);
      // Only update if actually changing — prevents unnecessary store writes
      // that create new object references and cascade re-renders
      if (!rightPanelExpanded) {
        setRightPanelExpanded(true);
      }
    },
    [setSelectedFilePath, setRightPanelExpanded, rightPanelExpanded]
  );

  /**
   * Handle tab change in code panel
   */
  const handleCodeTabChange = useCallback(
    (tab: RightPanelTab) => {
      setRightPanelTab(tab);
    },
    [setRightPanelTab]
  );

  /**
   * Handle tab change in right side panel
   */
  const handleRightSideTabChange = useCallback(
    (tab: RightSideTab) => {
      setRightSideTab(tab);
      if (tab !== "code" && tab !== "browser") {
        setSelectedFilePath(null);
      }
    },
    [setRightSideTab, setSelectedFilePath]
  );

  useEffect(() => {
    if (rightSideTab === "browser" && !rightPanelExpanded) {
      setRightPanelExpanded(true);
    }
    if (rightSideTab !== "code" && rightSideTab !== "browser" && rightPanelExpanded) {
      setRightPanelExpanded(false);
    }
    // setRightPanelExpanded is a stable callback (module-level action), safe to omit
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rightPanelExpanded, rightSideTab]);

  /**
   * Collapse panel to narrow mode
   */
  const handlePanelCollapse = useCallback(() => {
    setRightPanelExpanded(false);
    setSelectedFilePath(null);
    setRightPanelWidth(null);
  }, [setRightPanelExpanded, setSelectedFilePath, setRightPanelWidth]);

  const panelWide = rightPanelExpanded && (rightSideTab === "code" || rightSideTab === "browser");

  // Resize handle for dragging the chat/panel split
  const { handleProps: resizeHandleProps, isDragging } = useResizeHandle({
    onWidthChange: setRightPanelWidth,
    enabled: panelWide,
  });

  // Right panel width: user-set pixels, auto flex, or narrow fixed
  // No flexShrink: 0 — allows the panel to shrink when space is tight
  // (e.g., sidebar opens while panel is large). CSS min-w-[450px] protects the sidecar.
  const rightPanelStyle: React.CSSProperties | undefined =
    panelWide && rightPanelWidth !== null ? { width: rightPanelWidth } : undefined;

  return (
    <SidebarInset className="min-w-0">
      <div
        data-slot="main-content"
        className="bg-background/40 border-border/5 flex h-full min-w-0 flex-1 overflow-hidden rounded-lg border"
      >
        {/* Sidebar toggle - visible when sidebar is collapsed and no workspace tab bar is shown */}
        {!sidebarOpen && !selectedWorkspace && (
          <button
            type="button"
            aria-label="Expand sidebar"
            onClick={toggleSidebar}
            className="text-muted-foreground/60 hover:text-foreground hover:bg-foreground/5 absolute top-3 left-3 z-10 flex h-7 w-7 items-center justify-center rounded-md transition-colors duration-200 ease-out"
          >
            <PanelLeft className="h-4 w-4" />
          </button>
        )}

        <div className="flex min-w-0 flex-1">
          {/* MAIN CONTENT AREA - Browser-style tabs for chat sessions */}
          {selectedWorkspace ? (
            <div
              className={cn(
                "border-border/40 flex h-full flex-1 flex-col overflow-hidden",
                panelWide ? "min-w-[300px]" : "min-w-0 border-r"
              )}
            >
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
                        onCreatePR={(handler) => {
                          createPRHandlerRef.current = handler;
                          setHasCreatePRHandler(true);
                        }}
                      />
                    ) : null;
                  }
                  return null;
                })()}
              </div>
            </div>
          ) : (
            <WelcomeView
              onCreateWorkspace={onCreateWorkspace}
              onOpenProject={onOpenProject}
              onCloneRepository={onCloneRepository}
            />
          )}

          {/* RESIZE HANDLE - Drag to resize chat/panel split */}
          {selectedWorkspace && panelWide && (
            <div
              {...resizeHandleProps}
              className="group relative z-10 flex w-0 flex-shrink-0 cursor-col-resize items-center justify-center"
              aria-label="Resize panels"
              role="separator"
              aria-orientation="vertical"
            >
              {/* Hit target for easier grabbing */}
              <div className="absolute inset-y-0 w-3 -translate-x-1/2" />
              {/* Visual indicator line */}
              <div
                className={cn(
                  "absolute inset-y-0 w-[3px] -translate-x-1/2 rounded-full transition-opacity duration-200 ease-[ease]",
                  isDragging
                    ? "bg-primary/40 opacity-100"
                    : "bg-border opacity-0 group-hover:opacity-100"
                )}
              />
            </div>
          )}

          {/* RIGHT PANEL - PR bar + Sidecar-driven panels */}
          {selectedWorkspace && (
            <div
              className={cn(
                "border-border/40 flex h-full flex-col",
                panelWide
                  ? rightPanelWidth !== null
                    ? "min-w-[450px]"
                    : "min-w-[450px] flex-1"
                  : "min-w-0 border-l"
              )}
              style={rightPanelStyle}
            >
              <PRStatusBar
                prStatus={prStatus}
                onCreatePR={hasCreatePRHandler ? handleCreatePR : undefined}
                onReviewPR={handleOpenPR}
              />

              <div className="flex min-h-0 flex-1 overflow-hidden">
                <div
                  className={cn(
                    "bg-background/50 border-border/40 flex h-full flex-col overflow-hidden backdrop-blur-sm",
                    !isDragging &&
                      "transition-[width,flex,min-width] duration-300 ease-[cubic-bezier(0.23,1,0.32,1)]",
                    panelWide ? "min-w-0 flex-1" : "w-[380px]"
                  )}
                >
                  {rightSideTab === "code" && (
                    <Tabs
                      value={rightPanelTab}
                      onValueChange={(v) => handleCodeTabChange(v as RightPanelTab)}
                      className="flex min-h-0 flex-1 flex-col overflow-hidden"
                    >
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
                            isExpanded={panelWide}
                            onFileSelect={handleFileSelect}
                            onDiffClose={handlePanelCollapse}
                            headerSlot={
                              <div className="border-border/40 flex h-9 flex-shrink-0 items-center gap-1 border-b px-2">
                                <button
                                  onClick={() => handleCodeTabChange("changes")}
                                  className={cn(
                                    "inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs transition-colors duration-200 ease-[ease]",
                                    rightPanelTab === "changes"
                                      ? "bg-accent text-foreground font-medium"
                                      : "text-muted-foreground/60 hover:text-muted-foreground"
                                  )}
                                >
                                  Changes
                                  {fileChanges.length > 0 && (
                                    <span className="bg-muted-foreground/20 text-muted-foreground rounded px-1.5 py-0.5 text-[10px] leading-none font-medium">
                                      {fileChanges.length}
                                    </span>
                                  )}
                                </button>
                                <button
                                  onClick={() => handleCodeTabChange("files")}
                                  className={cn(
                                    "inline-flex items-center rounded-md px-2.5 py-1 text-xs transition-colors duration-200 ease-[ease]",
                                    rightPanelTab === "files"
                                      ? "bg-accent text-foreground font-medium"
                                      : "text-muted-foreground/60 hover:text-muted-foreground"
                                  )}
                                >
                                  All files
                                </button>
                              </div>
                            }
                          />
                        </TabsContent>

                        {/* Files Tab */}
                        <TabsContent
                          value="files"
                          className="m-0 h-full overflow-hidden data-[state=inactive]:hidden"
                        >
                          <div className="flex h-full overflow-hidden">
                            <div
                              className={cn(
                                "flex flex-shrink-0 flex-col overflow-hidden transition-[width,flex] duration-300 ease-[cubic-bezier(0.23,1,0.32,1)]",
                                panelWide ? "border-border/40 w-[280px] border-r" : "flex-1"
                              )}
                            >
                              <div className="border-border/40 flex h-9 flex-shrink-0 items-center gap-1 border-b px-2">
                                <button
                                  onClick={() => handleCodeTabChange("changes")}
                                  className={cn(
                                    "inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs transition-colors duration-200 ease-[ease]",
                                    rightPanelTab === "changes"
                                      ? "bg-accent text-foreground font-medium"
                                      : "text-muted-foreground/60 hover:text-muted-foreground"
                                  )}
                                >
                                  Changes
                                  {fileChanges.length > 0 && (
                                    <span className="bg-muted-foreground/20 text-muted-foreground rounded px-1.5 py-0.5 text-[10px] leading-none font-medium">
                                      {fileChanges.length}
                                    </span>
                                  )}
                                </button>
                                <button
                                  onClick={() => handleCodeTabChange("files")}
                                  className={cn(
                                    "inline-flex items-center rounded-md px-2.5 py-1 text-xs transition-colors duration-200 ease-[ease]",
                                    rightPanelTab === "files"
                                      ? "bg-accent text-foreground font-medium"
                                      : "text-muted-foreground/60 hover:text-muted-foreground"
                                  )}
                                >
                                  All files
                                </button>
                              </div>
                              <div className="flex-1 overflow-hidden">
                                <FileBrowserPanel
                                  selectedWorkspace={selectedWorkspace}
                                  onFileClick={(path) => {
                                    setBrowserSelectedFile(path);
                                    setRightPanelExpanded(true);
                                  }}
                                />
                              </div>
                            </div>

                            {panelWide && (
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
                      </>
                    </Tabs>
                  )}

                  {rightSideTab === "browser" && (
                    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
                      <BrowserPanel workspaceId={selectedWorkspace.id} />
                    </div>
                  )}

                  {rightSideTab === "terminal" && (
                    <TerminalPanel
                      workspacePath={`${selectedWorkspace.root_path}/.conductor/${selectedWorkspace.directory_name}`}
                    />
                  )}

                  {rightSideTab === "config" && <ConfigPanel />}

                  {rightSideTab === "design" && <DesignPanel workspaceId={selectedWorkspace.id} />}
                </div>

                <RightSidecar activeTab={rightSideTab} onTabChange={handleRightSideTabChange} />
              </div>
            </div>
          )}
        </div>
      </div>
    </SidebarInset>
  );
}
