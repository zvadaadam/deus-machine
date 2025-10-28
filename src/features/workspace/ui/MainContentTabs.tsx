import { useState } from 'react';
import { X, Plus, Globe } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { SidebarTrigger } from '@/components/ui/sidebar';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { BranchName, OpenInDropdown } from '@/shared/components';
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
  branch?: string;
  workspacePath?: string;
  isBrowserOpen?: boolean;
  onBrowserToggle?: () => void;
}

/**
 * MainContentTabBar - Browser-style tab bar for main content area
 *
 * Design Philosophy (Jony Ive Refinements):
 * - Restraint: Subtle borders, no decorative effects
 * - Consistency: Unified opacity scale (/60 muted, /20 subtle)
 * - Lightness: Regular font weight, minimal hover states
 * - Clarity: Active state through color only, no background jumps
 *
 * Changes from previous version:
 * - Removed backdrop-blur (decorative, serves no purpose)
 * - Border opacity: /60 → full (confident, visible)
 * - Background: /80 → full (no semi-transparency)
 * - Font weight: medium → normal (lighter feel)
 * - Padding: py-2.5 → py-2 (tighter, less chunky)
 * - Hover: bg-muted/50 → bg-muted/10 (subtle)
 * - Active: bg-background → no background (color only)
 * - Border dividers: /40 → /20 (more subtle)
 */
export function MainContentTabBar({
  tabs,
  activeTabId,
  onTabChange,
  onTabClose,
  onTabAdd,
  branch,
  workspacePath,
  isBrowserOpen,
  onBrowserToggle,
}: Omit<MainContentTabsProps, 'children'>) {
  const [hoveredTabId, setHoveredTabId] = useState<string | null>(null);

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

  return (
    <div className="flex items-center border-b border-border/50 bg-background flex-shrink-0 px-4 py-2 gap-4">
      {/* LEFT: Sidebar trigger + Branch name */}
      {branch && (
        <div className="flex items-center gap-2">
          <SidebarTrigger />
          <BranchName branch={branch} compact />
        </div>
      )}

      {/* MIDDLE: Tabs */}
      <div className="flex items-center flex-1 min-w-0 overflow-x-auto scrollbar-thin scrollbar-thumb-border scrollbar-track-transparent">
        {tabs.map((tab) => {
          const isActive = tab.id === activeTabId;
          const isHovered = tab.id === hoveredTabId;

          return (
            <button
              key={tab.id}
              onClick={() => handleTabClick(tab.id)}
              onMouseEnter={() => setHoveredTabId(tab.id)}
              onMouseLeave={() => setHoveredTabId(null)}
              className={cn(
                'group relative flex items-center gap-2 px-3 py-2 min-w-[100px] max-w-[180px]',
                'border-r border-border/20',
                'transition-colors duration-200',
                'hover:bg-muted/10',
                isActive ? 'text-foreground' : 'text-muted-foreground/60'
              )}
            >
              {/* Active indicator - subtle top border */}
              {isActive && (
                <div className="absolute inset-x-0 top-0 h-[2px] bg-primary" />
              )}

              {/* Tab label - regular font weight for lightness */}
              <span className="flex-1 text-sm truncate">
                {tab.label}
              </span>

              {/* Close button - appears on hover */}
              {tab.closeable !== false && (
                <button
                  type="button"
                  onClick={(e) => handleTabClose(e, tab.id)}
                  className={cn(
                    'flex items-center justify-center w-4 h-4 rounded-sm',
                    'transition-opacity duration-150',
                    'hover:bg-muted-foreground/20',
                    isActive || isHovered ? 'opacity-100' : 'opacity-0'
                  )}
                  aria-label={`Close ${tab.label} tab`}
                >
                  <X className="w-3 h-3" />
                </button>
              )}
            </button>
          );
        })}

        {/* Add tab button */}
        {onTabAdd && (
          <Button
            variant="ghost"
            size="sm"
            onClick={handleAddTab}
            className="h-8 px-2 shrink-0 border-r border-border/20"
          >
            <Plus className="w-4 h-4" />
          </Button>
        )}
      </div>

      {/* RIGHT: Action buttons */}
      <div className="flex items-center gap-1">
        {onBrowserToggle && (
          <TooltipProvider delayDuration={200}>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant={isBrowserOpen ? "default" : "ghost"}
                  size="icon"
                  onClick={onBrowserToggle}
                  className="transition-colors duration-200"
                >
                  <Globe className="h-4 w-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom">
                <p className="text-xs">{isBrowserOpen ? 'Close browser' : 'Open browser'}</p>
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        )}
        {workspacePath && <OpenInDropdown workspacePath={workspacePath} iconOnly />}
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
  branch,
  workspacePath,
  isBrowserOpen,
  onBrowserToggle,
}: MainContentTabsProps) {
  return (
    <div className="flex flex-col h-full">
      <MainContentTabBar
        tabs={tabs}
        activeTabId={activeTabId}
        onTabChange={onTabChange}
        onTabClose={onTabClose}
        onTabAdd={onTabAdd}
        branch={branch}
        workspacePath={workspacePath}
        isBrowserOpen={isBrowserOpen}
        onBrowserToggle={onBrowserToggle}
      />
      <div className="flex-1 min-h-0 overflow-hidden">
        {children}
      </div>
    </div>
  );
}
