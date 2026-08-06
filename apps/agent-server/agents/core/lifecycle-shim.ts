// agent-server/agents/core/lifecycle-shim.ts
// Translate the embedded engine's LifecycleEvent stream into deus's PartEvents
// so the existing EventBroadcaster wire format (the frontend contract) stays
// byte-compatible. Goes away if consumers ever move to LifecycleEvent itself.

import type { LifecycleEvent, Part as EnginePart, StopReason } from "@agent-server/protocol";
import type { FinishReason, Part, ReasoningPart, TextPart, ToolPart } from "@shared/messages";
import type { PartEvent } from "@shared/agent-events";

/** Engine stop reasons → deus finish reasons (refusal ends the turn normally). */
const FINISH_REASON: Record<StopReason, FinishReason> = {
  end_turn: "end_turn",
  max_tokens: "max_tokens",
  max_turn_requests: "max_turns",
  refusal: "end_turn",
  cancelled: "cancelled",
  error: "error",
};

function toDeusToolState(state: Extract<EnginePart, { type: "tool" }>["state"]): ToolPart["state"] {
  switch (state.status) {
    case "pending":
      return { status: "PENDING" } as ToolPart["state"];
    case "in_progress":
      return { status: "RUNNING", input: state.input } as ToolPart["state"];
    case "completed":
      return {
        status: "COMPLETED",
        input: state.input,
        output: state.output,
      } as ToolPart["state"];
    case "failed":
      return { status: "ERROR", input: state.input, error: state.error } as ToolPart["state"];
  }
}

/** Engine Part → deus Part (UPPERCASE types, STREAMING/DONE states). */
export function toDeusPart(part: EnginePart): Part {
  const base = {
    id: part.id,
    sessionId: part.sessionId,
    messageId: part.messageId,
    ...(part.parentToolUseId ? { parentToolCallId: part.parentToolUseId } : {}),
  };
  if (part.type === "text") {
    return {
      ...base,
      type: "TEXT",
      text: part.text,
      state: part.state === "done" ? "DONE" : "STREAMING",
    } as TextPart;
  }
  if (part.type === "reasoning") {
    return {
      ...base,
      type: "REASONING",
      text: part.text,
      state: part.state === "done" ? "DONE" : "STREAMING",
    } as ReasoningPart;
  }
  return {
    ...base,
    type: "TOOL",
    toolCallId: part.toolCallId,
    toolName: part.toolName,
    state: toDeusToolState(part.state),
    ...(part.title ? { title: part.title } : {}),
    ...(part.kind ? { kind: part.kind } : {}),
    ...(part.locations?.length ? { locations: part.locations } : {}),
  } as ToolPart;
}

function isTerminal(part: EnginePart): boolean {
  if (part.type === "tool") {
    return part.state.status === "completed" || part.state.status === "failed";
  }
  return part.state === "done";
}

/**
 * Per-turn stateful translator. Mapping:
 *   turn.started       → turn.started
 *   message.started    → message.created
 *   message.part       → part.created (first sight) / part.done (terminal)
 *   message.part.delta → part.delta (text + reasoning)
 *   message.ended      → message.done (with that message's parts)
 *   turn.ended         → turn.completed (finishReason, tokens, cost)
 */
export class LifecycleToPartEvents {
  private readonly seen = new Map<string, Part>();
  private readonly byMessage = new Map<string, Part[]>();

  translate(event: LifecycleEvent): PartEvent[] {
    switch (event.type) {
      case "turn.started":
        return [{ type: "turn.started", turnId: event.turnId }];
      case "message.started":
        return [
          {
            type: "message.created",
            messageId: event.messageId,
            role: "assistant",
            ...(event.parentToolUseId ? { parentToolCallId: event.parentToolUseId } : {}),
          },
        ];
      case "message.part.delta": {
        if (event.delta.type === "tool-input-delta") return [];
        return [{ type: "part.delta", partId: event.partId, delta: event.delta.text }];
      }
      case "message.part": {
        const deusPart = toDeusPart(event.part);
        const first = !this.seen.has(event.part.id);
        this.seen.set(event.part.id, deusPart);
        if (first) {
          const list = this.byMessage.get(event.messageId) ?? [];
          list.push(deusPart);
          this.byMessage.set(event.messageId, list);
        } else {
          const list = this.byMessage.get(event.messageId) ?? [];
          const idx = list.findIndex((p) => p.id === deusPart.id);
          if (idx >= 0) list[idx] = deusPart;
        }
        // Terminal on first sight (completed-on-arrival parts, e.g. Codex SDK
        // messages) still gets the full created → done pair: consumers may key
        // finality off either the part.done event or the part's state.
        if (first && isTerminal(event.part)) {
          return [
            { type: "part.created", part: deusPart },
            { type: "part.done", part: deusPart },
          ];
        }
        if (first) return [{ type: "part.created", part: deusPart }];
        if (isTerminal(event.part)) return [{ type: "part.done", part: deusPart }];
        return [];
      }
      case "message.ended":
        return [
          {
            type: "message.done",
            messageId: event.messageId,
            parts: this.byMessage.get(event.messageId) ?? [],
          },
        ];
      case "turn.ended":
        return [
          {
            type: "turn.completed",
            turnId: event.turnId,
            finishReason: FINISH_REASON[event.stopReason],
            ...(event.tokens ? { tokens: event.tokens } : {}),
            ...(event.cost !== undefined ? { cost: event.cost } : {}),
          } as PartEvent,
        ];
      default:
        return [];
    }
  }
}
