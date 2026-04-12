/**
 * Streaming Reasoning Block
 *
 * Shows reasoning text visibly during active streaming, instead of
 * collapsing it behind a ThinkingBlock header. This lets users see
 * what the model is thinking in real-time.
 *
 * Displays the last ~4 lines of reasoning text with a subtle style
 * (muted, italic, brain icon). When the reasoning part transitions
 * to DONE, PartsRenderer switches to the collapsed ThinkingBlock.
 */

import { useMemo } from "react";
import { Brain } from "lucide-react";
import { cn } from "@/shared/lib/utils";

interface StreamingReasoningBlockProps {
  text: string;
}

/** Max visible lines during streaming */
const MAX_VISIBLE_LINES = 4;

export function StreamingReasoningBlock({ text }: StreamingReasoningBlockProps) {
  // Show only the tail of reasoning text (last N lines)
  const visibleText = useMemo(() => {
    if (!text) return "";
    const lines = text.split("\n");
    if (lines.length <= MAX_VISIBLE_LINES) return text;
    return lines.slice(-MAX_VISIBLE_LINES).join("\n");
  }, [text]);

  if (!visibleText.trim()) return null;

  return (
    <div
      className={cn(
        "flex items-start gap-2 px-2 py-1.5",
        "text-muted-foreground/60 text-sm italic",
        "tool-loading-shimmer"
      )}
    >
      <Brain className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 opacity-50" />
      <p className="min-w-0 font-mono text-xs leading-relaxed whitespace-pre-wrap">{visibleText}</p>
    </div>
  );
}
