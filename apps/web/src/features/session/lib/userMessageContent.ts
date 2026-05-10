import type { ContentBlock } from "../types";
import { isTextBlock } from "../types";

/**
 * User messages are persisted as JSON-stringified content blocks, but older
 * rows and optimistic fallbacks may still be plain text. Return the text a
 * user can edit/resend while ignoring image-only blocks.
 */
export function extractTextFromUserMessageContent(content: string): string {
  try {
    const parsed = JSON.parse(content);

    if (typeof parsed === "string") return parsed;

    if (Array.isArray(parsed)) {
      return parsed
        .map((block: ContentBlock | string) => {
          if (typeof block === "string") return block;
          if (isTextBlock(block)) return block.text;
          return "";
        })
        .filter(Boolean)
        .join("\n");
    }

    return content;
  } catch {
    return content;
  }
}
