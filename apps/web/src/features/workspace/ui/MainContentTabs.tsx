import { useState } from "react";
import { X, Plus, History, PanelLeftClose } from "lucide-react";
import { CircularPixelGrid } from "@/features/session/ui/CircularPixelGrid";
import {
  DndContext,
  closestCenter,
  MouseSensor,
  TouchSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import { arrayMove, SortableContext, horizontalListSortingStrategy } from "@dnd-kit/sortable";
import { Tooltip, TooltipContent, TooltipTrigger, TooltipKbd } from "@/components/ui/tooltip";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/shared/lib/utils";
import { getAgentLogo } from "@/assets/agents";
import { SortableTab } from "./SortableTab";

/**
 * Tab data structure — chat sessions only.
 */
export interface Tab {
  id: string;
  label: string;
  data?: {
    sessionId?: string;
    agentType?: string;
    hasStarted?: boolean;
    /** Pre-selected model when tab is created from locked-group picker */
    initialModel?: string;
  };
}

/** Info preserved when a chat tab is closed, for restore */
export interface ClosedTab {
  label: string;
  sessionId: string;
  agentType?: string;
  closedAt: number;
}

interface MainContentTabBarProps {
  tabs: Tab[];
  activeTabId: string;
  /** Set of session IDs currently in "working" status — per-tab spinners */
  workingSessionIds?: Set<string>;
  /** Set of session IDs with unseen activity — per-tab unread dots */
  unreadSessionIds?: Set<string>;
  onTabChange: (tabId: string) => void;
  onTabClose?: (tabId: string) => void;
  onTabAdd?: () => void;
  onTabReorder?: (reorderedTabs: Tab[]) => void;
  closedTabs?: ClosedTab[];
  onTabRestore?: (closedTab: ClosedTab) => void;
  onCollapseChatPanel?: () => void;
}

const ICON_SIZE = "w-3.5 h-3.5";
const EMPTY_CLOSED_TABS: ClosedTab[] = [];

/** Render tab icon — spinner when working, gold dot when unread, agent logo otherwise. */
function getTabIcon(tab: Tab, isWorking: boolean, isUnread: boolean) {
  if (isWorking) {
    return <CircularPixelGrid variant="generating" size={14} resolution={8} />;
  }
  if (isUnread) {
    return <span className="bg-accent-gold h-2 w-2 flex-shrink-0 rounded-full" />;
  }
  const LogoComponent = getAgentLogo(tab.data?.agentType || "claude");
  if (LogoComponent) {
    return <LogoComponent className={cn(ICON_SIZE, "flex-shrink-0")} />;
  }
  return null;
}

function getClosedTabIcon(agentType?: string) {
  const LogoComponent = getAgentLogo(agentType || "claude");
  if (LogoComponent) {
    return <LogoComponent className={cn(ICON_SIZE, "flex-shrink-0")} />;
  }
  return null;
}

/**
 * MainContentTabBar — tabs-only bar for the chat area.
 * Workspace context (repo, branch, PR actions) moved to WorkspaceHeader.
 *
 * Close rules:
 * - Any tab can be closed as long as at least one tab remains
 * - The close button only appears on hover when there are 2+ tabs
 */
const EMPTY_WORKING_SET = new Set<string>();

export function MainContentTabBar({
  tabs,
  activeTabId,
  workingSessionIds = EMPTY_WORKING_SET,
  unreadSessionIds = EMPTY_WORKING_SET,
  onTabChange,
  onTabClose,
  onTabAdd,
  onTabReorder,
  closedTabs = EMPTY_CLOSED_TABS,
  onTabRestore,
  onCollapseChatPanel,
}: MainContentTabBarProps) {
  const [restoreOpen, setRestoreOpen] = useState(false);
  const canCloseTabs = tabs.length > 1;

  // Mouse: 5px distance prevents accidental drags when clicking tabs
  // Touch: 250ms long-press required before drag activates (allows normal scrolling)
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 5 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 250, tolerance: 5 } })
  );

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id || !onTabReorder) return;

    const oldIndex = tabs.findIndex((t) => t.id === active.id);
    const newIndex = tabs.findIndex((t) => t.id === over.id);
    if (oldIndex === -1 || newIndex === -1) return;

    onTabReorder(arrayMove(tabs, oldIndex, newIndex));
  }

  return (
    <div className="drag-region chat-tabs-header relative z-20 flex h-10 flex-shrink-0 items-center px-2.5">
      <div
        role="tablist"
        className="scrollbar-hidden relative z-[1] flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto"
      >
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
          <SortableContext items={tabs.map((t) => t.id)} strategy={horizontalListSortingStrategy}>
            {tabs.map((tab) => {
              const isActive = tab.id === activeTabId;
              // Per-tab working status: each tab checks its own session ID
              // against the working set (populated by useWorkingSessionIds).
              const isWorking = !!tab.data?.sessionId && workingSessionIds.has(tab.data.sessionId);
              // Per-tab unread status: show dot when session has unseen activity
              const isUnread =
                !isActive &&
                !isWorking &&
                !!tab.data?.sessionId &&
                unreadSessionIds.has(tab.data.sessionId);

              return (
                <SortableTab key={tab.id} id={tab.id}>
                  <div
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
                      "group relative flex items-center gap-1.5 overflow-hidden",
                      "h-7 max-w-[200px] min-w-[80px] rounded-lg px-2",
                      "cursor-pointer text-base font-normal",
                      "transition-colors duration-150",
                      isActive
                        ? "bg-bg-raised text-text-secondary"
                        : isUnread
                          ? "text-text-secondary"
                          : "text-text-muted hover:text-text-tertiary"
                    )}
                  >
                    {getTabIcon(tab, isWorking, isUnread)}

                    <div className="min-w-0 flex-1">
                      <span className="block truncate">{tab.label}</span>
                    </div>

                    {/* Close button — overlays right edge on hover, only when 2+ tabs */}
                    {onTabClose && canCloseTabs && (
                      <div
                        className={cn(
                          "absolute inset-y-0 right-0 flex items-center pr-1.5 pl-4",
                          "opacity-0 transition-opacity duration-150 group-hover:opacity-100",
                          isActive
                            ? "from-bg-raised bg-gradient-to-l from-50% to-transparent"
                            : "from-bg-surface group-hover:from-bg-surface bg-gradient-to-l from-50% to-transparent"
                        )}
                      >
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            onTabClose(tab.id);
                          }}
                          className={cn(
                            "flex h-4 w-4 items-center justify-center rounded-sm",
                            "transition-colors duration-150",
                            "hover:bg-bg-muted"
                          )}
                          aria-label={`Close ${tab.label} tab`}
                        >
                          <X className="h-2.5 w-2.5" />
                        </button>
                      </div>
                    )}
                  </div>
                </SortableTab>
              );
            })}
          </SortableContext>
        </DndContext>

        {/* New tab button — stays adjacent to tabs */}
        {onTabAdd && (
          <Tooltip delayDuration={200}>
            <TooltipTrigger asChild>
              <button
                type="button"
                aria-label="New chat tab"
                onClick={() => onTabAdd?.()}
                className={cn(
                  "flex items-center justify-center",
                  "h-7 flex-shrink-0 rounded-lg px-1.5",
                  "text-text-disabled hover:text-text-muted",
                  "transition-colors duration-150"
                )}
              >
                <Plus className="h-4 w-4" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              <div className="flex items-center gap-3">
                <span className="text-xs">New chat</span>
                <TooltipKbd>⌘T</TooltipKbd>
              </div>
            </TooltipContent>
          </Tooltip>
        )}
      </div>

      {/* History button — pinned far right, outside scrollable area */}
      {onTabRestore && closedTabs.length > 0 && (
        <Popover open={restoreOpen} onOpenChange={setRestoreOpen}>
          <Tooltip delayDuration={200}>
            <TooltipTrigger asChild>
              <PopoverTrigger asChild>
                <button
                  type="button"
                  aria-label="Restore closed session"
                  className={cn(
                    "flex items-center justify-center",
                    "h-7 flex-shrink-0 rounded-lg px-1.5",
                    "text-text-disabled hover:text-text-muted",
                    "transition-colors duration-150"
                  )}
                >
                  <History className="h-3.5 w-3.5" />
                </button>
              </PopoverTrigger>
            </TooltipTrigger>
            {!restoreOpen && (
              <TooltipContent side="bottom">
                <p className="text-xs">Restore closed session (⌘⇧T)</p>
              </TooltipContent>
            )}
          </Tooltip>
          <PopoverContent align="end" sideOffset={6} className="w-56 p-1">
            <p className="text-text-muted px-2 py-1.5 text-xs font-medium">Recently closed</p>
            <div className="max-h-48 overflow-y-auto">
              {closedTabs.map((ct, i) => (
                <button
                  key={`${ct.sessionId}-${i}`}
                  type="button"
                  onClick={() => {
                    onTabRestore(ct);
                    setRestoreOpen(false);
                  }}
                  className={cn(
                    "flex w-full items-center gap-2 rounded-sm px-2 py-1.5",
                    "text-text-secondary text-left text-base",
                    "transition-colors duration-150",
                    "hover:bg-bg-raised"
                  )}
                >
                  {getClosedTabIcon(ct.agentType)}
                  <span className="min-w-0 flex-1 truncate">{ct.label}</span>
                </button>
              ))}
            </div>
          </PopoverContent>
        </Popover>
      )}

      {/* Collapse chat panel — pinned to right edge of tab bar */}
      {onCollapseChatPanel && (
        <Tooltip delayDuration={200}>
          <TooltipTrigger asChild>
            <button
              type="button"
              aria-label="Collapse chat panel"
              onClick={onCollapseChatPanel}
              className="text-text-disabled hover:text-text-secondary hover:bg-bg-overlay ml-1 flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-lg transition-colors duration-200 ease-out"
            >
              <PanelLeftClose className="h-4 w-4" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="bottom">
            <div className="flex items-center gap-3">
              <span className="text-xs">Collapse chat</span>
              <TooltipKbd>⌘\</TooltipKbd>
            </div>
          </TooltipContent>
        </Tooltip>
      )}
    </div>
  );
}
