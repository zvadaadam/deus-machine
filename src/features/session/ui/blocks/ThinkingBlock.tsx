/**
 * Thinking Block
 *
 * Displays Claude's internal reasoning process.
 * Collapsed by default to reduce clutter.
 * Shows encrypted signature status when present.
 * Expanded content is rendered as markdown for better readability.
 */

import type { ThinkingBlock as ThinkingBlockType } from "@/shared/types";
import { useState } from "react";
import { Brain, ChevronRight } from "lucide-react";
import { cn } from "@/shared/lib/utils";
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
        onClick={() => setIsExpanded(!isExpanded)}
        aria-expanded={isExpanded}
        aria-label="Toggle thinking details"
        className={cn(
          "group flex items-center gap-2 px-2 py-1.5 text-xs",
          "w-full cursor-pointer text-left",
          "opacity-80 transition-opacity duration-100 ease-in hover:opacity-100",
          "focus-visible:ring-ring focus-visible:ring-2 focus-visible:outline-none"
        )}
      >
        {/* Icon container - fixed width to prevent layout shift */}
        <div className="relative h-4 w-4 flex-shrink-0">
          {/* Brain icon - default state (hides on hover or when expanded) */}
          <Brain
            className={cn(
              "text-muted-foreground/70 absolute top-0 left-0 h-4 w-4 transition-opacity duration-100 ease-in",
              isExpanded ? "opacity-0" : "opacity-100 group-hover:opacity-0"
            )}
          />

          {/* Chevron - shows on hover or when expanded (fast like table row hover) */}
          <ChevronRight
            className={cn(
              "text-muted-foreground/50 absolute top-0 left-0 h-4 w-4 transition-all duration-100 ease-in",
              isExpanded && "rotate-90",
              isExpanded ? "opacity-100" : "opacity-0 group-hover:opacity-100"
            )}
            aria-hidden="true"
          />
        </div>

        {/* Label - consistent weight with tool names */}
        <span className="text-muted-foreground text-foreground/70 truncate font-normal">
          Thinking
        </span>

        {/* Preview when collapsed only */}
        {!isExpanded && (
          <span
            className={cn(
              "text-muted-foreground truncate text-xs italic",
              isStreaming && "tool-loading-shimmer"
            )}
          >
            {preview}
          </span>
        )}
      </button>

      {/* Expanded: show FULL thinking text as markdown */}
      {isExpanded && (
        <div
          className="text-muted-foreground mt-0.5 ml-6 text-sm opacity-70"
          style={{
            animation: "chat-block-fade 200ms cubic-bezier(.215,.61,.355,1) both",
          }}
        >
          <ChatMarkdown>{block.thinking}</ChatMarkdown>
        </div>
      )}
    </div>
  );
}
