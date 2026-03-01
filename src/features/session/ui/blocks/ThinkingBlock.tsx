/**
 * Thinking Block
 *
 * Displays Claude's internal reasoning process.
 * Collapsed by default to reduce clutter.
 * Shows encrypted signature status when present.
 * Expanded content is rendered as markdown for better readability.
 *
 * Uses the same CSS grid data-state pattern as tool collapsibles
 * for smooth height animation without Framer Motion overhead.
 */

import type { ThinkingBlock as ThinkingBlockType } from "@/shared/types";
import { useState } from "react";
import { Brain, ChevronRight } from "lucide-react";
import { cn } from "@/shared/lib/utils";
import { notifyUserExpand } from "../../hooks/useAutoScroll";
import { anchorAndCorrect, findScrollContainer } from "../../hooks/useScrollAnchor";
import { ChatMarkdown } from "@/components/markdown";

interface ThinkingBlockProps {
  block: ThinkingBlockType;
  /** When true, shows a shimmer effect on the preview text to indicate active thinking. */
  isStreaming?: boolean;
}

export function ThinkingBlock({ block, isStreaming = false }: ThinkingBlockProps) {
  const [isExpanded, setIsExpanded] = useState(false);

  // Width-based preview: 90 chars (balanced - not too short, not too long)
  const PREVIEW_CHAR_LIMIT = 90;
  const preview =
    block.thinking.length > PREVIEW_CHAR_LIMIT
      ? block.thinking.substring(0, PREVIEW_CHAR_LIMIT) + "..."
      : block.thinking;

  return (
    <div className="flex flex-col gap-1">
      {/* Header - Minimal, clean */}
      <button
        type="button"
        onClick={(e) => {
          notifyUserExpand();
          const container = findScrollContainer(e.currentTarget);
          if (container) anchorAndCorrect(e.currentTarget, container);
          setIsExpanded(!isExpanded);
        }}
        aria-expanded={isExpanded}
        aria-label="Toggle thinking details"
        className={cn(
          "group flex items-center gap-2 px-2 py-1.5 text-sm",
          "w-full cursor-pointer text-left",
          "opacity-80 transition-opacity duration-100 ease-out hover:opacity-100",
          "focus-visible:ring-ring focus-visible:ring-2 focus-visible:outline-none"
        )}
      >
        {/* Icon container - fixed width to prevent layout shift */}
        <div className="relative h-4 w-4 flex-shrink-0">
          {/* Brain icon - default state (hides on hover or when expanded) */}
          <Brain
            className={cn(
              "text-muted-foreground/70 absolute top-0 left-0 h-4 w-4 transition-opacity duration-100 ease-out",
              isExpanded ? "opacity-0" : "opacity-100 group-hover:opacity-0"
            )}
          />

          {/* Chevron - shows on hover or when expanded (fast like table row hover) */}
          <ChevronRight
            className={cn(
              "text-muted-foreground/50 absolute top-0 left-0 h-4 w-4 transition-[transform,opacity] duration-100 ease-out",
              isExpanded && "rotate-90",
              isExpanded ? "opacity-100" : "opacity-0 group-hover:opacity-100"
            )}
            aria-hidden="true"
          />
        </div>

        {/* Label - consistent weight with tool names */}
        <span className="text-foreground/70 flex-shrink-0 font-normal">
          Thinking
        </span>

        {/* Preview when collapsed only */}
        {!isExpanded && (
          <span
            className={cn(
              "text-muted-foreground truncate italic",
              isStreaming && "tool-loading-shimmer"
            )}
          >
            {preview}
          </span>
        )}
      </button>

      {/* Expanded content — CSS grid height animation, same pattern as tool collapsibles.
          Replaces AnimatePresence + height:"auto" (Framer Motion tracks children, clones
          on exit, manages lifecycle — significant overhead across 50+ thinking blocks).
          CSS grid-template-rows: 0fr->1fr handles the "animate to auto height" natively.
          Content stays in DOM so markdown doesn't re-parse on every toggle. */}
      <div data-state={isExpanded ? "open" : "closed"} className="tool-expand-collapsible">
        <div className="min-h-0 overflow-hidden">
          <div className="text-muted-foreground mt-0.5 ml-6 text-sm opacity-70">
            <ChatMarkdown>{block.thinking}</ChatMarkdown>
          </div>
        </div>
      </div>
    </div>
  );
}
