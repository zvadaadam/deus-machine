/**
 * Tool Group Block — Stable Wrapper with Delayed Grouping
 *
 * Wraps consecutive tool_use blocks in a stable container that exists from the
 * first tool's render. During streaming the wrapper is invisible (no header,
 * tools fully visible). When the streak is "sealed" (text follows or turn
 * completes) and contains 2+ tools, a header appears and tools collapse.
 *
 * Why tools never remount:
 * The parent chain (ToolGroupBlock > Collapsible > CollapsibleContent > tools)
 * is identical at every timestep. Only the `open` prop and CSS classes change.
 * forceMount keeps collapsed tools in the DOM, preserving BaseToolRenderer's
 * manualExpanded state and preventing Framer Motion animation replay.
 */

import { useState, useMemo, memo } from "react";
import { ChevronRight, Layers } from "lucide-react";
import { cn } from "@/shared/lib/utils";
import type { ToolUseBlock as ToolUseBlockType } from "@/shared/types";
import { ToolUseBlock } from "./ToolUseBlock";
import { useSession } from "../../context";

interface ToolGroupBlockProps {
  blocks: ToolUseBlockType[];
  isSealed: boolean;
}

/**
 * Memoized: blocks is a stable array ref from groupToolStreaks (only changes
 * when actual tool blocks change), isSealed transitions false→true once.
 * Without memo, every new message in the turn re-renders all sibling groups.
 */
export const ToolGroupBlock = memo(function ToolGroupBlock({
  blocks,
  isSealed,
}: ToolGroupBlockProps) {
  const { toolResultMap } = useSession();

  // Show header only for sealed streaks with 2+ tools.
  // Single-tool streaks render as if there's no wrapper (invisible).
  const showHeader = isSealed && blocks.length >= 2;

  // Expand state: manual override (null = use default).
  // Default: collapsed when header shows, expanded when no header.
  // When user toggles, manualExpanded locks their preference.
  // No setState in effects — auto-collapse happens naturally via derived state.
  const [manualExpanded, setManualExpanded] = useState<boolean | null>(null);
  const isExpanded = manualExpanded !== null ? manualExpanded : !showHeader;

  // For single tools or unsealed streaks: always open (wrapper invisible)
  const isOpen = showHeader ? isExpanded : true;

  // Unique tool names for collapsed summary: "Read, Grep, Edit"
  const toolSummary = useMemo(() => {
    const names = new Set(blocks.map((b) => b.name));
    return [...names].join(", ");
  }, [blocks]);

  return (
    <div className="flex flex-col" style={{ contain: "layout style" }}>
      {/* Header — only shown for sealed streaks with 2+ tools.
          CSS animation replaces Framer Motion m.div: plays once on mount then
          the element is a plain div with zero ongoing React overhead. */}
      {showHeader && (
        <div className="tool-group-header-enter">
          <button
            type="button"
            onClick={() => setManualExpanded(!isExpanded)}
            className={cn(
              "group flex items-center gap-2 px-2 py-1.5 text-sm",
              "w-full cursor-pointer text-left",
              "ease transition-opacity duration-200",
              "hover:opacity-70",
              "focus-visible:ring-ring focus-visible:ring-2 focus-visible:outline-none"
            )}
            aria-expanded={isExpanded}
            aria-label={`${isExpanded ? "Collapse" : "Expand"} ${blocks.length} tool calls`}
          >
            <div className="flex min-w-0 flex-1 items-center gap-2">
              {/* Icon container — 16x16px, icon/chevron swap on hover */}
              <div className="relative h-4 w-4 flex-shrink-0">
                {/* Layers icon — hides on hover or expanded */}
                <div
                  className={cn(
                    "absolute top-0 left-0 transition-opacity duration-100 ease-out",
                    isExpanded ? "opacity-0" : "opacity-100 group-hover:opacity-0"
                  )}
                >
                  <Layers className="text-muted-foreground/70 h-4 w-4" />
                </div>

                {/* Chevron — shows on hover or expanded */}
                <ChevronRight
                  className={cn(
                    "text-muted-foreground/50 absolute top-0 left-0 h-4 w-4 transition-[transform,opacity] duration-100 ease-out",
                    isExpanded && "rotate-90",
                    isExpanded ? "opacity-100" : "opacity-0 group-hover:opacity-100"
                  )}
                  aria-hidden="true"
                />
              </div>

              {/* Tool count — plain text, no NumberFlow. The count only changes
                  when the streak seals (once), so animated digit transitions add
                  IntersectionObserver + rAF overhead per group for zero visual benefit. */}
              <span className="text-muted-foreground font-normal tabular-nums">
                {blocks.length} tool call{blocks.length !== 1 ? "s" : ""}
              </span>

              {/* Tool names summary (collapsed only) */}
              {!isExpanded && (
                <>
                  <span className="text-muted-foreground/40" aria-hidden="true">
                    ·
                  </span>
                  <span className="text-muted-foreground/60 truncate text-xs">{toolSummary}</span>
                </>
              )}
            </div>
          </button>
        </div>
      )}

      {/* Content — always in DOM, collapsed via CSS grid.
          Plain div with data-state replaces Radix Collapsible because Radix's
          useLayoutEffect kills CSS grid transitions (sets transition-duration:0s for measurement).
          The parent chain of every ToolUseBlock never changes, preserving expand state. */}
      <div data-state={isOpen ? "open" : "closed"} className="tool-group-collapsible">
        <div className="min-h-0 overflow-hidden">
          <div className="flex flex-col gap-0.5">
            {blocks.map((block) => (
              <ToolUseBlock key={block.id} block={block} toolResult={toolResultMap.get(block.id)} />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
});
