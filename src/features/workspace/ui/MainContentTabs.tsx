import { X, Plus, FileCode, GitCompareArrows } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/shared/lib/utils";
import { getAgentLogo } from "@/assets/agents";

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
   * - For 'chat' tabs: session ID and agent type (for logo)
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
    agentType?: string;
    hasStarted?: boolean;
    agentSequence?: number;
  };
}

interface MainContentTabBarProps {
  tabs: Tab[];
  activeTabId: string;
  onTabChange: (tabId: string) => void;
  onTabClose?: (tabId: string) => void;
  onTabAdd?: () => void;
}

const TAB_ICON_SIZE = "w-3.5 h-3.5";
const AGENT_ICON_SIZE = "w-3.5 h-3.5";

function getTabIcon(tab: Tab) {
  switch (tab.type) {
    case "chat": {
      const LogoComponent = getAgentLogo(tab.data?.agentType || "claude");
      if (LogoComponent) {
        return <LogoComponent className={cn(AGENT_ICON_SIZE, "flex-shrink-0")} />;
      }
      return <FileCode className={cn(TAB_ICON_SIZE, "flex-shrink-0 opacity-60")} />;
    }
    case "diff":
      return <GitCompareArrows className={cn(TAB_ICON_SIZE, "flex-shrink-0 opacity-60")} />;
    default:
      return <FileCode className={cn(TAB_ICON_SIZE, "flex-shrink-0 opacity-60")} />;
  }
}

/**
 * MainContentTabBar — tabs-only bar for the chat area.
 * Workspace context (repo, branch, PR actions) moved to WorkspaceHeader.
 */
export function MainContentTabBar({
  tabs,
  activeTabId,
  onTabChange,
  onTabClose,
  onTabAdd,
}: MainContentTabBarProps) {
  return (
    <div className="chat-tabs-header relative z-20 flex h-9 flex-shrink-0 items-center px-2.5">
      <div
        role="tablist"
        className="scrollbar-hidden relative z-[1] flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto"
      >
        {tabs.map((tab) => {
          const isActive = tab.id === activeTabId;

          return (
            <div
              key={tab.id}
              role="tab"
              aria-selected={isActive}
              tabIndex={0}
              onClick={() => onTabChange(tab.id)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  onTabChange(tab.id);
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
              {getTabIcon(tab)}

              <div className="relative min-w-0 flex-1">
                <span className="block truncate">{tab.label}</span>
              </div>

              {onTabClose && tab.closeable !== false && (
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    onTabClose(tab.id);
                  }}
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

        {onTabAdd && (
          <Tooltip delayDuration={200}>
            <TooltipTrigger asChild>
              <button
                type="button"
                aria-label="New chat tab"
                onClick={onTabAdd}
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
}: MainContentTabBarProps & { children: React.ReactNode }) {
  return (
    <div className="flex h-full flex-col">
      <MainContentTabBar
        tabs={tabs}
        activeTabId={activeTabId}
        onTabChange={onTabChange}
        onTabClose={onTabClose}
        onTabAdd={onTabAdd}
      />
      <div className="min-h-0 flex-1 overflow-hidden">{children}</div>
    </div>
  );
}
