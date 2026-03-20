/**
 * Tool Group Block — Stable Wrapper with Delayed Grouping
 *
 * Wraps consecutive tool_use blocks in a stable container that exists from the
 * first tool's render. During streaming the wrapper is invisible (no header,
 * tools fully visible). When the streak is "sealed" (text follows or turn
 * completes) and contains 2+ tools, a header appears and tools collapse.
 *
 * Collapse behavior:
 * Tools fully unmount when collapsed (AnimatePresence + conditional render).
 * This is intentional — zero DOM weight when collapsed, consistent with
 * ThinkingBlock and SubagentGroupBlock. Per-tool expand state resets on
 * reopen, which is acceptable since tool groups are bounded (2-15 items).
 */

import { useState, useMemo, memo } from "react";
import { ChevronRight, Layers } from "lucide-react";
import { AnimatePresence, m } from "framer-motion";
import { cn } from "@/shared/lib/utils";
import type { ToolUseBlock as ToolUseBlockType } from "@/shared/types";

import { ToolUseBlock } from "./ToolUseBlock";
import { useSession } from "../../context";

interface ToolGroupBlockProps {
  blocks: ToolUseBlockType[];
  isSealed: boolean;
}

const expandTransition = { duration: 0.2, ease: [0.165, 0.84, 0.44, 1] as const };

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
  // During streaming (unsealed), tools render individually — no header.
  // When sealed (text follows or turn completes), header appears and tools collapse.
  const showHeader = isSealed && blocks.length >= 2;

  // Expand state: manual override (null = use default).
  // Default: collapsed when header shows, expanded when no header.
  // When user toggles, manualExpanded locks their preference.
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
            onClick={() => {
              setManualExpanded(!isExpanded);
            }}
            className={cn(
              "group flex items-center gap-2 px-2 py-1.5 text-sm",
              "w-full cursor-pointer text-left",
              "transition-opacity duration-150 ease-out",
              "opacity-80 hover:opacity-100",
              "focus-visible:ring-ring focus-visible:ring-2 focus-visible:outline-none"
            )}
            aria-expanded={isExpanded}
            aria-label={`${isExpanded ? "Collapse" : "Expand"} ${blocks.length} tool calls`}
          >
            <div className="flex min-w-0 flex-1 items-center gap-2">
              {/* Icon container — 14x14px, icon/chevron swap on hover */}
              <div className="relative h-3.5 w-3.5 flex-shrink-0">
                {/* Layers icon — hides on hover or expanded */}
                <div
                  className={cn(
                    "absolute top-0 left-0 transition-opacity duration-150 ease-out",
                    isExpanded ? "opacity-0" : "opacity-100 group-hover:opacity-0"
                  )}
                >
                  <Layers className="text-muted-foreground/70 h-3.5 w-3.5" />
                </div>

                {/* Chevron — shows on hover or expanded */}
                <ChevronRight
                  className={cn(
                    "text-muted-foreground/50 absolute top-0 left-0 h-3.5 w-3.5 transition-[transform,opacity] duration-150 ease-out",
                    isExpanded && "rotate-90",
                    isExpanded ? "opacity-100" : "opacity-0 group-hover:opacity-100"
                  )}
                  aria-hidden="true"
                />
              </div>

              {/* Tool count */}
              <span className="text-foreground/70 font-medium tabular-nums">
                {blocks.length} tool call{blocks.length !== 1 ? "s" : ""}
              </span>

              {/* Tool names summary (collapsed only) */}
              {!isExpanded && (
                <>
                  <span className="text-muted-foreground/30" aria-hidden="true">
                    ·
                  </span>
                  <span className="text-muted-foreground truncate">{toolSummary}</span>
                </>
              )}
            </div>
          </button>
        </div>
      )}

      {/* Content — AnimatePresence for enter/exit opacity fade.
          When collapsed, tool blocks unmount entirely — no DOM weight.
          When expanded, they mount with a subtle opacity fade. */}
      <AnimatePresence>
        {isOpen && (
          <m.div
            initial={showHeader ? { opacity: 0, height: 0 } : false}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            transition={expandTransition}
            className="flex flex-col gap-0.5 overflow-hidden"
          >
            {blocks.map((block) => (
              <ToolUseBlock key={block.id} block={block} toolResult={toolResultMap.get(block.id)} />
            ))}
          </m.div>
        )}
      </AnimatePresence>
    </div>
  );
});
