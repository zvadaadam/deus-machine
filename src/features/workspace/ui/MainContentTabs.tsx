import { useState, useRef, useEffect } from "react";
import { X, Plus, Globe, FolderGit, Pencil, Sparkles, FileCode } from "lucide-react";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
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

  // Get icon for tab type - Sparkles for chat (AI), FileCode for files
  const getTabIcon = (type: Tab["type"]) => {
    const iconClass = cn(TAB_STYLES.ICON_SIZE, "flex-shrink-0 opacity-60");
    return type === "chat" ? (
      <Sparkles className={iconClass} />
    ) : (
      <FileCode className={iconClass} />
    );
  };

  return (
    <TooltipProvider delayDuration={200}>
      <div className="flex flex-shrink-0 flex-col">
        {/* ROW 1: Context Bar - Who & Where (48px) */}
        <div className="border-border/50 bg-background/50 relative flex h-12 items-center justify-center border-b px-5 backdrop-blur-sm">
          {/* Center: Breadcrumb - Repository / Branch (Editable) */}
          {/* max-w prevents overlap with absolutely positioned right actions */}
          {branch && (
            <div className="group flex max-w-[calc(100%-100px)] items-center justify-center gap-2">
              <FolderGit className="text-muted-foreground/60 h-4 w-4 flex-shrink-0" />

              {repositoryName && (
                <>
                  <span
                    className="text-muted-foreground/60 max-w-[200px] truncate font-mono text-sm"
                    title={repositoryName}
                  >
                    {repositoryName}
                  </span>
                  <span className="text-muted-foreground/40 flex-shrink-0 select-none">/</span>
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
                    "text-foreground font-mono text-sm font-medium",
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
                    "text-foreground/90 max-w-[200px] truncate font-mono text-sm font-medium",
                    "hover:text-foreground",
                    "transition-colors duration-150 ease-out",
                    onBranchRename && "cursor-text"
                  )}
                  title={branch}
                >
                  {branch}
                </button>
              )}

              {/* Edit pencil icon - only show when not editing and onBranchRename is provided */}
              {!isEditingBranch && onBranchRename && (
                <button
                  type="button"
                  aria-label="Rename branch"
                  onClick={startEditingBranch}
                  className="flex items-center justify-center"
                >
                  <Pencil className="text-muted-foreground/40 h-3.5 w-3.5 flex-shrink-0 opacity-0 transition-opacity duration-150 group-hover:opacity-100" />
                </button>
              )}
            </div>
          )}

          {/* Right: Meta Actions - positioned absolutely to not affect centering */}
          {workspacePath && (
            <div className="absolute right-5 flex items-center gap-2">
              <OpenInDropdown workspacePath={workspacePath} iconOnly />
            </div>
          )}
        </div>

        {/* ROW 2: Navigation Bar - What (44px) */}
        <div className="border-border/60 bg-background flex h-11 items-center border-b px-5">
          <div className="scrollbar-thin scrollbar-thumb-border scrollbar-track-transparent flex min-w-0 flex-1 items-center overflow-x-auto">
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
                    "h-11 max-w-[200px] min-w-[120px] px-4",
                    "cursor-pointer text-sm font-normal",
                    "transition-colors duration-200 ease-out",
                    isActive
                      ? "text-foreground"
                      : "text-muted-foreground/65 hover:text-muted-foreground"
                  )}
                >
                  {/* Active indicator - bottom border */}
                  {isActive && <div className="bg-primary absolute inset-x-0 bottom-0 h-[2px]" />}

                  {/* Tab type icon */}
                  {getTabIcon(tab.type)}

                  {/* Tab label with gradient fade */}
                  <div className="relative min-w-0 flex-1">
                    <span className="block truncate">{tab.label}</span>

                    {/* Gradient fade overlay - only for closeable tabs */}
                    {tab.closeable !== false && (
                      <div
                        className={cn(
                          "pointer-events-none absolute inset-y-0 right-0",
                          TAB_STYLES.GRADIENT_WIDTH,
                          "from-background via-background/90 bg-gradient-to-l to-transparent",
                          "opacity-0 transition-opacity duration-150 ease-out",
                          "group-hover:opacity-100"
                        )}
                      />
                    )}
                  </div>

                  {/* Close button - absolutely positioned on right edge */}
                  {tab.closeable !== false && (
                    <button
                      type="button"
                      onClick={(e) => handleTabClose(e, tab.id)}
                      className={cn(
                        "absolute flex h-4 w-4 items-center justify-center rounded-sm",
                        TAB_STYLES.CLOSE_BUTTON_OFFSET,
                        "transition-all duration-150 ease-out",
                        "hover:bg-muted-foreground/20",
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
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    aria-label="New chat tab"
                    onClick={handleAddTab}
                    className={cn(
                      "flex items-center justify-center",
                      "h-11 flex-shrink-0 px-4",
                      "text-muted-foreground/60 hover:text-muted-foreground",
                      "hover:bg-muted/10",
                      "transition-all duration-200 ease-out"
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
    </TooltipProvider>
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
