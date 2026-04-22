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
    agentHarness?: string;
    hasStarted?: boolean;
    /** Pre-selected model when tab is created from locked-group picker */
    initialModel?: string;
  };
}

/** Info preserved when a chat tab is closed, for restore */
export interface ClosedTab {
  label: string;
  sessionId: string;
  agentHarness?: string;
  /** Preserved so restore can re-create a tab with the same model selection */
  initialModel?: string;
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

// Icon cross-fade curve — matches BrowserTabBar. Both icons stay in the DOM
// so enter + exit both animate without a motion dep; CSS transitions with
// this ease give the skill's scale 0.25→1, opacity 0→1, blur 4→0 motion.
const ICON_CROSS_FADE =
  "transition-[opacity,filter,scale] duration-200 ease-[cubic-bezier(0.2,0,0,1)]";

/** Render the rest-state tab icon — spinner when working, gold dot when
 *  unread, agent logo otherwise. */
function renderTabStatusIcon(tab: Tab, isWorking: boolean, isUnread: boolean) {
  if (isWorking) {
    return <CircularPixelGrid variant="generating" size={14} resolution={8} />;
  }
  if (isUnread) {
    return <span className="bg-accent-gold h-2 w-2 flex-shrink-0 rounded-full" />;
  }
  const LogoComponent = getAgentLogo(tab.data?.agentHarness || "claude");
  if (LogoComponent) {
    return <LogoComponent className={cn(ICON_SIZE, "flex-shrink-0")} />;
  }
  return null;
}

function getClosedTabIcon(agentHarness?: string) {
  const LogoComponent = getAgentLogo(agentHarness || "claude");
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
                      "group relative flex items-center gap-1 overflow-hidden",
                      "h-7 max-w-[200px] min-w-[80px] rounded-lg pr-2 pl-1",
                      "cursor-pointer text-base font-normal",
                      "transition-colors duration-150",
                      isActive
                        ? "bg-bg-raised text-text-secondary"
                        : isUnread
                          ? "text-text-secondary"
                          : "text-text-muted hover:text-text-tertiary"
                    )}
                  >
                    {/* Left icon slot — status icon at rest, close X on tab
                     *  hover. Same pattern as BrowserTabBar: both icons stay
                     *  in the DOM, a CSS transition cross-fades them with
                     *  scale + opacity + blur. Click the slot to close;
                     *  click the label to select. */}
                    {onTabClose && canCloseTabs ? (
                      <button
                        type="button"
                        aria-label={`Close ${tab.label} tab`}
                        onClick={(e) => {
                          e.stopPropagation();
                          onTabClose(tab.id);
                        }}
                        className={cn(
                          "relative flex h-5 w-5 shrink-0 cursor-pointer items-center justify-center rounded-md border-none bg-transparent p-0",
                          "transition-[background-color,scale] duration-150 ease-out",
                          "hover:bg-foreground/10 active:scale-[0.96]"
                        )}
                      >
                        {/* Status icon (rest) — agent logo / spinner / unread dot. */}
                        <span
                          className={cn(
                            "absolute inset-0 grid place-items-center",
                            ICON_CROSS_FADE,
                            "group-hover:scale-[0.25] group-hover:opacity-0 group-hover:blur-[4px]"
                          )}
                        >
                          {renderTabStatusIcon(tab, isWorking, isUnread)}
                        </span>
                        {/* Close X (hover) — pops in when the whole tab is hovered. */}
                        <span
                          className={cn(
                            "absolute inset-0 grid scale-[0.25] place-items-center opacity-0 blur-[4px]",
                            ICON_CROSS_FADE,
                            "group-hover:scale-100 group-hover:opacity-100 group-hover:blur-none"
                          )}
                        >
                          <X strokeWidth={1.75} className="h-3 w-3" />
                        </span>
                      </button>
                    ) : (
                      // Single-tab state (can't close): plain status icon, no button.
                      <span className="flex h-5 w-5 shrink-0 items-center justify-center">
                        {renderTabStatusIcon(tab, isWorking, isUnread)}
                      </span>
                    )}

                    <div className="min-w-0 flex-1">
                      <span className="block truncate">{tab.label}</span>
                    </div>
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
                  {getClosedTabIcon(ct.agentHarness)}
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
