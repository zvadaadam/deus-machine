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

type ImageResultBlock = {
  type: "image";
  data?: string;
  mimeType?: string;
  source?: {
    data?: string;
    media_type?: string;
  };
};

function isImageResultBlock(block: unknown): block is ImageResultBlock {
  if (!block || typeof block !== "object") return false;
  return (block as Record<string, unknown>).type === "image";
}

export function extractImage(content: unknown): { data: string; mediaType: string } | null {
  if (!Array.isArray(content)) return null;

  // Iterate through all image blocks — don't stop at the first one if its
  // payload is incomplete, since later valid images would be skipped.
  for (const block of content) {
    if (!isImageResultBlock(block)) continue;

    if (typeof block.data === "string") {
      return { data: block.data, mediaType: block.mimeType || "image/jpeg" };
    }
    if (typeof block.source?.data === "string") {
      return { data: block.source.data, mediaType: block.source.media_type || "image/jpeg" };
    }
  }

  return null;
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
