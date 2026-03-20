/**
 * Parse message content from the database into typed content blocks.
 *
 * The DB stores content in exactly 3 formats:
 *   1. Plain text string (user messages from backend POST)
 *   2. JSON.stringify(ContentBlock[]) — assistant messages, tool results
 *   3. JSON.stringify({ message: { stop_reason }, blocks: ContentBlock[] }) — cancelled envelope
 *
 * Legacy rows may have envelope format for any stop_reason (not just "cancelled").
 */

import type { ContentBlock } from "../types";

/**
 * Parse a raw `content` column value into typed content blocks.
 *
 * Returns ContentBlock[] for JSON array or envelope formats,
 * wraps plain text in [{ type: "text", text }] on parse failure.
 */
export function parseContentBlocks(content: string): (ContentBlock | string)[] | string {
  try {
    const parsed = JSON.parse(content);

    // Format 2: ContentBlock[] (most common — assistant messages, tool results)
    if (Array.isArray(parsed)) {
      return parsed as (ContentBlock | string)[];
    }

    // Format 3: Envelope — { message: { stop_reason }, blocks: [...] }
    // Written for cancelled messages; legacy rows may have other stop_reasons.
    if (
      parsed !== null &&
      typeof parsed === "object" &&
      "message" in parsed &&
      "blocks" in parsed &&
      Array.isArray(parsed.blocks)
    ) {
      return parsed.blocks as (ContentBlock | string)[];
    }

    // JSON-encoded string (e.g. JSON.stringify("hello") → '"hello"')
    if (typeof parsed === "string") {
      return parsed;
    }

    // Unexpected shape — wrap as text so it renders safely
    return [{ type: "text" as const, text: JSON.stringify(parsed) }];
  } catch {
    // Format 1: Plain text (not valid JSON) — wrap in TextBlock
    return [{ type: "text" as const, text: content }];
  }
}

/**
 * Check if a raw message content string represents a cancelled response.
 *
 * The sidecar writes cancelled messages with envelope:
 *   { message: { stop_reason: "cancelled" }, blocks: [...] }
 */
export function isCancelledMessage(content: string): boolean {
  try {
    const parsed = JSON.parse(content);
    return (
      parsed !== null &&
      typeof parsed === "object" &&
      !Array.isArray(parsed) &&
      Array.isArray(parsed.blocks) &&
      parsed.message?.stop_reason === "cancelled"
    );
  } catch {
    return false;
  }
}
