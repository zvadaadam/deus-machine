// What a Browser Screenshot card shows of its result.

/** Claude Code's (2.1.327) block naming where it saved an MCP tool's picture: one block, alone. */
const SAVED_IMAGE_MARKER = /^\[Image: source: [^\]\n]*\]$/;

/**
 * A screenshot's result without Claude Code's block saying where it saved the
 * picture, which the card would show in place of the tool's own words. Only
 * a text block that is exactly that, beside an image: any other text stays.
 */
export function screenshotWords(content: unknown, hasImage: boolean): unknown {
  if (!hasImage || !Array.isArray(content)) return content;
  return content.filter(
    (block) =>
      !(
        block &&
        typeof block === "object" &&
        (block as { type?: unknown }).type === "text" &&
        typeof (block as { text?: unknown }).text === "string" &&
        SAVED_IMAGE_MARKER.test((block as { text: string }).text.trim())
      )
  );
}
