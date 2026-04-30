/**
 * Content Tab Bar — icon tab switcher for the content panel header.
 *
 * Renders inside the content panel's header bar (36px), left-aligned.
 * Active tab: filled pill (bg-bg-raised) with icon + text label.
 * Inactive tabs: icon only with tooltip on hover.
 *
 * Tab definitions and visibility logic live in content-tabs.ts.
 * This component owns tab priority and rendering; tab definitions live in content-tabs.ts.
 */

import { MoreHorizontal } from "lucide-react";
import { useMemo } from "react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { cn } from "@/shared/lib/utils";
import { useSettings } from "@/features/settings/api/settings.queries";
import { useSimulatorStatusStore } from "@/features/simulator/store";
import { useWorkspaceIsMobileProject } from "@/features/workspace/hooks";
import type { ContentTab } from "@/features/workspace/store";
import { CONTENT_TABS, isTabVisible, type ContentTabItem } from "./content-tabs";

interface ContentTabBarProps {
  activeTab: ContentTab;
  onTabChange: (tab: ContentTab) => void;
  workspaceId?: string | null;
}

const ALWAYS_PRIMARY_TAB_IDS: ContentTab[] = ["changes", "files", "terminal", "browser"];

function splitTabs(
  visibleItems: ContentTabItem[],
  activeTab: ContentTab,
  isMobileProject: boolean
): { primaryItems: ContentTabItem[]; overflowItems: ContentTabItem[] } {
  const visibleIds = new Set(visibleItems.map((item) => item.id));
  const primaryIds = new Set<ContentTab>();

  for (const id of ALWAYS_PRIMARY_TAB_IDS) {
    if (visibleIds.has(id)) primaryIds.add(id);
  }

  if (isMobileProject && visibleIds.has("simulator")) primaryIds.add("simulator");

  // Never hide the tab the user is currently looking at behind overflow.
  if (visibleIds.has(activeTab)) primaryIds.add(activeTab);

  return {
    primaryItems: visibleItems.filter((item) => primaryIds.has(item.id)),
    overflowItems: visibleItems.filter((item) => !primaryIds.has(item.id)),
  };
}

function ContentTabButton({
  item,
  isActive,
  showDot,
  onClick,
}: {
  item: ContentTabItem;
  isActive: boolean;
  showDot: boolean;
  onClick: () => void;
}) {
  const Icon = item.icon;
  const button = (
    <button
      type="button"
      role="tab"
      aria-label={item.label}
      aria-selected={isActive}
      onClick={onClick}
      className={cn(
        "relative flex h-7 items-center rounded-lg transition-colors duration-150",
        isActive
          ? "bg-bg-raised text-text-secondary gap-1.5 px-3 text-sm font-medium"
          : "text-text-muted hover:text-text-secondary hover:bg-bg-muted justify-center px-2"
      )}
    >
      <Icon className={isActive ? "h-[13px] w-[13px]" : "h-3.5 w-3.5"} />
      {isActive && <span>{item.label}</span>}
      {showDot && <span className="bg-success absolute -top-0.5 -right-0.5 h-2 w-2 rounded-full" />}
    </button>
  );

  return isActive ? (
    button
  ) : (
    <Tooltip delayDuration={300}>
      <TooltipTrigger asChild>{button}</TooltipTrigger>
      <TooltipContent side="bottom" sideOffset={8}>
        <p className="text-xs">{item.label}</p>
      </TooltipContent>
    </Tooltip>
  );
}

export function ContentTabBar({ activeTab, onTabChange, workspaceId }: ContentTabBarProps) {
  const settings = useSettings().data;
  const simPhase = useSimulatorStatusStore((s) =>
    workspaceId ? s.phases[workspaceId] : undefined
  );

  const simulatorActive = simPhase && simPhase !== "idle";

  const visibleItems = useMemo(
    () => CONTENT_TABS.filter((item) => isTabVisible(item.id, settings)),
    [settings]
  );
  const simulatorVisible = visibleItems.some((item) => item.id === "simulator");
  const isMobileProject = useWorkspaceIsMobileProject(workspaceId, { enabled: simulatorVisible });

  const { primaryItems, overflowItems } = useMemo(
    () => splitTabs(visibleItems, activeTab, isMobileProject),
    [activeTab, isMobileProject, visibleItems]
  );

  return (
    <div data-slot="content-tab-bar" className="flex items-center gap-1">
      <div className="flex items-center gap-1" role="tablist" aria-label="Content panel">
        {primaryItems.map((item) => {
          const isActive = activeTab === item.id;
          const showDot = item.id === "simulator" && simulatorActive;

          return (
            <ContentTabButton
              key={item.id}
              item={item}
              isActive={isActive}
              showDot={Boolean(showDot)}
              onClick={() => onTabChange(item.id)}
            />
          );
        })}
      </div>

      {overflowItems.length > 0 && (
        <DropdownMenu modal={false}>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label="More content tabs"
              className={cn(
                "text-text-muted hover:text-text-secondary hover:bg-bg-muted",
                "flex h-7 items-center justify-center rounded-lg px-2",
                "transition-colors duration-150"
              )}
            >
              <MoreHorizontal className="h-3.5 w-3.5" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" sideOffset={8} className="w-40">
            {overflowItems.map((item) => {
              const Icon = item.icon;
              const showDot = item.id === "simulator" && simulatorActive;

              return (
                <DropdownMenuItem key={item.id} onSelect={() => onTabChange(item.id)}>
                  <Icon className="h-3.5 w-3.5" />
                  <span>{item.label}</span>
                  {showDot && <span className="bg-success ml-auto h-2 w-2 rounded-full" />}
                </DropdownMenuItem>
              );
            })}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  );
}
