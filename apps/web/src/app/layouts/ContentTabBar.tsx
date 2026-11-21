import { useMemo, useState, type SyntheticEvent } from "react";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { cn } from "@/shared/lib/utils";
import { useSettings } from "@/features/settings/api/settings.queries";
import { useSimulatorStatusStore } from "@/features/simulator/store";
import { useCloudSimulatorStore } from "@/features/simulator/cloud/cloudSimulatorStore";
import type { ContentTab } from "@/features/workspace/store";
import {
  CONTENT_TABS,
  isTabVisible,
  type ContentTabItem,
  type ContentTabVisibility,
} from "./content-tabs";

interface ContentTabBarProps {
  activeTab: ContentTab;
  onTabChange: (tab: ContentTab) => void;
  workspaceId?: string | null;
  /** The workspace's tab gates (`tabsFor`). */
  visibility: ContentTabVisibility;
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
  const [open, setOpen] = useState(false);
  // A shortcut can select this tab while its tooltip is open.
  if (isActive && open) setOpen(false);
  const skipActive = isActive ? (event: SyntheticEvent) => event.preventDefault() : undefined;
  return (
    <Tooltip delayDuration={300} open={open} onOpenChange={setOpen}>
      <TooltipTrigger asChild onPointerMove={skipActive} onFocus={skipActive}>
        <button
          type="button"
          role="tab"
          aria-label={item.label}
          aria-selected={isActive}
          onClick={onClick}
          className={cn(
            "control-interaction group relative flex h-7 shrink-0 items-center rounded-lg whitespace-nowrap",
            isActive
              ? "bg-bg-raised text-text-secondary"
              : "text-text-muted hover:text-text-secondary hover:bg-control-hover active:bg-control-pressed"
          )}
        >
          {/* The tracks are the leading inset, glyph, label and trailing inset. */}
          <span
            aria-hidden="true"
            className="tempo-moderate ease-move grid grid-cols-[8px_14px_0fr_8px] items-center transition-[grid-template-columns] group-aria-selected:grid-cols-[12px_13px_1fr_12px]"
          >
            <Icon className="col-start-2 h-auto w-full" />
            <span className="ease-move motion-safe:tempo-fast-exit motion-safe:group-aria-selected:tempo-moderate overflow-hidden indent-1.5 text-sm font-medium opacity-0 group-aria-selected:opacity-100 motion-safe:transition-opacity">
              {item.label}
            </span>
          </span>
          {showDot && (
            <span className="bg-success absolute -top-0.5 -right-0.5 size-2 rounded-full" />
          )}
        </button>
      </TooltipTrigger>
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
  visibility,
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
    () => CONTENT_TABS.filter((item) => isTabVisible(item.id, settings, visibility)),
    [settings, visibility]
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
