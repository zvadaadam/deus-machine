/**
 * Shared helpers for MCP tool renderers.
 *
 * Used by BrowserToolRenderers and WorkspaceToolRenderers to avoid
 * duplicating the common extractText / OutputBlock / ICON_CLS patterns.
 */

import { cn } from "@/shared/lib/utils";

/** Extract text from MCP content blocks */
export function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((b: any) => b?.type === "text")
      .map((b: any) => b.text)
      .join("\n");
  }
  return JSON.stringify(content, null, 2);
}

/** Scrollable pre block for snapshot/log output.
 * Error styling is handled by BaseToolRenderer (X icon swap) — OutputBlock
 * uses uniform styling regardless of error state. */
export function OutputBlock({ children }: { children: React.ReactNode; isError?: boolean }) {
  return (
    <pre
      className={cn(
        "overflow-x-auto rounded-lg p-3 font-mono text-xs whitespace-pre-wrap",
        "chat-scroll-contain max-h-96 overflow-y-auto border",
        "bg-muted/50 text-foreground border-border/60"
      )}
    >
      {children}
    </pre>
  );
}

export const ICON_CLS = "text-muted-foreground/70 h-3.5 w-3.5";
