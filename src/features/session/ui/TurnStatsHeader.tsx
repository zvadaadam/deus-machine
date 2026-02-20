/**
 * Turn Stats Header
 *
 * Displays aggregated statistics for a collapsed assistant turn.
 * Matches the exact visual alignment of BaseToolRenderer for consistency.
 *
 * Design principles (Johnny Ive):
 * - Perfect alignment with tool calls below (same padding, same icon size)
 * - Chevron in 16x16px container on the left (matches tool icons)
 * - Minimal, intentional - every pixel matters
 * - Visual continuity - feels part of the same system
 * - Context-aware: Shows "Collapse" when expanded, metrics when collapsed
 */

import { ChevronRight } from "lucide-react";
import { cn } from "@/shared/lib/utils";
import type { TurnStats } from "./utils";

interface TurnStatsHeaderProps {
  stats: TurnStats;
  isExpanded: boolean;
  onClick: () => void;
  hiddenMessageCount: number; // Number of messages hidden when collapsed
}

export function TurnStatsHeader({
  stats,
  isExpanded,
  onClick,
  hiddenMessageCount,
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
        "transition-opacity duration-200 ease-out",
        "hover:opacity-70",
        "focus-visible:ring-ring focus-visible:ring-2 focus-visible:outline-none"
      )}
      aria-expanded={isExpanded}
      aria-label={`${isExpanded ? "Collapse" : "Expand"} assistant turn with ${toolCount} tool calls`}
    >
      <div className="flex min-w-0 flex-1 items-center gap-2">
        {/* Chevron container - same size as tool icons (16x16px) for perfect alignment */}
        <div className="relative h-4 w-4 flex-shrink-0">
          <ChevronRight
            className={cn(
              "text-muted-foreground/50 absolute left-0 top-0 h-4 w-4 transition-transform duration-200",
              isExpanded && "rotate-90"
            )}
            aria-hidden="true"
          />
        </div>

        {isExpanded ? (
          // Expanded state: Show clear action
          <span className="text-muted-foreground truncate font-normal">Collapse</span>
        ) : (
          // Collapsed state: Show metrics breakdown
          <>
            {/* Primary metric: Message count (always shown) */}
            <span className="text-muted-foreground truncate font-normal tabular-nums">
              {hiddenMessageCount} message{hiddenMessageCount !== 1 ? "s" : ""}
            </span>

            {/* Subagent count (only if > 0) */}
            {subagentCount > 0 && (
              <>
                <span className="text-muted-foreground/40" aria-hidden="true">
                  •
                </span>
                <span className="text-muted-foreground truncate tabular-nums">
                  {subagentCount} subagent{subagentCount !== 1 ? "s" : ""}
                </span>
              </>
            )}

            {/* Secondary metric: Tool calls (only if > 0) */}
            {toolCount > 0 && (
              <>
                <span className="text-muted-foreground/40" aria-hidden="true">
                  •
                </span>
                <span className="text-muted-foreground truncate tabular-nums">
                  {toolCount} tool call{toolCount !== 1 ? "s" : ""}
                </span>
              </>
            )}

            {/* Tertiary metric: Files changed (only if > 0) */}
            {filesChanged > 0 && (
              <>
                <span className="text-muted-foreground/40" aria-hidden="true">
                  •
                </span>
                <span className="text-muted-foreground truncate tabular-nums">
                  {filesChanged} file{filesChanged !== 1 ? "s" : ""} changed
                </span>
              </>
            )}
          </>
        )}
      </div>
    </button>
  );
}
