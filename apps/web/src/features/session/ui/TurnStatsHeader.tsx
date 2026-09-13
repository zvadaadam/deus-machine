import { memo } from "react";
import { ChevronRight } from "lucide-react";
import { cn } from "@/shared/lib/utils";
import type { TurnStats } from "./utils";

interface TurnStatsHeaderProps {
  stats: TurnStats;
  isExpanded: boolean;
  onClick: (e: React.MouseEvent<HTMLButtonElement>) => void;
  activityId: string;
  label: string;
}

export const TurnStatsHeader = memo(function TurnStatsHeader({
  stats,
  isExpanded,
  onClick,
  activityId,
  label,
}: TurnStatsHeaderProps) {
  const { toolCount, subagentCount, filesChanged } = stats;

  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        // Match BaseToolRenderer exactly: px-2 py-1.5 text-sm
        "flex items-center gap-2 px-2 py-1.5 text-sm",
        "w-full cursor-pointer text-left",
        "transition-opacity duration-150 ease-out",
        "opacity-80 hover:opacity-100",
        "focus-visible:ring-ring focus-visible:ring-2 focus-visible:outline-none"
      )}
      aria-controls={activityId}
      aria-expanded={isExpanded}
      aria-label={`${isExpanded ? "Collapse" : "Expand"} activity with ${toolCount} tool calls`}
    >
      <div className="flex min-w-0 flex-1 items-center gap-2">
        {/* Chevron container - same size as tool icons (14x14px) for perfect alignment */}
        <div className="relative h-3.5 w-3.5 flex-shrink-0">
          <ChevronRight
            className={cn(
              "text-muted-foreground/50 absolute top-0 left-0 h-3.5 w-3.5 transition-[transform,opacity] duration-150 ease-out",
              isExpanded && "rotate-90"
            )}
            aria-hidden="true"
          />
        </div>

        {/* Metrics stay visible in both states — expansion should add detail, not remove context. */}
        <>
          <span className="text-muted-foreground truncate tabular-nums">{label}</span>

          {subagentCount > 0 && (
            <>
              <span className="text-muted-foreground/30" aria-hidden="true">
                •
              </span>
              <span className="text-muted-foreground truncate tabular-nums">
                {subagentCount} subagent{subagentCount !== 1 ? "s" : ""}
              </span>
            </>
          )}

          {toolCount > 0 && (
            <>
              <span className="text-muted-foreground/30" aria-hidden="true">
                •
              </span>
              <span className="text-muted-foreground truncate tabular-nums">
                {toolCount} tool call{toolCount !== 1 ? "s" : ""}
              </span>
            </>
          )}

          {filesChanged > 0 && (
            <>
              <span className="text-muted-foreground/30" aria-hidden="true">
                •
              </span>
              <span className="text-muted-foreground truncate tabular-nums">
                {filesChanged} file{filesChanged !== 1 ? "s" : ""} changed
              </span>
            </>
          )}
        </>
      </div>
    </button>
  );
});
