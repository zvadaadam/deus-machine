/**
 * Tool Error Component
 *
 * Shared component for displaying tool execution errors consistently.
 * Follows Cursor's "errors whisper" philosophy — errors are common during
 * agent work (build failures, lint errors, retries). Aggressive red styling
 * creates unnecessary visual noise. Keep it subtle: a faint tint, a small
 * icon, and muted text. The error is distinguishable but not alarming.
 */

import { cn } from "@/shared/lib/utils";
import { AlertCircle } from "lucide-react";

interface ToolErrorProps {
  content: string | object;
  className?: string;
}

export function ToolError({ content, className }: ToolErrorProps) {
  const errorText = typeof content === "object" ? JSON.stringify(content, null, 2) : content;

  return (
    <div
      className={cn(
        "rounded-md px-3 py-2",
        "bg-destructive/5 border-destructive/15 border",
        "flex gap-2",
        className
      )}
    >
      <AlertCircle className="text-destructive/60 mt-0.5 h-3.5 w-3.5 flex-shrink-0" />
      <pre className="text-foreground/70 m-0 flex-1 font-mono text-xs leading-relaxed break-words whitespace-pre-wrap">
        {errorText}
      </pre>
    </div>
  );
}
