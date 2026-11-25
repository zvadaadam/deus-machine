/**
 * WorkspaceTabBar — browser-style tab strip with Fluid Functionalism motion.
 *
 * Craft & interaction details:
 * - Uniform tab width (152px) so rapid close-clicking lands the next tab's `×`
 *   directly under the cursor and 2-tab drag-and-drop has symmetrical targets.
 * - Gliding hover highlight (<Glide>) across inactive tabs.
 * - Sliding active pill (Framer Motion layoutId + tempo.moderate) paused during drag.
 * - Animated tab add/close (AnimatePresence + tempo.moderate / tempo.moderate.exit).
 * - Single fixed trailing slot: subtle `⌘1`–`⌘9` at rest on the active tab,
 *   crossfading cleanly to `×` on hover with zero layout shift.
 * - Full tablist ARIA (`id` / `aria-controls`) and `Delete` close with focus restoration.
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { Plus, X } from "lucide-react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { DndContext, closestCenter, type DragEndEvent } from "@dnd-kit/core";
import { SortableContext, horizontalListSortingStrategy } from "@dnd-kit/sortable";
import { Glide } from "@/components/ui/glide";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/shared/lib/utils";
import { tempo } from "@/shared/lib/tempo";
import { useReorderSensors } from "@/shared/hooks/useReorderSensors";
import { useSimulatorStatusStore } from "@/features/simulator/store";
import { useCloudSimulatorStore } from "@/features/simulator/cloud/cloudSimulatorStore";
import { PierreFileIcon } from "@/features/file-browser/lib/pierreIcons";
import { TAB_KIND_ICONS, getWorkspaceTabTitle } from "../registry";
import type { WorkspaceTab } from "../types";
import { SortableWorkspaceTabShell } from "./SortableWorkspaceTabShell";

const IS_MAC = typeof navigator !== "undefined" && /Mac|iPhone|iPad|iPod/i.test(navigator.platform);

/** Fixed uniform tab width for predictable rapid-close clicks and symmetrical drag-reorder. */
const TAB_WIDTH = 152;

/** Deterministic DOM IDs pairing each `[role="tab"]` to its `[role="tabpanel"]`. */
export function workspaceTabDomId(tabId: string): string {
  return `workspace-tab-${tabId}`;
}

export function workspaceTabPanelDomId(tabId: string): string {
  return `workspace-tabpanel-${tabId}`;
}

interface WorkspaceTabBarProps {
  tabs: WorkspaceTab[];
  activeTabId: string;
  workspaceId?: string | null;
  fileChangesCount?: number;
  onTabSelect: (tabId: string) => void;
  onTabClose: (tabId: string) => void;
  onTabAdd: () => void;
  /** Reorder by `(draggedId, targetId)` against the full tab list so hidden tabs are preserved. */
  onTabReorder: (draggedId: string, targetId: string) => void;
}

function getWrappedIndex(currentIndex: number, nextIndex: number, count: number): number {
  if (count === 0) return currentIndex;
  if (nextIndex < 0) return count - 1;
  if (nextIndex >= count) return 0;
  return nextIndex;
}

function TabIcon({ tab, simulatorActive }: { tab: WorkspaceTab; simulatorActive: boolean }) {
  if (tab.kind === "file") {
    const fileName = getWorkspaceTabTitle(tab);
    return <PierreFileIcon fileName={fileName} size={14} className="shrink-0" />;
  }
  const Icon = TAB_KIND_ICONS[tab.kind];
  return (
    <span className="relative flex shrink-0 items-center justify-center">
      <Icon className="h-3.5 w-3.5" aria-hidden="true" />
      {tab.kind === "simulator" && simulatorActive && (
        <span
          aria-hidden="true"
          className="bg-success absolute -top-0.5 -right-0.5 size-1.5 rounded-full"
        />
      )}
    </span>
  );
}

function getTabTooltip(tab: WorkspaceTab, title: string): string {
  if (tab.kind === "file") return tab.path;
  if (tab.kind === "browser" && tab.url) return `${title} — ${tab.url}`;
  return title;
}

function WorkspaceTabPill({
  tab,
  index,
  isActive,
  isDragging,
  suppressPillMotion,
  activePillLayoutId,
  canClose,
  simulatorActive,
  fileChangesCount,
  onSelect,
  onClose,
  onKeyDown,
  tabRef,
}: {
  tab: WorkspaceTab;
  index: number;
  isActive: boolean;
  isDragging: boolean;
  suppressPillMotion: boolean;
  activePillLayoutId: string;
  canClose: boolean;
  simulatorActive: boolean;
  fileChangesCount: number;
  onSelect: () => void;
  onClose: () => void;
  onKeyDown: (event: ReactKeyboardEvent<HTMLButtonElement>) => void;
  tabRef: (node: HTMLButtonElement | null) => void;
}) {
  const reducedMotion = useReducedMotion();
  const title = getWorkspaceTabTitle(tab);
  const tooltipText = getTabTooltip(tab, title);
  const shortcutLabel = IS_MAC && index < 9 ? `⌘${index + 1}` : null;
  const showChangesBadge = tab.kind === "changes" && fileChangesCount > 0;
  const [tooltipOpen, setTooltipOpen] = useState(false);

  return (
    <div
      data-slot="workspace-tab"
      data-tab-kind={tab.kind}
      data-active={isActive ? "true" : undefined}
      onAuxClick={(event) => {
        if (event.button === 1 && canClose) {
          event.preventDefault();
          onClose();
        }
      }}
      className={cn(
        "group relative flex h-7 w-[152px] shrink-0 items-center rounded-lg text-sm whitespace-nowrap transition-colors select-none",
        isActive ? "text-text-primary" : "text-text-muted hover:text-text-secondary"
      )}
    >
      {/* Active elevated pill — glides smoothly across tabs via shared layoutId */}
      {isActive &&
        (suppressPillMotion || reducedMotion ? (
          <span
            aria-hidden="true"
            className="bg-bg-elevated ring-border-subtle dark:bg-bg-raised pointer-events-none absolute inset-0 -z-10 rounded-lg shadow-[0_1px_2px_rgba(0,0,0,0.05)] ring-1 ring-inset dark:shadow-none"
          />
        ) : (
          <motion.span
            layoutId={activePillLayoutId}
            transition={tempo.moderate}
            aria-hidden="true"
            className="bg-bg-elevated ring-border-subtle dark:bg-bg-raised pointer-events-none absolute inset-0 -z-10 rounded-lg shadow-[0_1px_2px_rgba(0,0,0,0.05)] ring-1 ring-inset dark:shadow-none"
          />
        ))}

      <Tooltip
        delayDuration={500}
        open={!isDragging && tooltipOpen}
        onOpenChange={(next) => setTooltipOpen(isDragging ? false : next)}
      >
        <TooltipTrigger asChild>
          <button
            ref={tabRef}
            id={workspaceTabDomId(tab.id)}
            type="button"
            role="tab"
            aria-label={title}
            aria-selected={isActive}
            aria-controls={workspaceTabPanelDomId(tab.id)}
            tabIndex={isActive ? 0 : -1}
            onClick={onSelect}
            onKeyDown={onKeyDown}
            className="control-interaction flex h-full min-w-0 flex-1 cursor-pointer items-center gap-1.5 rounded-lg border-none bg-transparent pr-1 pl-2 text-left text-inherit"
          >
            <TabIcon tab={tab} simulatorActive={simulatorActive} />
            <span
              className={cn("min-w-0 flex-1 truncate", isActive ? "font-medium" : "font-normal")}
              data-medium-label={title}
            >
              {title}
            </span>
            {showChangesBadge && (
              <span
                aria-hidden="true"
                className="bg-bg-muted/80 text-text-tertiary shrink-0 rounded px-1 text-[10px] leading-4 font-medium tabular-nums"
              >
                {fileChangesCount > 99 ? "99+" : fileChangesCount}
              </span>
            )}
          </button>
        </TooltipTrigger>
        <TooltipContent side="bottom" sideOffset={8}>
          <p className="max-w-xs truncate text-xs">{tooltipText}</p>
        </TooltipContent>
      </Tooltip>

      {/* Fixed trailing slot: quiet ⌘N at rest on active tab, crossfading to × on hover */}
      <div className="relative mr-1 flex size-5 shrink-0 items-center justify-center">
        {shortcutLabel && isActive && (
          <span
            aria-hidden="true"
            className={cn(
              "text-text-disabled pointer-events-none absolute inset-0 grid place-items-center text-[10px] font-normal tracking-tight transition-opacity",
              canClose && "group-focus-within:opacity-0 group-hover:opacity-0"
            )}
          >
            {shortcutLabel}
          </span>
        )}
        {canClose && (
          <button
            type="button"
            tabIndex={-1}
            aria-label={`Close ${title}`}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              onClose();
            }}
            className={cn(
              "control-interaction text-text-muted hover:text-text-primary hover:bg-control-hover active:bg-control-pressed absolute inset-0 flex cursor-pointer items-center justify-center rounded-md border-none bg-transparent opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100",
              isActive && "[@media(hover:none)]:opacity-100"
            )}
          >
            <X className="h-3 w-3" aria-hidden="true" />
          </button>
        )}
      </div>
    </div>
  );
}

export function WorkspaceTabBar({
  tabs,
  activeTabId,
  workspaceId,
  fileChangesCount = 0,
  onTabSelect,
  onTabClose,
  onTabAdd,
  onTabReorder,
}: WorkspaceTabBarProps) {
  const reducedMotion = useReducedMotion();
  const [isDraggingAny, setIsDraggingAny] = useState(false);

  const simPhase = useSimulatorStatusStore((s) =>
    workspaceId ? s.phases[workspaceId] : undefined
  );
  const cloudSimStatus = useCloudSimulatorStore((s) =>
    workspaceId ? (s.byWorkspace[workspaceId]?.status ?? null) : null
  );
  const simulatorActive = Boolean(
    (simPhase && simPhase !== "idle" && simPhase !== "error") || cloudSimStatus === "ready"
  );

  const sensors = useReorderSensors({ keyboard: false });
  const tabIds = useMemo(() => tabs.map((t) => t.id), [tabs]);
  const tabRefs = useRef(new Map<string, HTMLButtonElement>());
  const barRef = useRef<HTMLDivElement | null>(null);
  const activeTabIdRef = useRef(activeTabId);
  /** Tab ID to focus after a keyboard-triggered Delete close commits. */
  const pendingFocusTabIdRef = useRef<string | "active" | null>(null);

  useEffect(() => {
    activeTabIdRef.current = activeTabId;
  }, [activeTabId]);

  const setTabRef = useCallback((tabId: string, node: HTMLButtonElement | null) => {
    if (node) tabRefs.current.set(tabId, node);
    else tabRefs.current.delete(tabId);
  }, []);

  const revealActiveTab = useCallback(() => {
    const el = tabRefs.current.get(activeTabIdRef.current);
    const pill = el?.closest('[data-slot="workspace-tab"]') ?? el;
    pill?.scrollIntoView({ inline: "nearest", block: "nearest" });
  }, []);

  // Scroll the active tab into view when the active tab changes.
  useEffect(() => {
    revealActiveTab();
  }, [activeTabId, revealActiveTab]);

  // Restore focus to the neighboring surviving tab after keyboard Delete closes a tab.
  useEffect(() => {
    const target = pendingFocusTabIdRef.current;
    if (!target) return;
    pendingFocusTabIdRef.current = null;
    const focusId = target === "active" ? activeTabId : target;
    tabRefs.current.get(focusId)?.focus();
  }, [tabs, activeTabId]);

  // Also reveal the active tab when the bar itself resizes (e.g. Expand ↔ Restore split),
  // without reacting to tab add/close inside the strip so rapid close-clicking stays steady.
  useEffect(() => {
    const bar = barRef.current;
    if (!bar || typeof ResizeObserver === "undefined") return;
    let lastWidth = bar.clientWidth;
    const ro = new ResizeObserver(() => {
      const width = bar.clientWidth;
      if (width === lastWidth) return;
      lastWidth = width;
      revealActiveTab();
    });
    ro.observe(bar);
    return () => ro.disconnect();
  }, [revealActiveTab]);

  const focusAndSelectIndex = useCallback(
    (index: number) => {
      const target = tabs[index];
      if (!target) return;
      onTabSelect(target.id);
      tabRefs.current.get(target.id)?.focus();
    },
    [tabs, onTabSelect]
  );

  const handleTabKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLButtonElement>, tabId: string, canClose: boolean) => {
      const currentIndex = tabIds.indexOf(tabId);
      if (currentIndex === -1) return;

      if (event.key === "ArrowLeft") {
        event.preventDefault();
        focusAndSelectIndex(getWrappedIndex(currentIndex, currentIndex - 1, tabs.length));
      } else if (event.key === "ArrowRight") {
        event.preventDefault();
        focusAndSelectIndex(getWrappedIndex(currentIndex, currentIndex + 1, tabs.length));
      } else if (event.key === "Home") {
        event.preventDefault();
        focusAndSelectIndex(0);
      } else if (event.key === "End") {
        event.preventDefault();
        focusAndSelectIndex(tabs.length - 1);
      } else if (event.key === "Delete" && canClose) {
        event.preventDefault();
        const neighbor = tabs[currentIndex + 1]?.id ?? tabs[currentIndex - 1]?.id ?? "active";
        pendingFocusTabIdRef.current = neighbor;
        onTabClose(tabId);
      } else if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        onTabSelect(tabId);
      }
    },
    [focusAndSelectIndex, onTabClose, onTabSelect, tabIds, tabs]
  );

  function handleDragEnd(event: DragEndEvent) {
    setIsDraggingAny(false);
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    onTabReorder(String(active.id), String(over.id));
  }

  const activePillLayoutId = `workspace-active-tab-${workspaceId ?? "default"}`;

  return (
    <div
      ref={barRef}
      data-slot="content-tab-bar"
      className="no-drag @container flex min-w-0 flex-1 items-center gap-1"
    >
      <div
        className="scrollbar-hidden relative isolate flex min-w-0 flex-initial items-center gap-1 overflow-x-auto py-0.5"
        role="tablist"
        aria-label="Workspace tabs"
      >
        {!isDraggingAny && (
          <Glide
            rows='[data-slot="workspace-tab"]'
            selected='[data-active="true"]'
            className="bg-control-hover rounded-lg"
          />
        )}

        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragStart={() => setIsDraggingAny(true)}
          onDragEnd={handleDragEnd}
          onDragCancel={() => setIsDraggingAny(false)}
        >
          <SortableContext items={tabIds} strategy={horizontalListSortingStrategy}>
            <AnimatePresence initial={false}>
              {tabs.map((tab, index) => {
                const isActive = tab.id === activeTabId;
                const canClose = tabs.length > 1 || tab.kind !== "new-tab";

                return (
                  <motion.div
                    key={tab.id}
                    initial={reducedMotion ? false : { width: 0, opacity: 0, scale: 0.96 }}
                    animate={{ width: TAB_WIDTH, opacity: 1, scale: 1 }}
                    exit={
                      reducedMotion
                        ? undefined
                        : { width: 0, opacity: 0, scale: 0.96, transition: tempo.moderate.exit }
                    }
                    transition={tempo.moderate}
                    className={cn("shrink-0", !isDraggingAny && "overflow-x-clip")}
                  >
                    <SortableWorkspaceTabShell id={tab.id}>
                      {({ isDragging }) => (
                        <WorkspaceTabPill
                          tab={tab}
                          index={index}
                          isActive={isActive}
                          isDragging={isDragging}
                          suppressPillMotion={isDraggingAny}
                          activePillLayoutId={activePillLayoutId}
                          canClose={canClose}
                          simulatorActive={simulatorActive}
                          fileChangesCount={fileChangesCount}
                          onSelect={() => onTabSelect(tab.id)}
                          onClose={() => onTabClose(tab.id)}
                          onKeyDown={(e) => handleTabKeyDown(e, tab.id, canClose)}
                          tabRef={(node) => setTabRef(tab.id, node)}
                        />
                      )}
                    </SortableWorkspaceTabShell>
                  </motion.div>
                );
              })}
            </AnimatePresence>
          </SortableContext>
        </DndContext>
      </div>

      <Tooltip delayDuration={300}>
        <TooltipTrigger asChild>
          <button
            type="button"
            aria-label="New tab"
            onClick={onTabAdd}
            className="control-interaction text-text-muted hover:text-text-secondary hover:bg-control-hover active:bg-control-pressed flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-lg border-none bg-transparent"
          >
            <Plus className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        </TooltipTrigger>
        <TooltipContent side="bottom" sideOffset={8}>
          <p className="text-xs">New tab</p>
        </TooltipContent>
      </Tooltip>
    </div>
  );
}
