/**
 * What a user bubble renders.
 *
 * Three producers write a user message, and the bubble must render all three
 * without branching in the component:
 *
 *   1. `parts`   — the engine's user echo. Authoritative for every new row.
 *   2. `content` — canonical `PartInput[]` JSON, written by the composer and
 *                  mirrored into the optimistic bubble before the echo lands.
 *   3. `content` — LEGACY Anthropic content blocks (`{type:"image",source:…}`),
 *                  held by rows written before the composer spoke PartInput.
 *
 * All three collapse to the same render shape here: ordered text runs plus
 * ready-to-use image `src` values. Inline XML (`<inspect>`, `<diff-comment>`)
 * stays untouched inside the text — TextBlock parses it downstream.
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
  content?: string | null;
}): UserMessageContent {
  const parts = message.parts;
  if (parts && parts.length > 0) return fromEngineParts(parts);
  return fromContentJson(message.content ?? null);
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

/** `messages.content` — canonical PartInput JSON, or the legacy block array. */
function fromContentJson(content: string | null): UserMessageContent {
  if (content == null) return EMPTY;

  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return { images: [], texts: [content] };
  }

  if (typeof parsed === "string") return { images: [], texts: [parsed] };
  if (!Array.isArray(parsed)) return { images: [], texts: [content] };

  const out: UserMessageContent = { images: [], texts: [] };
  for (const entry of parsed) {
    if (typeof entry === "string") {
      out.texts.push(entry);
      continue;
    }
    if (!entry || typeof entry !== "object") continue;

    const block = entry as Record<string, unknown>;
    if (block.type === "text" && typeof block.text === "string") {
      out.texts.push(block.text);
      continue;
    }
    if (block.type !== "image") continue;

    // LEGACY: Anthropic's nested `source`. Canonical: flat data/url + mimeType.
    const source = block.source as Record<string, unknown> | undefined;
    const src = source
      ? imageSrc(source.data, source.url, source.media_type)
      : imageSrc(block.data, block.url, block.mimeType);
    if (src) out.images.push(src);
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
