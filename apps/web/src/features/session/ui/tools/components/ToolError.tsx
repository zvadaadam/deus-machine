/**
 * Tool Error Component
 *
 * Displays tool execution error content inline with tool output.
 * No box, no icon, no background — just quiet monospace text that
 * matches the surrounding tool content typography (12px mono, same as diffs).
 * The X icon on the collapsed row already signals the error; this is just the details.
 */

import { cn } from "@/shared/lib/utils";

interface ToolErrorProps {
  content: string | object;
  className?: string;
}

/** Strip XML wrapper tags like <tool_use_error>...</tool_use_error> from error content */
function cleanErrorText(raw: string): string {
  return raw.replace(/<\/?tool_use_error>/g, "").trim();
}

export function ToolError({ content, className }: ToolErrorProps) {
  const raw = typeof content === "object" ? JSON.stringify(content, null, 2) : content;
  const errorText = cleanErrorText(raw);

  return (
    <div className={cn("chat-scroll-contain max-h-24 overflow-y-auto", className)}>
      <pre className="text-muted-foreground m-0 font-mono text-xs leading-relaxed break-words whitespace-pre-wrap">
        {errorText}
      </pre>
    </div>
  );
}
