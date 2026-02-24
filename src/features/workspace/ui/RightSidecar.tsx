import { Code2, Settings2, Terminal, BookOpen, PenTool, Globe, Smartphone } from "lucide-react";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { cn } from "@/shared/lib/utils";
import type { RightSideTab } from "@/features/workspace/store";

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
}> = [
  { id: "code", label: "Code", icon: Code2 },
  { id: "config", label: "Config", icon: Settings2 },
  { id: "terminal", label: "Terminal", icon: Terminal },
  { id: "notebook", label: "Notebook", icon: BookOpen },
  { id: "design", label: "Design", icon: PenTool },
  { id: "browser", label: "Browser", icon: Globe },
  { id: "simulator", label: "Simulator", icon: Smartphone },
];

/**
 * RightSidecar — Always-visible activity bar.
 *
 * Lives outside the ResizablePanelGroup so it never disappears.
 * Click behavior (VS Code activity bar pattern) is handled by the
 * parent via onTabChange — this component just renders the icons
 * and visual states.
 */
export function RightSidecar({
  activeTab,
  onTabChange,
  contentCollapsed,
  compact,
}: RightSidecarProps) {
  return (
    <div className="bg-bg-elevated border-border-subtle flex h-full w-[58px] flex-shrink-0 flex-col items-center gap-3 border-l px-1.5 pt-3 pb-5">
      {sidecarItems.map((item) => {
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
                  "group relative flex w-full flex-col items-center gap-1.5 rounded-md px-1 py-1.5 text-2xs font-medium transition-colors duration-150",
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
                  <span className="bg-text-muted absolute right-1.5 top-1.5 h-1.5 w-1.5 rounded-full opacity-60" />
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
