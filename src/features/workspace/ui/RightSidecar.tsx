import { useMemo } from "react";
import { Code2, Settings2, Terminal, BookOpen, PenTool, Globe, Smartphone } from "lucide-react";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { cn } from "@/shared/lib/utils";
import { useSettings } from "@/features/settings/api/settings.queries";
import type { RightSideTab } from "@/features/workspace/store";
import type { Settings } from "@shared/types/settings";

interface RightSidecarProps {
  activeTab: RightSideTab;
  onTabChange: (tab: RightSideTab) => void;
  /** Whether the content panel is collapsed (0 width) */
  contentCollapsed: boolean;
  /** Compact mode — middle panel is active, right panel shows compact file list */
  compact?: boolean;
}

const sidecarItems: Array<{
  id: RightSideTab;
  label: string;
  icon: typeof Code2;
  /** Settings key that controls visibility. Absent = always visible. */
  visibilityKey?: keyof Settings;
}> = [
  { id: "code", label: "Code", icon: Code2 },
  { id: "config", label: "Config", icon: Settings2 },
  { id: "terminal", label: "Terminal", icon: Terminal },
  { id: "notebook", label: "Notebook", icon: BookOpen },
  { id: "design", label: "Design", icon: PenTool },
  { id: "browser", label: "Browser", icon: Globe, visibilityKey: "experimental_browser" },
  {
    id: "simulator",
    label: "Simulator",
    icon: Smartphone,
    visibilityKey: "experimental_simulator",
  },
];

/** Check if a tab should be visible given current settings. undefined = visible. */
// eslint-disable-next-line react-refresh/only-export-components -- utility used by MainContent for effective-tab resolution
export function isTabVisible(tab: RightSideTab, settings?: Settings): boolean {
  const item = sidecarItems.find((i) => i.id === tab);
  if (!item?.visibilityKey) return true;
  return settings?.[item.visibilityKey] !== false;
}

/**
 * RightSidecar — Always-visible activity bar.
 *
 * Lives outside the ResizablePanelGroup so it never disappears.
 * Click behavior (VS Code activity bar pattern) is handled by the
 * parent via onTabChange — this component just renders the icons
 * and visual states.
 *
 * Tabs with a `visibilityKey` are hidden when that setting is explicitly `false`.
 * The parent (MainContent) owns effective-tab resolution — `activeTab` prop is
 * already adjusted for hidden tabs, so this component trusts it directly.
 */
export function RightSidecar({
  activeTab,
  onTabChange,
  contentCollapsed,
  compact,
}: RightSidecarProps) {
  const settings = useSettings().data;

  const visibleItems = useMemo(
    () => sidecarItems.filter((item) => isTabVisible(item.id, settings)),
    [settings]
  );

  return (
    <div className="bg-bg-elevated border-border-subtle flex h-full w-[58px] flex-shrink-0 flex-col items-center gap-3 border-l px-1.5 pt-3 pb-5">
      {visibleItems.map((item) => {
        const Icon = item.icon;
        const isActive = activeTab === item.id;
        // Active but content is hidden — show dimmed indicator
        const isActiveCollapsed = isActive && contentCollapsed;
        // In compact mode, non-code tabs will park the diff viewer
        const willCloseDiff = compact && item.id !== "code";

        return (
          <Tooltip key={item.id} delayDuration={200}>
            <TooltipTrigger asChild>
              <button
                type="button"
                aria-label={item.label}
                aria-pressed={isActive && !contentCollapsed}
                onClick={() => onTabChange(item.id)}
                className={cn(
                  "group text-2xs relative flex w-full flex-col items-center gap-1.5 rounded-md px-1 py-1.5 font-medium transition-colors duration-150",
                  isActive && !contentCollapsed
                    ? "text-text-secondary"
                    : "text-text-muted hover:text-text-secondary"
                )}
              >
                <div
                  className={cn(
                    "flex h-[38px] w-[38px] items-center justify-center rounded-md transition-colors duration-150",
                    isActive && !contentCollapsed
                      ? "bg-bg-raised text-text-secondary"
                      : "text-text-muted group-hover:text-text-secondary"
                  )}
                >
                  <Icon className="h-4 w-4" />
                </div>
                <span className="font-sans">{item.label}</span>
                {/* Subtle dot indicator when content is collapsed — shows which tab will reactivate */}
                {isActiveCollapsed && (
                  <span className="bg-text-muted absolute top-1.5 right-1.5 h-1.5 w-1.5 rounded-full opacity-60" />
                )}
              </button>
            </TooltipTrigger>
            <TooltipContent side="left" sideOffset={6}>
              {willCloseDiff ? (
                <div className="flex flex-col gap-0.5">
                  <p className="text-xs font-medium">{item.label}</p>
                  <p className="text-xs opacity-60">Parks diff, restores on Code</p>
                </div>
              ) : contentCollapsed ? (
                <p className="text-xs">Show {item.label}</p>
              ) : isActive ? (
                <p className="text-xs">Hide {item.label}</p>
              ) : (
                <p className="text-xs">{item.label}</p>
              )}
            </TooltipContent>
          </Tooltip>
        );
      })}
    </div>
  );
}
