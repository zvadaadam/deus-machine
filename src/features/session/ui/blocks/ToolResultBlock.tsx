/**
 * Tool Result Block
 *
 * Renders tool execution results.
 * Shows success/error state with appropriate styling.
 */

import type { ToolResultBlock as ToolResultBlockType } from "@/shared/types";
import { chatTheme } from "../theme";
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
        chatTheme.blocks.tool.container,
        "mt-1 text-sm",
        isError ? chatTheme.blocks.tool.borderLeft.error : chatTheme.blocks.tool.borderLeft.success
      )}
    >
      {/* Header */}
      <div className={chatTheme.blocks.tool.header}>
        <strong
          className={cn(
            "text-xs font-medium",
            isError ? "text-destructive/70" : "text-foreground/70"
          )}
        >
          {isError ? "Error" : "Result"}
        </strong>
      </div>

      {/* Content */}
      <pre
        role="region"
        aria-label={isError ? "Tool error" : "Tool result"}
        className={cn(
          chatTheme.blocks.tool.content,
          "scrollbar-vibrancy max-h-[150px] overflow-y-auto",
          isError ? "bg-destructive/5 text-foreground/70" : "bg-sidebar-accent/40 text-foreground"
        )}
      >
        {content}
      </pre>
    </div>
  );
}
