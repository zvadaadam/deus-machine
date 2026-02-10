import { Code2, Settings2, Terminal, PenTool, Globe } from "lucide-react";
import { cn } from "@/shared/lib/utils";
import type { RightSideTab } from "@/features/workspace/store";

interface RightSidecarProps {
  activeTab: RightSideTab;
  onTabChange: (tab: RightSideTab) => void;
  /** Compact mode — disables non-code tabs when diff viewer is active */
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
  { id: "design", label: "Design", icon: PenTool },
  { id: "browser", label: "Browser", icon: Globe },
];

/**
 * RightSidecar — V2: Jony Ive
 *
 * Vertical icon strip. Active tab gets bg-overlay + text-secondary.
 * Inactive: text-muted. No borders on icons — depth via background only.
 */
export function RightSidecar({ activeTab, onTabChange, compact }: RightSidecarProps) {
  return (
    <div className="bg-bg-elevated border-border-subtle flex h-full w-[58px] flex-shrink-0 flex-col items-center gap-3 border-l px-1.5 pt-3 pb-5">
      {sidecarItems.map((item) => {
        const Icon = item.icon;
        const isActive = activeTab === item.id;
        const isDisabled = compact && item.id !== "code";
        return (
          <button
            key={item.id}
            type="button"
            aria-label={item.label}
            aria-pressed={isActive}
            disabled={isDisabled}
            title={isDisabled ? `Close diff to use ${item.label}` : undefined}
            onClick={() => !isDisabled && onTabChange(item.id)}
            className={cn(
              "group flex w-full flex-col items-center gap-1.5 rounded-md px-1 py-1.5 text-[10px] font-medium transition-colors duration-150",
              isDisabled
                ? "cursor-not-allowed opacity-30"
                : isActive
                  ? "text-text-secondary"
                  : "text-text-muted hover:text-text-secondary"
            )}
          >
            <div
              className={cn(
                "flex h-[38px] w-[38px] items-center justify-center rounded-md transition-colors duration-150",
                isDisabled
                  ? "text-text-disabled"
                  : isActive
                    ? "bg-bg-raised text-text-secondary"
                    : "text-text-muted group-hover:text-text-secondary"
              )}
            >
              <Icon className="h-4 w-4" />
            </div>
            <span className="font-sans">{item.label}</span>
          </button>
        );
      })}
    </div>
  );
}
