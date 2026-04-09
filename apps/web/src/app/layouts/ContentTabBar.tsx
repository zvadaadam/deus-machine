/**
 * Content Tab Bar — icon tab switcher for the content panel header.
 *
 * Renders inside the content panel's header bar (36px), left-aligned.
 * Active tab: filled pill (bg-bg-raised) with icon + text label.
 * Inactive tabs: icon only with tooltip on hover.
 *
 * Tab definitions and visibility logic live in content-tabs.ts.
 * This component is pure presentation — it renders icons/pills and fires onTabChange.
 */

import { memo, useCallback, useMemo } from "react";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { cn } from "@/shared/lib/utils";
import { useSettings } from "@/features/settings/api/settings.queries";
import { useSimulatorStatusStore } from "@/features/simulator/store";
import type { ContentTab } from "@/features/workspace/store";
import type { LucideIcon } from "lucide-react";
import { CONTENT_TABS, isTabVisible } from "./content-tabs";

interface ContentTabBarProps {
  activeTab: ContentTab;
  onTabChange: (tab: ContentTab) => void;
  workspaceId?: string | null;
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

  return (
    <div
      data-slot="content-tab-bar"
      className="flex items-center gap-1"
      role="tablist"
      aria-label="Content panel"
    >
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
              "transition-colors duration-150"
            )}
          >
            <Icon className="h-[13px] w-[13px]" />
            <span>{item.label}</span>
            {showDot && (
              <span className="bg-success absolute -top-0.5 -right-0.5 h-2 w-2 rounded-full" />
            )}
          </button>
        ) : (
          <InactiveTab
            key={item.id}
            id={item.id}
            label={item.label}
            icon={Icon}
            showDot={showDot}
            onTabChange={onTabChange}
          />
        );
      })}
    </div>
  );
}

const InactiveTab = memo(function InactiveTab({
  id,
  label,
  icon: Icon,
  showDot,
  onTabChange,
}: {
  id: ContentTab;
  label: string;
  icon: LucideIcon;
  showDot: boolean | undefined;
  onTabChange: (tab: ContentTab) => void;
}) {
  const handleClick = useCallback(() => onTabChange(id), [onTabChange, id]);

  return (
    <Tooltip delayDuration={300}>
      <TooltipTrigger asChild>
        <button
          type="button"
          role="tab"
          aria-label={label}
          aria-selected={false}
          onClick={handleClick}
          className={cn(
            "text-text-muted hover:text-text-secondary hover:bg-bg-muted",
            "relative flex h-7 items-center justify-center rounded-lg px-2",
            "transition-colors duration-150"
          )}
        >
          <Icon className="h-3.5 w-3.5" />
          {showDot && (
            <span className="bg-success absolute -top-0.5 -right-0.5 h-2 w-2 rounded-full" />
          )}
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom" sideOffset={8}>
        <p className="text-xs">{label}</p>
      </TooltipContent>
    </Tooltip>
  );
});
