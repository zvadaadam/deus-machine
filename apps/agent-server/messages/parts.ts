// agent-server/messages/parts.ts
// Factory functions and immutable mutation helpers for creating unified Parts.

import { uuidv7 } from "@shared/lib/uuid";
import type {
  CompactionPart,
  CompletedToolState,
  ErrorToolState,
  PendingToolState,
  ReasoningPart,
  RunningToolState,
  RuntimeToolState,
  SubagentMetadata,
  TextPart,
  ToolKind,
  ToolPart,
} from "@shared/messages";

// ---------------------------------------------------------------------------
// Factory functions
// ---------------------------------------------------------------------------

export function createTextPart(
  sessionId: string,
  messageId: string,
  text: string,
  state?: "STREAMING" | "DONE"
): TextPart {
  return { id: uuidv7(), sessionId, messageId, type: "TEXT", text, state };
}

export function createReasoningPart(
  sessionId: string,
  messageId: string,
  text: string,
  state?: "STREAMING" | "DONE"
): ReasoningPart {
  return { id: uuidv7(), sessionId, messageId, type: "REASONING", text, state };
}

export function createToolPart(
  sessionId: string,
  messageId: string,
  opts: {
    toolCallId: string;
    toolName: string;
    kind?: ToolKind;
    state: RuntimeToolState;
    subagent?: SubagentMetadata;
  }
): ToolPart {
  return {
    id: uuidv7(),
    sessionId,
    messageId,
    type: "TOOL",
    toolCallId: opts.toolCallId,
    toolName: opts.toolName,
    kind: opts.kind,
    state: opts.state,
    subagent: opts.subagent,
  };
}

export function createPendingToolPart(
  sessionId: string,
  messageId: string,
  toolCallId: string,
  toolName: string
): ToolPart {
  return createToolPart(sessionId, messageId, {
    toolCallId,
    toolName,
    state: { status: "PENDING", partialInput: "" } satisfies PendingToolState,
  });
}

export function createCompactionPart(
  sessionId: string,
  messageId: string,
  auto = true,
  preTokens?: number
): CompactionPart {
  return { id: uuidv7(), sessionId, messageId, type: "COMPACTION", auto, preTokens };
}

// ---------------------------------------------------------------------------
// Mutation helpers (return new objects — immutable)
// ---------------------------------------------------------------------------

export function startToolPart(part: ToolPart, input: unknown, title?: string): ToolPart {
  return {
    ...part,
    title,
    state: {
      status: "RUNNING",
      input,
      title,
      time: { start: new Date().toISOString() },
    } satisfies RunningToolState,
  };
}

export function completeToolPart(part: ToolPart, output: unknown, isError: boolean): ToolPart {
  const now = new Date().toISOString();
  const startTime = part.state.status === "RUNNING" ? part.state.time.start : now;

  if (isError) {
    return {
      ...part,
      state: {
        status: "ERROR",
        input: part.state.status === "RUNNING" ? part.state.input : undefined,
        error: typeof output === "string" ? output : JSON.stringify(output),
        time: { start: startTime, end: now },
      } satisfies ErrorToolState,
    };
  }

  return {
    ...part,
    state: {
      status: "COMPLETED",
      input: part.state.status === "RUNNING" ? part.state.input : undefined,
      output,
      title: part.title,
      time: { start: startTime, end: now },
    } satisfies CompletedToolState,
  };
}
