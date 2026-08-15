/**
 * The composer's optimistic user bubble — PREDICTED, not reconciled.
 *
 * A send mints its own `turnId` (see `useSendMessage`) and hands the SAME id to
 * the backend command and to this row. The engine derives the ids of the user
 * echo it will emit for that turn from the turn id, so a caller that minted the
 * turn id can build the echo before the engine sends it:
 *
 *   echoMessageId(turnId)          → the row id  (`echo-${turnId}`)
 *   createUserEchoParts(in, turn)  → the parts   (`echo-${turnId}-${i}`)
 *
 * The bubble IS the echo, byte for byte. When the real one arrives the fold
 * upserts it onto the same row by id — nothing to find by turn id, nothing to
 * swap, no frame where the prompt renders twice, and multimodal parts survive
 * (the swap-a-look-alike approach is where image and file parts got dropped,
 * because the look-alike had to be built a second time by hand).
 *
 * Consequently there is no "local" id space any more. A bubble is retired
 * exactly once — by `dropOptimisticMessage` when the send is REJECTED — so a
 * failed send leaves the typed message on screen instead of evaporating on the
 * next unrelated delta.
 */

import type { QueryClient } from "@tanstack/react-query";
import { createUserEchoParts, echoMessageId } from "@zvada/agent-server/protocol/factories";
import { queryKeys } from "@/shared/api/queryKeys";
import type { PaginatedMessages } from "../api/session.service";
import type { Message } from "../types";
import type { AgentInput, PartInput } from "@shared/protocol-types";

/**
 * The bubble the composer shows while the send is in flight: the engine's own
 * echo, built early.
 */
export function createOptimisticUserMessage(args: {
  sessionId: string;
  turnId: string;
  /** The composer's wire content: plain text, or JSON-encoded `PartInput[]`. */
  content: string;
  model?: string | null;
}): Message {
  const input = readAgentInput(args.content);
  return {
    id: echoMessageId(args.turnId),
    session_id: args.sessionId,
    seq: 0,
    role: "user",
    turn_id: args.turnId,
    sent_at: new Date().toISOString(),
    model: args.model ?? null,
    // The engine stamps sessionId/messageId at emit time; the renderer reads
    // neither off a part, and the echo's upsert restates them regardless.
    parts: createUserEchoParts(input, args.turnId),
  };
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
  const id = echoMessageId(turnId);
  queryClient.setQueryData<PaginatedMessages>(
    queryKeys.sessions.messages(sessionId),
    (old): PaginatedMessages | undefined => {
      if (!old) return old;
      const messages = old.messages.filter((m) => m.id !== id);
      return messages.length === old.messages.length ? old : { ...old, messages };
    }
  );
}

/**
 * The composer's `content` → the `AgentInput` the backend will forward.
 *
 * Mirrors `toEngineInput` on the backend, and for the same reason: deus's send
 * carries the prompt as one string, so an attachment-bearing send is a
 * JSON-encoded `PartInput[]` and a text-only send is the text. Anything that
 * does not decode as parts is what the user typed.
 */
function readAgentInput(content: string): AgentInput {
  if (!content.startsWith("[")) return content;
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return content;
  }
  if (!Array.isArray(parsed) || parsed.length === 0) return content;
  const parts = parsed.filter(
    (entry): entry is PartInput =>
      !!entry && typeof entry === "object" && typeof (entry as PartInput).type === "string"
  );
  return parts.length === parsed.length ? parts : content;
}
