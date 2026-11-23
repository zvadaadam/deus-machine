import { toolCardInput, toolCardName } from "./mcp-servers";
import {
  isUnknownPart,
  type Part,
  type TextPart,
  type ToolPart,
  type UnknownPart,
} from "./protocol-types";

/** The Deus tool an agent calls to send the person a message while it works. */
export const TELL_USER = "tell_user";

const sent = new WeakMap<ToolPart, TextPart>();

/** A completed send, read as the same text part every time. */
export function sentText(part: Part | UnknownPart): TextPart | undefined {
  if (
    isUnknownPart(part) ||
    part.type !== "tool" ||
    part.state.status !== "completed" ||
    toolCardName(part) !== TELL_USER
  )
    return undefined;

  const previous = sent.get(part);
  if (previous) return previous;
  const { message } = toolCardInput(part);
  if (typeof message !== "string" || !message.trim()) return undefined;

  const { id, sessionId, messageId } = part;
  const text: TextPart = { type: "text", id, sessionId, messageId, state: "done", text: message };
  sent.set(part, text);
  return text;
}

/** Parts in order, each completed send read as text. */
export function withSentText<T extends Part | UnknownPart>(parts: readonly T[]): (T | TextPart)[] {
  return parts.map((part) => sentText(part) ?? part);
}
