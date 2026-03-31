/**
 * Tool Result Block (Legacy)
 *
 * Renders standalone tool execution results.
 * Uniform styling for success and error — the error signal lives
 * on the collapsed tool row (X icon), not in the result content.
 */

import type { ToolResultBlock as ToolResultBlockType } from "@/shared/types";

import { cn } from "@/shared/lib/utils";

interface ToolResultBlockProps {
  block: ToolResultBlockType;
}

export function ToolResultBlock({ block }: ToolResultBlockProps) {
  if (!block) {
    return null;
  }

  const isError = block.is_error;
  let content = block.content || "";

  // Stringify objects/arrays
  if (typeof content === "object") {
    content = JSON.stringify(content, null, 2);
  }

  // Don't render empty results
  if (!content || content.toString().trim() === "") {
    return null;
  }

  return (
    <div
      className={cn(
        "border-border/40 rounded-md border bg-transparent backdrop-blur-sm",
        "mt-1 text-sm",
        "border-l-border border-l-2"
      )}
    >
      {/* Header */}
      <div className="text-foreground flex items-center gap-1.5 text-sm font-semibold">
        <strong className="text-foreground/70 text-xs font-medium">
          {isError ? "Error" : "Result"}
        </strong>
      </div>

      {/* Content */}
      <pre
        role="region"
        aria-label={isError ? "Tool error" : "Tool result"}
        className={cn(
          "overflow-x-auto rounded p-2 font-mono text-sm leading-relaxed break-words whitespace-pre-wrap",
          "chat-scroll-contain max-h-[150px] overflow-y-auto",
          "bg-muted/40 text-foreground"
        )}
      >
        {content}
      </pre>
    </div>
  );
}
