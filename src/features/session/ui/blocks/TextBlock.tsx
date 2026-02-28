/**
 * Text Block
 *
 * Renders text content blocks from messages with semantic weight.
 * - Assistant messages: Rendered as markdown (secure, CSS-highlighted for speed)
 * - User messages: Rendered as plain text with <inspect> pills (user input)
 *
 * Weight variants:
 * - 'muted': Transitional text between actions (60% opacity)
 * - 'normal': Final summary text (100% opacity - stands out)
 *
 * Visual hierarchy: Only the last text block in completed assistant turns shows as white (normal).
 * All other text remains subtle (muted) to emphasize WHAT was done over HOW.
 *
 * Uses ChatMarkdown component for secure, beautiful rendering with:
 * - CSS-based syntax highlighting (instant rendering)
 * - Sanitized HTML (security)
 * - Copy buttons on code blocks
 * - Dense IDE-friendly typography
 */

import { useMemo } from "react";
import type { TextBlock as TextBlockType, MessageRole } from "@/shared/types";

import { ChatMarkdown } from "@/components/markdown";
import { cn } from "@/shared/lib/utils";
import { parseInspectTags } from "../../lib/parseInspectTags";
import { InspectElementPill } from "../InspectElementPill";

export type TextWeight = "muted" | "normal";

interface TextBlockProps {
  block: TextBlockType | string;
  role?: MessageRole;
  weight?: TextWeight;
}

export function TextBlock({ block, role = "assistant", weight = "normal" }: TextBlockProps) {
  // Handle both TextBlock objects and plain strings
  const text = typeof block === "string" ? block : block.text;

  // Parse <inspect> tags for user messages (memoized, short-circuits on no match)
  const inspectSegments = useMemo(
    () => (role === "user" && text?.includes("<inspect") ? parseInspectTags(text) : []),
    [role, text]
  );

  if (!text || text.trim() === "") {
    return null;
  }

  // Weight-based styling
  // Note: For assistant messages, we use opacity wrapper (line 77) instead of text color
  // because .markdown-content in global.css has explicit colors that override utilities

  // User messages: plain text with inline <inspect> pills
  if (role === "user") {
    // If <inspect> tags were found, render mixed text + pills
    if (inspectSegments.length > 0) {
      return (
        <p className={cn("text-base whitespace-pre-wrap", "font-normal", "text-foreground")}>
          {inspectSegments.map((segment, i) =>
            typeof segment === "string" ? (
              <span key={i}>{segment}</span>
            ) : (
              <InspectElementPill key={`inspect-${i}`} element={segment} />
            )
          )}
        </p>
      );
    }

    // No <inspect> tags: plain text
    return (
      <p className={cn("text-base whitespace-pre-wrap", "font-normal", "text-foreground")}>
        {text}
      </p>
    );
  }

  // Assistant messages: markdown with Shiki highlighting
  // Wrap in div for weight control (opacity) since .markdown-content has explicit color
  return (
    <div className={weight === "muted" ? "opacity-60" : ""}>
      <ChatMarkdown className="flex flex-col gap-1.5 px-2 py-1.5">{text}</ChatMarkdown>
    </div>
  );
}
