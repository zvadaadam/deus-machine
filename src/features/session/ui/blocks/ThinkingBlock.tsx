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
import { AnimatePresence, motion } from "framer-motion";
import { cn } from "@/shared/lib/utils";

import { ChatMarkdown } from "@/components/markdown";

interface ThinkingBlockProps {
  block: ThinkingBlockType;
  /** When true, shows a shimmer effect on the preview text to indicate active thinking. */
  isStreaming?: boolean;
}

const expandTransition = { duration: 0.15, ease: [0.165, 0.84, 0.44, 1] as const };

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
        onClick={() => {
          setIsExpanded(!isExpanded);
        }}
        aria-expanded={isExpanded}
        aria-label="Toggle thinking details"
        className={cn(
          "group flex items-center gap-2 px-2 py-1.5 text-sm",
          "w-full cursor-pointer text-left",
          "opacity-80 transition-opacity duration-150 ease-out hover:opacity-100",
          "focus-visible:ring-ring focus-visible:ring-2 focus-visible:outline-none"
        )}
      >
        {/* Icon container - fixed width to prevent layout shift */}
        <div className="relative h-3.5 w-3.5 flex-shrink-0">
          {/* Brain icon - default state (hides on hover or when expanded) */}
          <Brain
            className={cn(
              "text-muted-foreground/70 absolute top-0 left-0 h-3.5 w-3.5 transition-opacity duration-150 ease-out",
              isExpanded ? "opacity-0" : "opacity-100 group-hover:opacity-0"
            )}
          />

          {/* Chevron - shows on hover or when expanded */}
          <ChevronRight
            className={cn(
              "text-muted-foreground/50 absolute top-0 left-0 h-3.5 w-3.5 transition-[transform,opacity] duration-150 ease-out",
              isExpanded && "rotate-90",
              isExpanded ? "opacity-100" : "opacity-0 group-hover:opacity-100"
            )}
            aria-hidden="true"
          />
        </div>

        {/* Label - font-medium for hierarchy */}
        <span className="text-foreground/70 flex-shrink-0 font-medium">Thinking</span>

        {/* Preview when collapsed only */}
        {!isExpanded && (
          <span
            className={cn(
              "text-muted-foreground/70 truncate font-mono text-xs",
              isStreaming && "tool-loading-shimmer"
            )}
          >
            {preview}
          </span>
        )}
      </button>

      {/* Expanded content — AnimatePresence for enter/exit opacity fade. */}
      <AnimatePresence>
        {isExpanded && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 0.7 }}
            exit={{ opacity: 0 }}
            transition={expandTransition}
            className="text-muted-foreground mt-0.5 ml-6 text-sm"
          >
            <ChatMarkdown>{block.thinking}</ChatMarkdown>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
