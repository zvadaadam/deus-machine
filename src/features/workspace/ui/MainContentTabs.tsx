import { useState } from 'react';
import { X, Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
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
}

/**
 * MainContentTabBar - Browser-style tab bar for main content area
 *
 * Design Philosophy:
 * - Just renders the tab bar UI (no content wrapping)
 * - Parent component controls layout and content rendering
 * - Clean separation of concerns: tabs UI vs content layout
 *
 * Features:
 * - Multiple chat sessions
 * - Files view
 * - Add/close tabs
 * - Active state highlighting
 */
export function MainContentTabBar({
  tabs,
  activeTabId,
  onTabChange,
  onTabClose,
  onTabAdd,
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
    <div className="flex items-center border-b border-border/60 bg-background/80 backdrop-blur-sm flex-shrink-0">
      <div className="flex items-center flex-1 overflow-x-auto scrollbar-thin scrollbar-thumb-border scrollbar-track-transparent">
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
                'group relative flex items-center gap-2 px-4 py-2.5 min-w-[120px] max-w-[200px]',
                'border-r border-border/40',
                'transition-colors duration-200',
                'hover:bg-muted/50',
                isActive && 'bg-background text-foreground',
                !isActive && 'text-muted-foreground'
              )}
            >
              {/* Active indicator */}
              {isActive && (
                <div className="absolute inset-x-0 top-0 h-0.5 bg-primary" />
              )}

              {/* Tab label */}
              <span className="flex-1 text-sm font-medium truncate">
                {tab.label}
              </span>

              {/* Close button */}
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
            className="h-9 px-3 shrink-0 border-r border-border/40"
          >
            <Plus className="w-4 h-4" />
          </Button>
        )}
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
}: MainContentTabsProps) {
  return (
    <div className="flex flex-col h-full">
      <MainContentTabBar
        tabs={tabs}
        activeTabId={activeTabId}
        onTabChange={onTabChange}
        onTabClose={onTabClose}
        onTabAdd={onTabAdd}
      />
      <div className="flex-1 min-h-0 overflow-hidden">
        {children}
      </div>
    </div>
  );
}
