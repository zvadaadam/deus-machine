/**
 * Thinking Block
 *
 * Displays a completed reasoning trace.
 * Collapsed by default — shows a compact "Thought" header.
 * Click to expand and see the full reasoning as markdown.
 */

import type { ReasoningPart } from "@shared/messages/types";
import { useState } from "react";
import { Brain, ChevronRight } from "lucide-react";
import { AnimatePresence, motion } from "framer-motion";
import { cn } from "@/shared/lib/utils";

import { ChatMarkdown } from "@/components/markdown";

interface ThinkingBlockProps {
  part: ReasoningPart;
  /** Duration in seconds the model spent thinking. */
  durationSec?: number;
}

const expandTransition = { duration: 0.15, ease: [0.165, 0.84, 0.44, 1] as const };
const hoverEase = "ease-[cubic-bezier(.165,.84,.44,1)]";

export function ThinkingBlock({ part, durationSec }: ThinkingBlockProps) {
  const [isExpanded, setIsExpanded] = useState(false);

  const durationLabel = durationSec != null && durationSec > 0 ? `for ${durationSec}s` : undefined;

  return (
    <div className="flex flex-col gap-0.5">
      {/* Header — collapsed: Brain icon, "Thought for Xs", chevron on hover */}
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
          `opacity-70 transition-opacity duration-150 ${hoverEase} hover:opacity-100`,
          "focus-visible:ring-ring focus-visible:ring-2 focus-visible:outline-none"
        )}
      >
        {/* Icon container — fixed width to prevent layout shift */}
        <div className="relative h-3.5 w-3.5 flex-shrink-0">
          <Brain
            className={cn(
              `text-muted-foreground/70 absolute top-0 left-0 h-3.5 w-3.5 transition-opacity duration-150 ${hoverEase}`,
              isExpanded ? "opacity-0" : "opacity-100 group-hover:opacity-0"
            )}
          />
          <ChevronRight
            className={cn(
              `text-muted-foreground/50 absolute top-0 left-0 h-3.5 w-3.5 transition-[transform,opacity] duration-150 ${hoverEase}`,
              isExpanded && "rotate-90",
              isExpanded ? "opacity-100" : "opacity-0 group-hover:opacity-100"
            )}
            aria-hidden="true"
          />
        </div>

        {/* Label — past tense */}
        <span className="text-foreground/70 flex-shrink-0 font-medium">Thought</span>

        {/* Duration */}
        {durationLabel && (
          <span className="text-muted-foreground/50 flex-shrink-0 text-sm font-normal tabular-nums">
            {durationLabel}
          </span>
        )}
      </button>

      {/* Expanded content */}
      <AnimatePresence initial={false}>
        {isExpanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={expandTransition}
            style={{ overflow: "hidden" }}
            className="mt-0.5 px-2 text-sm opacity-50"
          >
            <ChatMarkdown className="thinking-markdown flex flex-col gap-1.5">
              {part.text}
            </ChatMarkdown>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
