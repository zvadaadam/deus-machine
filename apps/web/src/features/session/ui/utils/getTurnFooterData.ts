import type { Message } from "@/shared/types";
import type { TokenUsage } from "@shared/protocol-types";
import type { ContentBlock } from "@/features/session/types";

export interface TurnFooterData {
  copyText: string | null;
  durationMs: number | null;
  /** Billed tokens for the turn (turn.ended), when the harness reported them. */
  tokens: TokenUsage | null;
  /** USD for the turn, when reported. */
  cost: number | null;
}

export function getTurnFooterData(messages: Message[], startedAt?: string | null): TurnFooterData {
  const accounting = getTurnAccounting(messages);
  return {
    copyText: getLastTextContent(messages),
    durationMs: getTurnDurationMs(messages, startedAt),
    ...accounting,
  };
}

/**
 * The turn's billing totals, written at turn.ended onto its last top-level
 * assistant message. Before the protocol unification these were computed
 * end-to-end and then dropped on the floor.
 */
function getTurnAccounting(messages: Message[]): {
  tokens: TokenUsage | null;
  cost: number | null;
} {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message.tokens == null && message.cost == null) continue;
    let tokens: TokenUsage | null = null;
    if (message.tokens != null) {
      try {
        tokens = JSON.parse(message.tokens) as TokenUsage;
      } catch {
        tokens = null;
      }
    }
    return { tokens, cost: message.cost ?? null };
  }
  return { tokens: null, cost: null };
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

  // Legacy rows only: engine-written messages render from their parts.
  return message.content == null ? null : extractTextFromContent(message.content);
}

function extractTextFromParts(parts?: Message["parts"]): string | null {
  if (!parts?.length) return null;

  // Parts are already in stream order — they carry no ordering field.
  const text = parts
    .flatMap((part) => (!("raw" in part) && part.type === "text" ? [part.text.trim()] : []))
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
      if ("raw" in part) continue;

      // Protocol times are epoch ms; the message columns stay ISO strings.
      if (part.type === "reasoning") {
        latestEndMs = maxEpochMs(latestEndMs, part.time?.end);
        continue;
      }

      if (part.type === "tool" && part.state.status !== "pending") {
        const time = part.state.time;
        latestEndMs = maxEpochMs(latestEndMs, "end" in time ? time.end : undefined);
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

/** Fold an epoch-ms stamp into the running max. */
function maxEpochMs(current: number | null, value?: number): number | null {
  if (value === undefined || !Number.isFinite(value)) return current;
  return current == null ? value : Math.max(current, value);
}

function parseTimestamp(value?: string | null): number | null {
  if (!value) return null;

  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}
