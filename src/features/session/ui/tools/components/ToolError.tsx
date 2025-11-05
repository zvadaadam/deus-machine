/**
 * Tool Error Component
 *
 * Shared component for displaying tool execution errors consistently.
 * Used by all tool renderers to show error messages in a standardized format.
 */

import { cn } from "@/shared/lib/utils";
import { AlertCircle } from "lucide-react";

interface ToolErrorProps {
  content: string | object;
  className?: string;
}

export function ToolError({ content, className }: ToolErrorProps) {
  // Stringify objects for display
  const errorText = typeof content === "object" ? JSON.stringify(content, null, 2) : content;

  return (
    <div
      className={cn(
        "mx-2 mb-2 rounded p-2",
        "bg-destructive/10 border-destructive/30 border",
        "flex gap-2",
        className
      )}
    >
      <AlertCircle className="text-destructive mt-0.5 h-4 w-4 flex-shrink-0" />
      <pre className="text-destructive-foreground m-0 flex-1 font-mono text-xs break-words whitespace-pre-wrap">
        {errorText}
      </pre>
    </div>
  );
}
