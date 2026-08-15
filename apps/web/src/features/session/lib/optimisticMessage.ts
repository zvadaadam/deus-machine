/**
 * The composer's optimistic user bubble.
 *
 * A send mints its own `turnId` (see `useSendMessage`) and hands the SAME id to
 * the backend command and to this row. That id is the correlation key the
 * engine's user echo arrives with (`message.started{role:"user", turnId}`), so
 * the echo replaces this row in place instead of appending a second bubble.
 *
 * The row carries engine `Part`s: the bubble renders through exactly the same
 * path as the echo it is standing in for (`readUserMessageContent` → parts).
 *
 * Everything local is id-prefixed. The prefix is a marker, never a licence to
 * bulk-delete: a local row is dropped when ITS echo arrives (matched by
 * `turn_id`) and at no other time, so a rejected send leaves the typed message
 * on screen instead of silently evaporating on the next unrelated delta.
 */

import type { QueryClient } from "@tanstack/react-query";
import { queryKeys } from "@/shared/api/queryKeys";
import type { PaginatedMessages } from "../api/session.service";
import type { Message } from "../types";
import type { Part, PartInput, UnknownPart } from "@shared/protocol-types";

const LOCAL_PREFIX = "optimistic-";

/** True for the composer's own rows/parts — never for anything the engine sent. */
export function isLocalId(id: string): boolean {
  return id.startsWith(LOCAL_PREFIX);
}

export function isLocalMessage(message: { id: string }): boolean {
  return isLocalId(message.id);
}

export function isLocalPart(part: Part | UnknownPart): boolean {
  return isLocalId(part.id);
}

/** The local row id for a send — derived from its turn id, so it is findable. */
export function optimisticMessageId(turnId: string): string {
  return `${LOCAL_PREFIX}${turnId}`;
}

/**
 * The bubble the composer shows while the send is in flight.
 *
 * `seq` is MAX_SAFE_INTEGER so nothing mistakes it for a real cursor position;
 * the chat renders in array order and the row is appended last.
 */
export function createOptimisticUserMessage(args: {
  sessionId: string;
  turnId: string;
  /** The composer's wire content: plain text, or JSON-encoded `PartInput[]`. */
  content: string;
  model?: string | null;
}): Message {
  const messageId = optimisticMessageId(args.turnId);
  return {
    id: messageId,
    session_id: args.sessionId,
    seq: Number.MAX_SAFE_INTEGER,
    role: "user",
    turn_id: args.turnId,
    sent_at: new Date().toISOString(),
    model: args.model ?? null,
    parts: buildOptimisticParts({
      sessionId: args.sessionId,
      messageId,
      content: args.content,
    }),
  };
}

/**
 * The composer's `content` → engine `Part`s.
 *
 * `AgentInput` is `string | PartInput[]`, so the composer sends either a bare
 * string or JSON-encoded `PartInput[]` (`buildMessageContent`). Both shapes
 * become the parts the echo will restate.
 */
export function buildOptimisticParts(args: {
  sessionId: string;
  messageId: string;
  content: string;
}): Part[] {
  const inputs = readPartInputs(args.content);
  const parts: Part[] = [];
  inputs.forEach((input, index) => {
    const base = {
      id: `${LOCAL_PREFIX}${args.messageId}-${index}`,
      sessionId: args.sessionId,
      messageId: args.messageId,
    };
    if (input.type === "text") {
      parts.push({ ...base, type: "text", text: input.text, state: "done" });
      return;
    }
    if (input.type === "image") {
      parts.push({
        ...base,
        type: "image",
        mimeType: input.mimeType,
        ...(input.data ? { data: input.data } : {}),
        ...(input.url ? { url: input.url } : {}),
      });
    }
    // `file` inputs have no bubble representation yet — the echo will bring one.
  });
  return parts;
}

/**
 * Retire one send's bubble after a rejection.
 *
 * Targeted on purpose. Restoring the pre-send snapshot would also discard
 * anything that streamed in while the send was in flight, and doing nothing
 * left the prompt on screen until an unrelated q:delta happened to strip it —
 * the user's text disappearing minutes later, with nothing written anywhere
 * (the backend does not write the user row; the engine echo does).
 */
export function dropOptimisticMessage(
  queryClient: QueryClient,
  sessionId: string,
  turnId: string
): void {
  const id = optimisticMessageId(turnId);
  queryClient.setQueryData<PaginatedMessages>(
    queryKeys.sessions.messages(sessionId),
    (old): PaginatedMessages | undefined => {
      if (!old) return old;
      const messages = old.messages.filter((m) => m.id !== id);
      return messages.length === old.messages.length ? old : { ...old, messages };
    }
  );
}

function readPartInputs(content: string): PartInput[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return [{ type: "text", text: content }];
  }
  if (!Array.isArray(parsed)) return [{ type: "text", text: content }];
  return parsed.filter(
    (entry): entry is PartInput =>
      !!entry && typeof entry === "object" && typeof (entry as PartInput).type === "string"
  );
}
