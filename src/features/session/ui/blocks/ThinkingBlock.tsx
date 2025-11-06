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
import { chatTheme } from "../theme";
import { ChatMarkdown } from "@/components/markdown";

interface ThinkingBlockProps {
  block: ThinkingBlockType;
}

export function ThinkingBlock({ block }: ThinkingBlockProps) {
  const [isExpanded, setIsExpanded] = useState(false);
  const [isHovered, setIsHovered] = useState(false);

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
        onClick={() => setIsExpanded(!isExpanded)}
        onMouseEnter={() => setIsHovered(true)}
        onMouseLeave={() => setIsHovered(false)}
        className={cn(
          "flex items-center gap-2 px-2 py-1.5 text-sm",
          "w-full cursor-pointer text-left",
          "transition-opacity duration-200 hover:opacity-80",
          "focus-visible:ring-ring focus-visible:ring-2 focus-visible:outline-none"
        )}
      >
        {/* Icon container - fixed width to prevent layout shift */}
        <div className="relative h-4 w-4 flex-shrink-0">
          {/* Brain icon - default state */}
          <Brain
            className={cn(
              "text-muted-foreground/70 absolute left-0 top-0 h-4 w-4 transition-opacity duration-50",
              isHovered ? "opacity-0" : "opacity-100"
            )}
          />

          {/* Chevron - hover state (fast like table row hover) */}
          <ChevronRight
            className={cn(
              "text-muted-foreground/50 absolute left-0 top-0 h-4 w-4 transition-all duration-50",
              isExpanded && "rotate-90",
              isHovered ? "opacity-100" : "opacity-0"
            )}
            aria-hidden="true"
          />
        </div>

        {/* Label - consistent weight with tool names */}
        <span className="text-muted-foreground font-normal">Thinking</span>

        {/* Preview when collapsed only */}
        {!isExpanded && (
          <span className="text-muted-foreground truncate text-xs italic">{preview}</span>
        )}
      </button>

      {/* Expanded: show FULL thinking text as markdown */}
      {isExpanded && (
        <div className="text-muted-foreground mt-1 ml-5 text-sm opacity-70">
          <ChatMarkdown>{block.thinking}</ChatMarkdown>
        </div>
      )}
    </div>
  );
}
