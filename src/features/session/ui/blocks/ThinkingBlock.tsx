/**
 * Thinking Block
 *
 * Displays Claude's internal reasoning process.
 * Collapsed by default to reduce clutter.
 * Shows encrypted signature status when present.
 */

import type { ThinkingBlock as ThinkingBlockType } from "@/shared/types";
import { useState } from "react";
import { Brain, ChevronRight } from "lucide-react";
import { cn } from "@/shared/lib/utils";
import { chatTheme } from "../theme";

interface ThinkingBlockProps {
  block: ThinkingBlockType;
}

export function ThinkingBlock({ block }: ThinkingBlockProps) {
  const [isExpanded, setIsExpanded] = useState(false);

  // Width-based preview: 120 chars
  const PREVIEW_CHAR_LIMIT = 120;
  const preview =
    block.thinking.length > PREVIEW_CHAR_LIMIT
      ? block.thinking.substring(0, PREVIEW_CHAR_LIMIT) + "..."
      : block.thinking;

  return (
    <div className="flex flex-col gap-1">
      {/* Header - Minimal, clean */}
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        className={cn(
          "flex items-center gap-2 px-2 py-1.5 text-sm",
          "w-full cursor-pointer text-left",
          "transition-opacity duration-200 hover:opacity-80",
          "focus-visible:ring-ring focus-visible:ring-2 focus-visible:outline-none"
        )}
      >
        {/* Chevron - subtle and small */}
        <ChevronRight
          className={cn(
            "text-muted-foreground/50 h-3 w-3 flex-shrink-0 transition-transform duration-200",
            isExpanded && "rotate-90"
          )}
          aria-hidden="true"
        />

        {/* Icon - consistent gray */}
        <Brain className="text-muted-foreground/70 h-4 w-4 flex-shrink-0" />

        {/* Label */}
        <span className="font-medium">Thinking</span>

        {/* Preview when collapsed only */}
        {!isExpanded && (
          <span className="text-muted-foreground truncate text-xs italic">{preview}</span>
        )}
      </button>

      {/* Expanded: show FULL thinking text */}
      {isExpanded && (
        <div className="text-muted-foreground mt-1 ml-5 text-sm leading-relaxed whitespace-pre-wrap">
          {block.thinking}
        </div>
      )}
    </div>
  );
}
