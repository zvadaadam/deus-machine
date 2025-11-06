/**
 * Text Block
 *
 * Renders text content blocks from messages with semantic weight.
 * - Assistant messages: Rendered as markdown (secure, CSS-highlighted for speed)
 * - User messages: Rendered as plain text (user input)
 *
 * Weight variants:
 * - 'muted': Transitional text between actions (13px, opacity 0.7)
 * - 'normal': Regular text (14px, normal opacity)
 * - 'hero': Final summary text (15px, prominent, with top border)
 *
 * Now uses ChatMarkdown component for secure, beautiful rendering with:
 * - CSS-based syntax highlighting (instant rendering)
 * - Sanitized HTML (security)
 * - Copy buttons on code blocks
 * - Dense IDE-friendly typography
 */

import type { TextBlock as TextBlockType, MessageRole } from "@/shared/types";
import { chatTheme } from "../theme";
import { ChatMarkdown } from "@/components/markdown";
import { cn } from "@/shared/lib/utils";

export type TextWeight = "muted" | "normal" | "hero";

interface TextBlockProps {
  block: TextBlockType | string;
  role?: MessageRole;
  weight?: TextWeight;
}

export function TextBlock({ block, role = "assistant", weight = "normal" }: TextBlockProps) {
  // Handle both TextBlock objects and plain strings
  const text = typeof block === "string" ? block : block.text;

  if (!text || text.trim() === "") {
    return null;
  }

  // Weight-based styling - applied to container
  const weightStyles = {
    muted: "text-sm leading-[1.5] text-muted-foreground opacity-70 py-1",
    normal: "", // Normal uses ChatMarkdown defaults (14px)
    hero: "text-sm leading-[1.65] py-3 mt-2 border-t border-border/20",
  };

  // User messages: plain text (preserve newlines)
  // Maximum readability - theme-based bright text color
  // Color applied LAST to ensure proper CSS specificity (no !important needed)
  if (role === "user") {
    // Remove text color from weightStyles for user messages to avoid conflicts
    const userWeightStyle =
      weight === "muted"
        ? "text-sm leading-[1.5] opacity-70 py-1" // Removed text-muted-foreground
        : weightStyles[weight];

    return (
      <p
        className={cn(
          "whitespace-pre-wrap",
          "text-sm leading-[1.5]",
          chatTheme.message.user.text,
          userWeightStyle,
          // Theme color applied last - proper CSS specificity, extensible
          chatTheme.message.user.textColor
        )}
      >
        {text}
      </p>
    );
  }

  // Assistant messages: markdown with Shiki highlighting
  return (
    <ChatMarkdown className={cn(chatTheme.blocks.text.container, weightStyles[weight])}>
      {text}
    </ChatMarkdown>
  );
}
