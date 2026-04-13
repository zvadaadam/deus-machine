import type { ReactNode } from "react";
import { cn } from "@/shared/lib/utils";

type TextResultBlock = {
  type: "text";
  text: string;
};

function isTextResultBlock(block: unknown): block is TextResultBlock {
  if (!block || typeof block !== "object") return false;
  const record = block as Record<string, unknown>;
  return record.type === "text" && typeof record.text === "string";
}

export function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter(isTextResultBlock)
      .map((block) => block.text)
      .join("\n");
  }
  return JSON.stringify(content, null, 2);
}

export function OutputBlock({ children }: { children: ReactNode }) {
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
