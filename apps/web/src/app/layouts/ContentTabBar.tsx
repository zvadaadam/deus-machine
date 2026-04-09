/**
 * Content Tab Bar — icon tab switcher for the content panel header.
 *
 * Renders inside the content panel's header bar (36px), left-aligned.
 * Active tab: filled pill (bg-bg-raised) with icon + text label.
 * Inactive tabs: icon only with native title on hover.
 *
 * Tab definitions and visibility logic live in content-tabs.ts.
 * This component is pure presentation — it renders icons/pills and fires onTabChange.
 */

import { useMemo } from "react";
import { cn } from "@/shared/lib/utils";
import { useSettings } from "@/features/settings/api/settings.queries";
import { useSimulatorStatusStore } from "@/features/simulator/store";
import type { ContentTab } from "@/features/workspace/store";
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
          <button
            key={item.id}
            type="button"
            role="tab"
            title={item.label}
            aria-label={item.label}
            aria-selected={false}
            onClick={() => onTabChange(item.id)}
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
        );
      })}
    </div>
  );
}
