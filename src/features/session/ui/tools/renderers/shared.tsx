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

/** Scrollable pre block for snapshot/log output */
export function OutputBlock({ children, isError }: { children: React.ReactNode; isError?: boolean }) {
  return (
    <pre
      className={cn(
        "overflow-x-auto rounded-lg p-3 font-mono text-xs whitespace-pre-wrap",
        "max-h-[400px] overflow-y-auto border",
        isError
          ? "bg-destructive/15 text-destructive-foreground border-destructive/30"
          : "bg-muted/50 text-foreground border-border/60"
      )}
    >
      {children}
    </pre>
  );
}

export const ICON_CLS = "text-muted-foreground/70 h-4 w-4";
