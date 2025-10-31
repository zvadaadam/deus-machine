import { useState, useRef, useEffect } from 'react';
import { X, Plus, Globe, FolderGit, Pencil, Sparkles, FileCode } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { SidebarTrigger } from '@/components/ui/sidebar';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { OpenInDropdown } from '@/shared/components';
import { cn } from '@/shared/lib/utils';

/**
 * Tab data structure
 * Supports multiple content types: chat sessions, diffs, and full files
 */
export interface Tab {
  id: string;
  label: string;
  type: 'chat' | 'diff' | 'file';
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
  ICON_SIZE: 'w-3.5 h-3.5',
  GRADIENT_WIDTH: 'w-12',
  CLOSE_BUTTON_OFFSET: 'right-2',
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
}: Omit<MainContentTabsProps, 'children'>) {
  // Branch editing state
  const [isEditingBranch, setIsEditingBranch] = useState(false);
  const [branchInputValue, setBranchInputValue] = useState('');
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
    setBranchInputValue('');
  };

  const handleBranchKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      saveBranchName();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      cancelEditingBranch();
    }
  };

  // Get icon for tab type - Sparkles for chat (AI), FileCode for files
  const getTabIcon = (type: Tab['type']) => {
    const iconClass = cn(TAB_STYLES.ICON_SIZE, 'flex-shrink-0 opacity-60');
    return type === 'chat'
      ? <Sparkles className={iconClass} />
      : <FileCode className={iconClass} />;
  };

  return (
    <TooltipProvider delayDuration={200}>
      <div className="flex flex-col flex-shrink-0">
        {/* ROW 1: Context Bar - Who & Where (48px) */}
        <div className="flex items-center justify-between h-12 px-5 border-b border-border/50 bg-background/50 backdrop-blur-sm">
          {/* Left: Sidebar Trigger */}
          <Button
            variant="ghost"
            size="icon"
            className="h-9 w-9 rounded-lg text-muted-foreground/80 hover:text-foreground hover:bg-muted/10 transition-all duration-200"
            asChild
          >
            <SidebarTrigger />
          </Button>

          {/* Center: Breadcrumb - Repository / Branch (Editable) */}
          {branch && (
            <div className="group flex-1 flex items-center justify-center gap-2 px-6">
              <FolderGit className="h-4 w-4 text-muted-foreground/60 flex-shrink-0" />

              {repositoryName && (
                <>
                  <span className="font-mono text-sm text-muted-foreground/60 flex-shrink-0">
                    {repositoryName}
                  </span>
                  <span className="text-muted-foreground/40 select-none">/</span>
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
                    'font-mono text-sm font-medium text-foreground',
                    'bg-transparent border-none outline-none',
                    'focus:ring-1 focus:ring-primary rounded px-1 -mx-1',
                    'min-w-[100px]'
                  )}
                />
              ) : (
                <button
                  type="button"
                  onClick={startEditingBranch}
                  disabled={!onBranchRename}
                  className={cn(
                    'font-mono text-sm font-medium text-foreground/90',
                    'hover:text-foreground',
                    'transition-colors duration-150 ease-out',
                    onBranchRename && 'cursor-text'
                  )}
                  title={onBranchRename ? "Click to edit branch name" : undefined}
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
                  <Pencil className="h-3.5 w-3.5 text-muted-foreground/40 flex-shrink-0 opacity-0 group-hover:opacity-100 transition-opacity duration-150" />
                </button>
              )}
            </div>
          )}

          {/* Right: Meta Actions */}
          <div className="flex items-center gap-2">
            {/* Browser button removed - now in right panel tabs */}
            {workspacePath && <OpenInDropdown workspacePath={workspacePath} iconOnly />}
          </div>
        </div>

        {/* ROW 2: Navigation Bar - What (44px) */}
        <div className="flex items-center h-11 px-5 border-b border-border/60 bg-background">
          <div className="flex items-center flex-1 min-w-0 overflow-x-auto scrollbar-thin scrollbar-thumb-border scrollbar-track-transparent">
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
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      handleTabClick(tab.id);
                    }
                  }}
                  className={cn(
                    'group relative flex items-center gap-1.5',
                    'px-4 h-11 min-w-[120px] max-w-[200px]',
                    'text-sm font-normal cursor-pointer',
                    'transition-colors duration-200 ease-out',
                    isActive ? 'text-foreground' : 'text-muted-foreground/65 hover:text-muted-foreground'
                  )}
                >
                  {/* Active indicator - bottom border */}
                  {isActive && (
                    <div className="absolute inset-x-0 bottom-0 h-[2px] bg-primary" />
                  )}

                  {/* Tab type icon */}
                  {getTabIcon(tab.type)}

                  {/* Tab label with gradient fade */}
                  <div className="relative flex-1 min-w-0">
                    <span className="block truncate">
                      {tab.label}
                    </span>

                    {/* Gradient fade overlay - only for closeable tabs */}
                    {tab.closeable !== false && (
                      <div className={cn(
                        'absolute inset-y-0 right-0 pointer-events-none',
                        TAB_STYLES.GRADIENT_WIDTH,
                        'bg-gradient-to-l from-background via-background/90 to-transparent',
                        'opacity-0 transition-opacity duration-150 ease-out',
                        'group-hover:opacity-100'
                      )} />
                    )}
                  </div>

                  {/* Close button - absolutely positioned on right edge */}
                  {tab.closeable !== false && (
                    <button
                      type="button"
                      onClick={(e) => handleTabClose(e, tab.id)}
                      className={cn(
                        'absolute flex items-center justify-center w-4 h-4 rounded-sm',
                        TAB_STYLES.CLOSE_BUTTON_OFFSET,
                        'transition-all duration-150 ease-out',
                        'hover:bg-muted-foreground/20',
                        'opacity-0 group-hover:opacity-100'
                      )}
                      aria-label={`Close ${tab.label} tab`}
                    >
                      <X className="w-3 h-3" />
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
                      'flex items-center justify-center',
                      'px-4 h-11 flex-shrink-0',
                      'text-muted-foreground/60 hover:text-muted-foreground',
                      'hover:bg-muted/10',
                      'transition-all duration-200 ease-out'
                    )}
                  >
                    <Plus className="w-4 h-4" />
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
    <div className="flex flex-col h-full">
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
      <div className="flex-1 min-h-0 overflow-hidden">
        {children}
      </div>
    </div>
  );
}
