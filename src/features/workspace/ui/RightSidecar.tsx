import { Code2, Settings2, Terminal, PenTool, Globe } from "lucide-react";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { cn } from "@/shared/lib/utils";
import type { RightSideTab } from "@/features/workspace/store";

interface RightSidecarProps {
  activeTab: RightSideTab;
  onTabChange: (tab: RightSideTab) => void;
  /** Compact mode — clicking non-code tabs exits compact mode first */
  compact?: boolean;
  /** Called when a non-code tab is clicked in compact mode (closes diff viewer) */
  onRequestExitCompact?: () => void;
}

const sidecarItems: Array<{
  id: RightSideTab;
  label: string;
  icon: typeof Code2;
}> = [
  { id: "code", label: "Code", icon: Code2 },
  { id: "config", label: "Config", icon: Settings2 },
  { id: "terminal", label: "Terminal", icon: Terminal },
  { id: "design", label: "Design", icon: PenTool },
  { id: "browser", label: "Browser", icon: Globe },
];

/**
 * RightSidecar — V2: Jony Ive
 *
 * Vertical icon strip. Active tab gets bg-overlay + text-secondary.
 * Inactive: text-muted. No borders on icons — depth via background only.
 */
export function RightSidecar({
  activeTab,
  onTabChange,
  compact,
  onRequestExitCompact,
}: RightSidecarProps) {
  return (
    <div className="bg-bg-elevated border-border-subtle flex h-full w-[58px] flex-shrink-0 flex-col items-center gap-3 border-l px-1.5 pt-3 pb-5">
      {sidecarItems.map((item) => {
        const Icon = item.icon;
        const isActive = activeTab === item.id;
        // In compact mode, non-code tabs temporarily close the diff viewer.
        // The layout restores when the user comes back to Code.
        const willCloseDiff = compact && item.id !== "code";

        return (
          <Tooltip key={item.id} delayDuration={200}>
            <TooltipTrigger asChild>
              <button
                type="button"
                aria-label={item.label}
                aria-pressed={isActive}
                onClick={() => {
                  // Set tab first, then exit compact mode if needed.
                  // React batches both updates in the same tick.
                  onTabChange(item.id);
                  if (willCloseDiff && onRequestExitCompact) {
                    onRequestExitCompact();
                  }
                }}
                className={cn(
                  "group flex w-full flex-col items-center gap-1.5 rounded-md px-1 py-1.5 text-[10px] font-medium transition-colors duration-150",
                  isActive ? "text-text-secondary" : "text-text-muted hover:text-text-secondary"
                )}
              >
                <div
                  className={cn(
                    "flex h-[38px] w-[38px] items-center justify-center rounded-md transition-colors duration-150",
                    isActive
                      ? "bg-bg-raised text-text-secondary"
                      : "text-text-muted group-hover:text-text-secondary"
                  )}
                >
                  <Icon className="h-4 w-4" />
                </div>
                <span className="font-sans">{item.label}</span>
              </button>
            </TooltipTrigger>
            <TooltipContent side="left" sideOffset={6}>
              {willCloseDiff ? (
                <div className="flex flex-col gap-0.5">
                  <p className="text-xs font-medium">{item.label}</p>
                  <p className="text-[11px] opacity-60">Parks diff, restores on Code</p>
                </div>
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
