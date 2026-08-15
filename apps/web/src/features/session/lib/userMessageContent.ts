/**
 * What a user bubble renders.
 *
 * Two producers write a user message, and both speak engine `Part`s: the
 * engine's user echo, and the composer's optimistic bubble, which builds the
 * same shapes locally (see `optimisticMessage.ts`) so there is one render path,
 * not one per producer.
 *
 * They collapse to the render shape here: ordered text runs plus ready-to-use
 * image `src` values. Inline XML (`<inspect>`, `<diff-comment>`) stays
 * untouched inside the text — TextBlock parses it downstream.
 */

import type { Part, UnknownPart } from "@shared/protocol-types";

export interface UserMessageContent {
  /** Ready-to-use `<img src>` values — data: URLs or remote URLs. */
  images: string[];
  /** Text runs in stream order. */
  texts: string[];
}

const EMPTY: UserMessageContent = { images: [], texts: [] };

export function readUserMessageContent(message: {
  parts?: Array<Part | UnknownPart>;
}): UserMessageContent {
  const parts = message.parts;
  if (parts && parts.length > 0) return fromEngineParts(parts);
  return EMPTY;
}

/** The engine's echo — the canonical Part vocabulary, no translation needed. */
function fromEngineParts(parts: Array<Part | UnknownPart>): UserMessageContent {
  const out: UserMessageContent = { images: [], texts: [] };
  for (const part of parts) {
    // Law 6: an unknown part is preserved in the stream but has no render.
    if ("raw" in part) continue;
    if (part.type === "text") {
      out.texts.push(part.text);
      continue;
    }
    if (part.type === "image") {
      const src = imageSrc(part.data, part.url, part.mimeType);
      if (src) out.images.push(src);
    }
  }
  return out;
}

function imageSrc(data: unknown, url: unknown, mimeType: unknown): string | null {
  if (typeof data === "string" && data.length > 0) {
    const type = typeof mimeType === "string" && mimeType.length > 0 ? mimeType : "image/png";
    return `data:${type};base64,${data}`;
  }
  if (typeof url === "string" && url.length > 0) return url;
  return null;
}
