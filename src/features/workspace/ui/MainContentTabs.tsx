import { useState, useRef, useEffect } from "react";
import {
  X,
  Plus,
  GitBranch,
  Pencil,
  Sparkles,
  FileCode,
  GitCompareArrows,
  PanelLeft,
} from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useSidebar } from "@/components/ui/sidebar";
import { OpenInDropdown } from "@/shared/components";
import { cn } from "@/shared/lib/utils";

/**
 * Tab data structure
 * Supports multiple content types: chat sessions, diffs, and full files
 */
export interface Tab {
  id: string;
  label: string;
  type: "chat" | "diff" | "file";
  closeable?: boolean;

  /**
   * Type-specific data payload
   * - For 'diff' tabs: file path, diff content, and change stats
   * - For 'file' tabs: file content and language (future)
   * - For 'chat' tabs: session ID
   */
  data?: {
    // For 'diff' tabs
    filePath?: string;
    diff?: string;
    additions?: number;
    deletions?: number;

    // For 'file' tabs (future feature)
    fileContent?: string;
    language?: string;

    // For 'chat' tabs
    sessionId?: string;
  };
}

/**
 * MainContentTabs Props
 */
interface MainContentTabsProps {
  tabs: Tab[];
  activeTabId: string;
  onTabChange: (tabId: string) => void;
  onTabClose?: (tabId: string) => void;
  onTabAdd?: () => void;
  children: React.ReactNode;
  // Workspace context (merged from WorkspaceHeader)
  repositoryName?: string;
  branch?: string;
  workspacePath?: string;
  onBranchRename?: (newName: string) => void;
}

// Tab styling constants for easier maintenance
const TAB_STYLES = {
  ICON_SIZE: "w-3.5 h-3.5",
  GRADIENT_WIDTH: "w-12",
  CLOSE_BUTTON_OFFSET: "right-2",
} as const;

/**
 * MainContentTabBar - Browser-style tab bar for main content area
 *
 * Design Philosophy (Jony Ive Refinements):
 * - Restraint: Subtle borders, no decorative effects
 * - Consistency: Unified opacity scale (/60 muted, /20 subtle)
 * - Lightness: Regular font weight, minimal hover states
 * - Clarity: Active state through color only, no background jumps
 * - One signal: Bottom indicator for active state
 */
export function MainContentTabBar({
  tabs,
  activeTabId,
  onTabChange,
  onTabClose,
  onTabAdd,
  repositoryName,
  branch,
  workspacePath,
  onBranchRename,
}: Omit<MainContentTabsProps, "children">) {
  const { state: sidebarState, toggleSidebar } = useSidebar();
  const sidebarCollapsed = sidebarState === "collapsed";

  // Branch editing state
  const [isEditingBranch, setIsEditingBranch] = useState(false);
  const [branchInputValue, setBranchInputValue] = useState("");
  const branchInputRef = useRef<HTMLInputElement>(null);

  // Auto-focus input when editing starts
  useEffect(() => {
    if (isEditingBranch && branchInputRef.current) {
      branchInputRef.current.focus();
      branchInputRef.current.select();
    }
  }, [isEditingBranch]);

  const handleTabClick = (tabId: string) => {
    onTabChange(tabId);
  };

  const handleTabClose = (e: React.MouseEvent, tabId: string) => {
    e.stopPropagation();
    onTabClose?.(tabId);
  };

  const handleAddTab = () => {
    onTabAdd?.();
  };

  // Branch editing handlers
  const startEditingBranch = () => {
    if (branch && onBranchRename) {
      setBranchInputValue(branch);
      setIsEditingBranch(true);
    }
  };

  const saveBranchName = () => {
    const trimmed = branchInputValue.trim();
    if (trimmed && trimmed !== branch && onBranchRename) {
      onBranchRename(trimmed);
    }
    setIsEditingBranch(false);
  };

  const cancelEditingBranch = () => {
    setIsEditingBranch(false);
    setBranchInputValue("");
  };

  const handleBranchKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      saveBranchName();
    } else if (e.key === "Escape") {
      e.preventDefault();
      cancelEditingBranch();
    }
  };

  // Get icon for tab type - Sparkles for chat (AI), GitCompareArrows for diffs, FileCode for files
  const getTabIcon = (type: Tab["type"]) => {
    const iconClass = cn(TAB_STYLES.ICON_SIZE, "flex-shrink-0 opacity-60");
    switch (type) {
      case "chat":
        return <Sparkles className={iconClass} />;
      case "diff":
        return <GitCompareArrows className={iconClass} />;
      default:
        return <FileCode className={iconClass} />;
    }
  };

  return (
    <div className="flex flex-shrink-0 flex-col">
      {/* ROW 1: Context Bar — V2: Jony Ive (44px) */}
      <div className="border-border-subtle bg-bg-elevated/80 relative flex h-11 items-center justify-start gap-2 border-b px-4">
        {/* Sidebar toggle - visible when sidebar is collapsed */}
        {sidebarCollapsed && (
          <Tooltip delayDuration={200}>
            <TooltipTrigger asChild>
              <button
                type="button"
                aria-label="Expand sidebar"
                onClick={toggleSidebar}
                className="text-text-muted hover:text-text-secondary hover:bg-bg-muted -ml-1 flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-md transition-colors duration-150"
              >
                <PanelLeft className="h-4 w-4" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              <p className="text-xs">Open sidebar (⌘B)</p>
            </TooltipContent>
          </Tooltip>
        )}

        {/* Breadcrumb: repo / branch */}
        {branch && (
          <div className="group flex items-center gap-1.5">
            <GitBranch className="text-text-muted h-3.5 w-3.5 flex-shrink-0" />

            {repositoryName && (
              <>
                <span
                  className="text-text-secondary max-w-[200px] truncate text-[13px] font-normal"
                  title={repositoryName}
                >
                  {repositoryName}
                </span>
                <span className="text-text-muted flex-shrink-0 text-[13px] select-none">/</span>
              </>
            )}

            {/* Branch name - inline editing */}
            {isEditingBranch ? (
              <input
                ref={branchInputRef}
                type="text"
                aria-label="Edit branch name"
                value={branchInputValue}
                onChange={(e) => setBranchInputValue(e.target.value)}
                onKeyDown={handleBranchKeyDown}
                onBlur={saveBranchName}
                className={cn(
                  "text-text-primary text-[13px] font-medium",
                  "border-none bg-transparent outline-none",
                  "focus:ring-primary -mx-1 rounded px-1 focus:ring-1",
                  "min-w-[100px]"
                )}
              />
            ) : (
              <button
                type="button"
                onClick={startEditingBranch}
                disabled={!onBranchRename}
                className={cn(
                  "text-text-muted max-w-[200px] truncate text-[13px] font-normal",
                  "hover:text-text-secondary",
                  "transition-colors duration-150",
                  onBranchRename && "cursor-text"
                )}
                title={onBranchRename ? `${branch} — click to edit` : branch}
              >
                {branch}
              </button>
            )}

            {/* Edit pencil icon */}
            {!isEditingBranch && onBranchRename && (
              <button
                type="button"
                aria-label="Rename branch"
                onClick={startEditingBranch}
                className="flex items-center justify-center"
              >
                <Pencil className="text-text-disabled h-3 w-3 flex-shrink-0 opacity-0 transition-opacity duration-150 group-hover:opacity-100" />
              </button>
            )}
          </div>
        )}

        {/* Right: Meta Actions */}
        {workspacePath && (
          <div className="absolute right-5 flex items-center gap-3">
            <OpenInDropdown workspacePath={workspacePath} iconOnly />
          </div>
        )}
      </div>

      {/* ROW 2: Navigation Tabs — V2: Jony Ive (36px) */}
      <div className="bg-bg-elevated flex h-9 items-center px-2.5">
        <div
          role="tablist"
          className="scrollbar-hidden flex min-w-0 flex-1 items-center overflow-x-auto"
        >
          {tabs.map((tab) => {
            const isActive = tab.id === activeTabId;

            return (
              <div
                key={tab.id}
                role="tab"
                aria-selected={isActive}
                tabIndex={0}
                onClick={() => handleTabClick(tab.id)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    handleTabClick(tab.id);
                  }
                }}
                className={cn(
                  "group relative flex items-center gap-1.5",
                  "h-7 max-w-[200px] min-w-[100px] rounded-md px-2",
                  "cursor-pointer text-[13px] font-normal",
                  "transition-colors duration-150",
                  isActive
                    ? "bg-bg-raised text-text-secondary"
                    : "text-text-muted hover:text-text-tertiary"
                )}
              >
                {/* Tab type icon */}
                {getTabIcon(tab.type)}

                {/* Tab label */}
                <div className="relative min-w-0 flex-1">
                  <span className="block truncate">{tab.label}</span>
                </div>

                {/* Close button */}
                {tab.closeable !== false && (
                  <button
                    type="button"
                    onClick={(e) => handleTabClose(e, tab.id)}
                    className={cn(
                      "flex h-4 w-4 items-center justify-center rounded-sm",
                      "transition-all duration-150",
                      "hover:bg-bg-muted",
                      "opacity-0 group-hover:opacity-100"
                    )}
                    aria-label={`Close ${tab.label} tab`}
                  >
                    <X className="h-3 w-3" />
                  </button>
                )}
              </div>
            );
          })}

          {/* Add tab button */}
          {onTabAdd && (
            <Tooltip delayDuration={200}>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  aria-label="New chat tab"
                  onClick={handleAddTab}
                  className={cn(
                    "flex items-center justify-center",
                    "h-7 flex-shrink-0 rounded-md px-1.5",
                    "text-text-disabled hover:text-text-muted",
                    "transition-colors duration-150"
                  )}
                >
                  <Plus className="h-4 w-4" />
                </button>
              </TooltipTrigger>
              <TooltipContent side="bottom">
                <p className="text-xs">New chat (⌘T)</p>
              </TooltipContent>
            </Tooltip>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * Legacy wrapper for backward compatibility
 * @deprecated Use MainContentTabBar directly for better control
 */
export function MainContentTabs({
  tabs,
  activeTabId,
  onTabChange,
  onTabClose,
  onTabAdd,
  children,
  repositoryName,
  branch,
  workspacePath,
  onBranchRename,
}: MainContentTabsProps) {
  return (
    <div className="flex h-full flex-col">
      <MainContentTabBar
        tabs={tabs}
        activeTabId={activeTabId}
        onTabChange={onTabChange}
        onTabClose={onTabClose}
        onTabAdd={onTabAdd}
        repositoryName={repositoryName}
        branch={branch}
        workspacePath={workspacePath}
        onBranchRename={onBranchRename}
      />
      <div className="min-h-0 flex-1 overflow-hidden">{children}</div>
    </div>
  );
}
