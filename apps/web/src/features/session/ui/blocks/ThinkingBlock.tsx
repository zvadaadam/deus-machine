/**
 * Thinking Block
 *
 * Displays a completed reasoning trace.
 * Collapsed by default — shows a compact "Thought" header.
 * Click to expand and see the full reasoning as markdown.
 */

import { Collapse } from "@/components/ui/collapse";
import type { ReasoningPart } from "@shared/protocol-types";
import { useTranscriptFold } from "../../lib/openChat";
import { Brain, ChevronRight } from "lucide-react";
import { AnimatePresence } from "framer-motion";
import { cn } from "@/shared/lib/utils";

import { ChatMarkdown } from "@/components/markdown";

interface ThinkingBlockProps {
  part: ReasoningPart;
  /** Duration in seconds the model spent thinking. */
  durationSec?: number;
}

export function ThinkingBlock({ part, durationSec }: ThinkingBlockProps) {
  const [isExpanded = false, toggle] = useTranscriptFold(part.sessionId, "thought", part.id);

  const durationLabel = durationSec != null && durationSec > 0 ? `for ${durationSec}s` : undefined;

  // Withheld reasoning (Fable-class default, redacted blocks): the thought
  // happened but no text arrived — a static summary line beats an expandable
  // empty body. estimatedThinkingTokens is the placeholder size when present.
  if (!part.text.trim()) {
    const estTokens = part.providerMetadata?.estimatedThinkingTokens;
    const sizeLabel =
      typeof estTokens === "number" && estTokens > 0 ? `~${estTokens} tokens` : undefined;
    const detail = [durationLabel, sizeLabel].filter(Boolean).join(" · ");
    return (
      <div className="flex items-center gap-2 px-2 py-1.5 text-sm opacity-70">
        <Brain className="text-muted-foreground/70 h-3.5 w-3.5 flex-shrink-0" />
        <span className="text-foreground/70 flex-shrink-0 font-medium">Thought</span>
        {detail && (
          <span className="text-muted-foreground/50 flex-shrink-0 text-sm font-normal tabular-nums">
            {detail}
          </span>
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-0.5">
      {/* Header — collapsed: Brain icon, "Thought for Xs", chevron on hover */}
      <button
        type="button"
        onClick={toggle}
        aria-expanded={isExpanded}
        aria-label="Toggle thinking details"
        className={cn(
          "group flex items-center gap-2 px-2 py-1.5 text-sm",
          "w-full cursor-pointer text-left",
          "opacity-70 transition-opacity hover:opacity-100",
          "focus-visible:ring-ring focus-visible:ring-2 focus-visible:outline-none"
        )}
      >
        {/* Icon container — fixed width to prevent layout shift */}
        <div className="relative h-3.5 w-3.5 flex-shrink-0">
          <Brain
            className={cn(
              "text-muted-foreground/70 absolute top-0 left-0 h-3.5 w-3.5 transition-opacity",
              isExpanded ? "opacity-0" : "opacity-100 group-hover:opacity-0"
            )}
          />
          <ChevronRight
            className={cn(
              "text-muted-foreground/50 absolute top-0 left-0 h-3.5 w-3.5 transition-[rotate,opacity]",
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
          <Collapse className="mt-0.5 px-2 text-sm opacity-50">
            <ChatMarkdown className="thinking-markdown flex flex-col gap-1.5">
              {part.text}
            </ChatMarkdown>
          </Collapse>
        )}
      </AnimatePresence>
    </div>
  );
}
