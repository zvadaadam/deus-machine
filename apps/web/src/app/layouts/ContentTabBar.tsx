import { useMemo } from "react";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { cn } from "@/shared/lib/utils";
import { useSettings } from "@/features/settings/api/settings.queries";
import { useSimulatorStatusStore } from "@/features/simulator/store";
import { useCloudSimulatorStore } from "@/features/simulator/cloud/cloudSimulatorStore";
import type { ContentTab } from "@/features/workspace/store";
import { CONTENT_TABS, isTabVisible, type ContentTabItem } from "./content-tabs";

interface ContentTabBarProps {
  activeTab: ContentTab;
  onTabChange: (tab: ContentTab) => void;
  workspaceId?: string | null;
  simulatorAvailable: boolean;
  /** The selected workspace is a cloud computer — its device lives in the platform. */
  cloudSimulator: boolean;
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
        "relative flex h-7 shrink-0 items-center rounded-lg whitespace-nowrap transition-colors duration-150",
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

export function ContentTabBar({
  activeTab,
  onTabChange,
  workspaceId,
  simulatorAvailable,
  cloudSimulator,
}: ContentTabBarProps) {
  const settings = useSettings().data;
  const simPhase = useSimulatorStatusStore((s) =>
    workspaceId ? s.phases[workspaceId] : undefined
  );
  // The cloud device's status; null = no device was ever known to this workspace.
  const cloudSimStatus = useCloudSimulatorStore((s) =>
    workspaceId ? (s.byWorkspace[workspaceId]?.status ?? null) : null
  );

  const simulatorActive = (simPhase && simPhase !== "idle") || cloudSimStatus === "ready";

  const visibleItems = useMemo(
    () =>
      CONTENT_TABS.filter((item) =>
        isTabVisible(item.id, settings, { simulatorAvailable, cloudSimulator })
      ),
    [settings, simulatorAvailable, cloudSimulator]
  );

  return (
    <div
      data-slot="content-tab-bar"
      className="no-drag scrollbar-hidden min-w-0 flex-1 overflow-x-auto"
    >
      <div className="flex w-max items-center gap-1" role="tablist" aria-label="Content panel">
        {visibleItems.map((item) => {
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
    </div>
  );
}
