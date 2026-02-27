/**
 * Content Tab Bar -- icon tab switcher for the content panel header.
 *
 * Renders inside the content panel's header bar (36px), left-aligned.
 * Active tab: filled pill (bg-bg-raised) with icon + text label.
 * Inactive tabs: icon only with tooltip on hover.
 *
 * The parent (MainContent) owns tab change logic. This component is pure
 * presentation -- it renders icons/pills and fires onTabChange.
 */

import { useMemo } from "react";
import {
  GitBranch,
  Settings2,
  Terminal,
  BookOpen,
  PenTool,
  Globe,
  Smartphone,
} from "lucide-react";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { cn } from "@/shared/lib/utils";
import { useSettings } from "@/features/settings/api/settings.queries";
import { useSimulatorStatusStore } from "@/features/simulator/store";
import type { RightSideTab } from "@/features/workspace/store";
import type { Settings } from "@shared/types/settings";

interface ContentTabBarProps {
  activeTab: RightSideTab;
  onTabChange: (tab: RightSideTab) => void;
  workspaceId?: string | null;
}

const contentTabItems: Array<{
  id: RightSideTab;
  label: string;
  icon: typeof GitBranch;
  /** Settings key that controls visibility. Absent = always visible. */
  visibilityKey?: keyof Settings;
}> = [
  { id: "code", label: "Code", icon: GitBranch },
  { id: "config", label: "Config", icon: Settings2 },
  { id: "terminal", label: "Terminal", icon: Terminal },
  { id: "notebook", label: "Notebook", icon: BookOpen, visibilityKey: "experimental_notebooks" },
  { id: "design", label: "Design", icon: PenTool, visibilityKey: "experimental_design" },
  { id: "browser", label: "Browser", icon: Globe, visibilityKey: "experimental_browser" },
  {
    id: "simulator",
    label: "Simulator",
    icon: Smartphone,
    visibilityKey: "experimental_simulator",
  },
];

/** Check if a tab should be visible given current settings. undefined = hidden (opt-in). */
export function isTabVisible(tab: RightSideTab, settings?: Settings): boolean {
  const item = contentTabItems.find((i) => i.id === tab);
  if (!item?.visibilityKey) return true;
  return settings?.[item.visibilityKey] === true;
}

/**
 * ContentTabBar -- horizontal tab bar for the right content panel header.
 *
 * Active tab: filled pill with icon + label (h-7, rounded-lg).
 * Inactive tabs: icon-only buttons with tooltips.
 * No container/track background — tabs sit directly in the header.
 */
export function ContentTabBar({ activeTab, onTabChange, workspaceId }: ContentTabBarProps) {
  const settings = useSettings().data;
  const simPhase = useSimulatorStatusStore((s) =>
    workspaceId ? s.phases[workspaceId] : undefined
  );

  // Show a dot when the simulator is doing something (not idle, not absent)
  const simulatorActive = simPhase && simPhase !== "idle";

  const visibleItems = useMemo(
    () => contentTabItems.filter((item) => isTabVisible(item.id, settings)),
    [settings]
  );

  return (
    <div data-slot="content-tab-bar" className="flex items-center gap-1" role="tablist" aria-label="Content panel">
      {visibleItems.map((item) => {
        const Icon = item.icon;
        const isActive = activeTab === item.id;
        const showDot = item.id === "simulator" && simulatorActive;

        return isActive ? (
          <button
            key={item.id}
            type="button"
            role="tab"
            aria-label={item.label}
            aria-selected={true}
            onClick={() => onTabChange(item.id)}
            className={cn(
              "bg-bg-raised text-text-secondary",
              "relative flex h-7 items-center gap-1.5 rounded-lg px-3",
              "text-sm font-medium",
              "transition-colors duration-150",
            )}
          >
            <Icon className="h-[13px] w-[13px]" />
            <span>{item.label}</span>
            {showDot && (
              <span className="bg-success absolute -top-0.5 -right-0.5 h-2 w-2 rounded-full" />
            )}
          </button>
        ) : (
          <Tooltip key={item.id} delayDuration={300}>
            <TooltipTrigger asChild>
              <button
                type="button"
                role="tab"
                aria-label={item.label}
                aria-selected={false}
                onClick={() => onTabChange(item.id)}
                className={cn(
                  "text-text-muted hover:text-text-secondary hover:bg-bg-muted",
                  "relative flex h-7 items-center justify-center rounded-lg px-2",
                  "transition-colors duration-150",
                )}
              >
                <Icon className="h-3.5 w-3.5" />
                {showDot && (
                  <span className="bg-success absolute -top-0.5 -right-0.5 h-2 w-2 rounded-full" />
                )}
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom" sideOffset={8}>
              <p className="text-xs">{item.label}</p>
            </TooltipContent>
          </Tooltip>
        );
      })}
    </div>
  );
}
