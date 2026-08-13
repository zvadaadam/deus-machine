// backend/src/services/agent/translate/lifecycle-shim.ts
// Translate the embedded engine's LifecycleEvent stream into deus's PartEvents
// so the existing EventBroadcaster wire format (the frontend contract) stays
// byte-compatible. Every emitted part must satisfy deus's zod schemas — the
// backend validates with AgentEventSchema.safeParse and SKIPS invalid events,
// so a shape mismatch here silently drops content (see the shim test, which
// parses every emission).

import type { LifecycleEvent, Part as EnginePart, StopReason } from "@zvada/agent-server/protocol";
import type { FinishReason, Part, ToolPart, TokenUsage } from "@shared/messages";
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

const iso = (ms: number): string => new Date(ms).toISOString();

/** Sub-agent spawning tools — deus renders their child output only under
 * kind "task" (Chat.tsx filters parented messages; ToolPartBlock nests them). */
const SUBAGENT_TOOLS = new Set(["Task", "Agent", "spawn_agent"]);

/** Engine ToolKind (ACP taxonomy) → deus ToolKind. */
const TOOL_KIND: Record<string, ToolPart["kind"] & string> = {
  read: "read",
  edit: "write",
  delete: "write",
  move: "write",
  search: "search",
  execute: "bash",
  think: "other",
  fetch: "other",
  switch_mode: "other",
  other: "other",
};

/** Engine tool state → deus RuntimeToolState (UPPERCASE, ISO timestamps). */
function toDeusToolState(state: Extract<EnginePart, { type: "tool" }>["state"]): ToolPart["state"] {
  switch (state.status) {
    case "pending":
      return { status: "PENDING", partialInput: state.partialInput };
    case "in_progress":
      return {
        status: "RUNNING",
        input: state.input,
        ...(state.title !== undefined ? { title: state.title } : {}),
        time: { start: iso(state.time.start) },
      };
    case "completed":
      return {
        status: "COMPLETED",
        input: state.input,
        output: state.output,
        title: state.title,
        ...(state.metadata !== undefined ? { metadata: state.metadata } : {}),
        time: { start: iso(state.time.start), end: iso(state.time.end) },
      };
    case "failed":
      return {
        status: "ERROR",
        input: state.input,
        error: state.error,
        time: { start: iso(state.time.start), end: iso(state.time.end) },
      };
  }
}

/** Engine token usage → deus token usage (cache object → cacheRead/cacheCreation). */
export function toDeusTokens(
  tokens: NonNullable<Extract<LifecycleEvent, { type: "turn.ended" }>["tokens"]>
): TokenUsage {
  return {
    input: tokens.input,
    output: tokens.output,
    ...(tokens.reasoning !== undefined ? { reasoning: tokens.reasoning } : {}),
    ...(tokens.cache
      ? { cacheRead: tokens.cache.read, cacheCreation: { total: tokens.cache.write } }
      : {}),
  };
}

/** Engine Part → deus Part (UPPERCASE types, STREAMING/DONE states). */
export function toDeusPart(part: EnginePart, partIndex?: number): Part {
  const base = {
    id: part.id,
    sessionId: part.sessionId,
    messageId: part.messageId,
    ...(partIndex !== undefined ? { partIndex } : {}),
    ...(part.parentToolUseId ? { parentToolCallId: part.parentToolUseId } : {}),
  };
  if (part.type === "text") {
    return {
      ...base,
      type: "TEXT",
      text: part.text,
      state: part.state === "done" ? "DONE" : "STREAMING",
    };
  }
  if (part.type === "reasoning") {
    return {
      ...base,
      type: "REASONING",
      text: part.text,
      state: part.state === "done" ? "DONE" : "STREAMING",
    };
  }
  return {
    ...base,
    type: "TOOL",
    toolCallId: part.toolCallId,
    toolName: part.toolName,
    state: toDeusToolState(part.state),
    ...(part.title !== undefined ? { title: part.title } : {}),
    ...(SUBAGENT_TOOLS.has(part.toolName)
      ? { kind: "task" as const }
      : part.kind !== undefined
        ? { kind: TOOL_KIND[part.kind] ?? "other" }
        : {}),
    ...(part.locations !== undefined ? { locations: part.locations } : {}),
  };
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
 *   message.part       → part.created (first sight) / part.done (terminal);
 *                        terminal-on-first-sight emits the created→done pair
 *   message.part.delta → part.delta (text + reasoning)
 *   message.ended      → message.done (with that message's parts, by partIndex)
 *   turn.ended         → turn.completed (finishReason, tokens, cost)
 */
export class LifecycleToPartEvents {
  /** Latest deus part per engine part id (also the message.done source). */
  private readonly parts = new Map<string, Part>();
  /** Sub-agent parent per messageId, carried onto message.done. */
  private readonly messageParents = new Map<string, string>();

  translate(event: LifecycleEvent): PartEvent[] {
    switch (event.type) {
      case "turn.started":
        return [{ type: "turn.started", turnId: event.turnId }];
      case "message.started":
        if (event.parentToolUseId) this.messageParents.set(event.messageId, event.parentToolUseId);
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
        const previous = this.parts.get(event.part.id);
        const deusPart = toDeusPart(event.part, event.partIndex);
        this.parts.set(event.part.id, deusPart);
        // Consumers may key finality off the part.done event or the part's
        // state, so a part that is terminal on first sight (completed-on-arrival
        // messages, e.g. Codex SDK) still gets the full created → done pair.
        // Nonterminal STATE changes (tool pending → running) re-emit
        // part.created — the frontend upserts by part id, and the RUNNING state
        // is where the parsed tool input first appears.
        const events: PartEvent[] = [];
        const stateChanged =
          previous !== undefined &&
          previous.type === "TOOL" &&
          deusPart.type === "TOOL" &&
          previous.state.status !== deusPart.state.status;
        if (previous === undefined || (stateChanged && !isTerminal(event.part))) {
          events.push({ type: "part.created", part: deusPart });
        }
        if (isTerminal(event.part)) events.push({ type: "part.done", part: deusPart });
        return events;
      }
      case "message.ended": {
        const parts = [...this.parts.values()]
          .filter((p) => p.messageId === event.messageId)
          .sort((a, b) => (a.partIndex ?? 0) - (b.partIndex ?? 0));
        const parent = this.messageParents.get(event.messageId);
        // Legacy adapters persisted the model's stop reason per message; the
        // engine doesn't surface it on message.ended, so synthesize the two
        // structural values (a message that ran tools stopped to use them).
        // "cancelled"/"error" ride their own channels (message.cancelled /
        // session.error), matching how the frontend actually detects them.
        const stopReason = parts.some((p) => p.type === "TOOL") ? "tool_use" : "end_turn";
        return [
          {
            type: "message.done",
            messageId: event.messageId,
            stopReason,
            parts,
            ...(parent ? { parentToolCallId: parent } : {}),
          },
        ];
      }
      case "turn.ended":
        return [
          {
            type: "turn.completed",
            turnId: event.turnId,
            finishReason: FINISH_REASON[event.stopReason],
            ...(event.tokens ? { tokens: toDeusTokens(event.tokens) } : {}),
            ...(event.cost !== undefined ? { cost: event.cost } : {}),
          },
        ];
      default:
        return [];
    }
  }
}
