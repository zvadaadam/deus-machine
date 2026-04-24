import { useCallback, useEffect, useMemo, useRef } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { PanelLeftClose, Plus } from "lucide-react";
import {
  DndContext,
  MouseSensor,
  TouchSensor,
  closestCenter,
  type DragEndEvent,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import { SortableContext, arrayMove, horizontalListSortingStrategy } from "@dnd-kit/sortable";
import { Tooltip, TooltipContent, TooltipKbd, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/shared/lib/utils";
import { ClosedSessionsPopover } from "./ClosedSessionsPopover";
import { SessionTab } from "./SessionTab";
import { SortableSessionTab } from "./SortableSessionTab";
import type { ChatTab, ClosedSessionTab } from "./types";
import { getChatTabSessionId } from "./types";

const EMPTY_CLOSED_TABS: ClosedSessionTab[] = [];
const EMPTY_WORKING_SET = new Set<string>();

interface SessionTabBarProps {
  tabs: ChatTab[];
  activeTabId: string;
  workingSessionIds?: Set<string>;
  unreadSessionIds?: Set<string>;
  focusActiveTabKey?: number;
  onTabChange: (tabId: string) => void;
  onTabClose?: (tabId: string) => void;
  onTabAdd?: () => void;
  onTabReorder?: (reorderedTabs: ChatTab[]) => void;
  closedTabs?: ClosedSessionTab[];
  onTabRestore?: (closedTab: ClosedSessionTab) => void;
  onCollapseChatPanel?: () => void;
}

function getWrappedIndex(currentIndex: number, nextIndex: number, count: number): number {
  if (count === 0) return currentIndex;
  if (nextIndex < 0) return count - 1;
  if (nextIndex >= count) return 0;
  return nextIndex;
}

export function SessionTabBar({
  tabs,
  activeTabId,
  workingSessionIds = EMPTY_WORKING_SET,
  unreadSessionIds = EMPTY_WORKING_SET,
  focusActiveTabKey = 0,
  onTabChange,
  onTabClose,
  onTabAdd,
  onTabReorder,
  closedTabs = EMPTY_CLOSED_TABS,
  onTabRestore,
  onCollapseChatPanel,
}: SessionTabBarProps) {
  const canCloseTabs = tabs.length > 1;
  const tabRefs = useRef(new Map<string, HTMLButtonElement>());
  const prevFocusKeyRef = useRef(focusActiveTabKey);

  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 5 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 250, tolerance: 5 } })
  );

  const tabIds = useMemo(() => tabs.map((tab) => tab.id), [tabs]);

  const setTabRef = useCallback((tabId: string, node: HTMLButtonElement | null) => {
    if (node) {
      tabRefs.current.set(tabId, node);
      return;
    }
    tabRefs.current.delete(tabId);
  }, []);

  useEffect(() => {
    if (focusActiveTabKey === prevFocusKeyRef.current) return;
    prevFocusKeyRef.current = focusActiveTabKey;
    tabRefs.current.get(activeTabId)?.focus();
  }, [activeTabId, focusActiveTabKey]);

  const focusAndSelectTabAtIndex = useCallback(
    (index: number) => {
      const nextTab = tabs[index];
      if (!nextTab) return;
      onTabChange(nextTab.id);
      tabRefs.current.get(nextTab.id)?.focus();
    },
    [tabs, onTabChange]
  );

  const handleTabKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLButtonElement>, tabId: string) => {
      const currentIndex = tabIds.indexOf(tabId);
      if (currentIndex === -1) return;

      if (event.key === "ArrowLeft") {
        event.preventDefault();
        focusAndSelectTabAtIndex(getWrappedIndex(currentIndex, currentIndex - 1, tabs.length));
        return;
      }

      if (event.key === "ArrowRight") {
        event.preventDefault();
        focusAndSelectTabAtIndex(getWrappedIndex(currentIndex, currentIndex + 1, tabs.length));
        return;
      }

      if (event.key === "Home") {
        event.preventDefault();
        focusAndSelectTabAtIndex(0);
        return;
      }

      if (event.key === "End") {
        event.preventDefault();
        focusAndSelectTabAtIndex(tabs.length - 1);
        return;
      }

      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        onTabChange(tabId);
      }
    },
    [focusAndSelectTabAtIndex, onTabChange, tabIds, tabs.length]
  );

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id || !onTabReorder) return;

    const oldIndex = tabs.findIndex((tab) => tab.id === active.id);
    const newIndex = tabs.findIndex((tab) => tab.id === over.id);
    if (oldIndex === -1 || newIndex === -1) return;

    onTabReorder(arrayMove(tabs, oldIndex, newIndex));
  }

  return (
    <div className="drag-region chat-tabs-header relative z-20 flex h-10 shrink-0 items-center px-2.5">
      <div
        role="tablist"
        aria-label="Session tabs"
        className="scrollbar-hidden relative z-[1] flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto"
      >
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
          <SortableContext items={tabIds} strategy={horizontalListSortingStrategy}>
            {tabs.map((tab) => {
              const isActive = tab.id === activeTabId;
              const sessionId = getChatTabSessionId(tab);
              const isWorking = !!sessionId && workingSessionIds.has(sessionId);
              const isUnread =
                !isActive && !isWorking && !!sessionId && unreadSessionIds.has(sessionId);

              return (
                <SortableSessionTab key={tab.id} id={tab.id}>
                  <SessionTab
                    tab={tab}
                    isActive={isActive}
                    isWorking={isWorking}
                    isUnread={isUnread}
                    canClose={canCloseTabs}
                    onSelect={() => onTabChange(tab.id)}
                    onClose={onTabClose ? () => onTabClose(tab.id) : undefined}
                    onKeyDown={(event) => handleTabKeyDown(event, tab.id)}
                    tabRef={(node) => setTabRef(tab.id, node)}
                  />
                </SortableSessionTab>
              );
            })}
          </SortableContext>
        </DndContext>

        {onTabAdd && (
          <Tooltip delayDuration={300}>
            <TooltipTrigger asChild>
              <button
                type="button"
                aria-label="New chat tab"
                onClick={() => onTabAdd()}
                className={cn(
                  "flex items-center justify-center",
                  "h-7 shrink-0 rounded-lg px-1.5",
                  "text-text-disabled hover:text-text-muted",
                  "transition-colors duration-150"
                )}
              >
                <Plus className="h-4 w-4" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom" sideOffset={8}>
              <div className="flex items-center gap-3">
                <span className="text-xs">New chat</span>
                <TooltipKbd>⌘T</TooltipKbd>
              </div>
            </TooltipContent>
          </Tooltip>
        )}
      </div>

      {onTabRestore && (
        <ClosedSessionsPopover closedTabs={closedTabs} onTabRestore={onTabRestore} />
      )}

      {onCollapseChatPanel && (
        <Tooltip delayDuration={300}>
          <TooltipTrigger asChild>
            <button
              type="button"
              aria-label="Collapse chat panel"
              onClick={onCollapseChatPanel}
              className="text-text-disabled hover:text-text-secondary hover:bg-bg-overlay ml-1 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg transition-colors duration-200 ease-out"
            >
              <PanelLeftClose className="h-4 w-4" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="bottom" sideOffset={8}>
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
