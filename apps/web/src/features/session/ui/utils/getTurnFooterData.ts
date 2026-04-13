import type { Message } from "@/shared/types";
import type { ContentBlock } from "@/features/session/types";

export interface TurnFooterData {
  copyText: string | null;
  durationMs: number | null;
}

export function getTurnFooterData(messages: Message[], startedAt?: string | null): TurnFooterData {
  return {
    copyText: getLastTextContent(messages),
    durationMs: getTurnDurationMs(messages, startedAt),
  };
}

function getLastTextContent(messages: Message[]): string | null {
  for (let index = messages.length - 1; index >= 0; index--) {
    const text = extractTextFromMessage(messages[index]);
    if (text) return text;
  }

  return null;
}

function extractTextFromMessage(message: Message): string | null {
  const fromParts = extractTextFromParts(message.parts);
  if (fromParts) return fromParts;

  return extractTextFromContent(message.content);
}

function extractTextFromParts(parts?: Message["parts"]): string | null {
  if (!parts?.length) return null;

  const text = [...parts]
    .sort((first, second) => (first.partIndex ?? 0) - (second.partIndex ?? 0))
    .flatMap((part) => (part.type === "TEXT" ? [part.text.trim()] : []))
    .filter(Boolean)
    .join("\n")
    .trim();

  return text.length > 0 ? text : null;
}

function extractTextFromContent(content: string): string | null {
  if (!content) return null;

  try {
    const parsed = JSON.parse(content) as unknown;
    const blocks = getContentBlocks(parsed);
    const text = blocks
      .flatMap((block) => {
        if (typeof block === "string") return [block.trim()];
        if (isTextBlock(block)) return [block.text.trim()];
        return [];
      })
      .filter(Boolean)
      .join("\n")
      .trim();

    return text.length > 0 ? text : null;
  } catch {
    const trimmed = content.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
}

function getContentBlocks(parsed: unknown): Array<ContentBlock | string> {
  if (typeof parsed === "string") return [parsed];
  if (Array.isArray(parsed)) return parsed as Array<ContentBlock | string>;

  if (
    parsed &&
    typeof parsed === "object" &&
    "blocks" in parsed &&
    Array.isArray((parsed as { blocks?: unknown }).blocks)
  ) {
    return (parsed as { blocks: Array<ContentBlock | string> }).blocks;
  }

  return [];
}

function isTextBlock(block: unknown): block is Extract<ContentBlock, { type: "text" }> {
  return typeof block === "object" && block !== null && "type" in block && block.type === "text";
}

function getTurnDurationMs(messages: Message[], startedAt?: string | null): number | null {
  const startMs = parseTimestamp(startedAt);
  if (startMs == null) return null;

  let latestEndMs: number | null = null;

  for (const message of messages) {
    latestEndMs = getLatestTimestamp(latestEndMs, message.sent_at, message.cancelled_at);

    for (const part of message.parts ?? []) {
      if (part.type === "REASONING") {
        latestEndMs = getLatestTimestamp(latestEndMs, part.time?.end);
        continue;
      }

      if (
        part.type === "TOOL" &&
        (part.state.status === "COMPLETED" || part.state.status === "ERROR")
      ) {
        latestEndMs = getLatestTimestamp(latestEndMs, part.state.time.end);
      }
    }
  }

  if (latestEndMs == null || latestEndMs < startMs) return null;

  return latestEndMs - startMs;
}

function getLatestTimestamp(
  current: number | null,
  ...values: Array<string | null | undefined>
): number | null {
  let latest = current;

  for (const value of values) {
    const timestamp = parseTimestamp(value);
    if (timestamp == null) continue;
    latest = latest == null ? timestamp : Math.max(latest, timestamp);
  }

  return latest;
}

function parseTimestamp(value?: string | null): number | null {
  if (!value) return null;

  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}
