import { applyRuntimeEvent, createSessionRuntimeState } from "@deus-hq/sdk";
import type {
  AssistantMessage as CloudAssistantMessage,
  AssistantMessageInfo as CloudAssistantMessageInfo,
  Message as CloudMessage,
  MessageInfo as CloudMessageInfo,
  Part as CloudPart,
  RuntimeToolState as CloudRuntimeToolState,
  SessionRuntimeEvent as CloudSessionRuntimeEvent,
  SessionRuntimeState,
} from "@deus-hq/sdk";
import type { AgentHarness } from "@shared/enums";
import type {
  MessageCreatedEvent,
  MessageDoneEvent,
  PartCreatedEvent,
  PartDeltaEvent,
  PartDoneEvent,
} from "@shared/agent-events";
import type {
  CompletedToolState,
  CompactionPart,
  ErrorToolState,
  Part,
  ReasoningPart,
  RuntimeToolState,
  TextPart,
  ToolKind,
  ToolOutputContent,
  ToolPart,
} from "@shared/messages";

export type CloudRuntimeAdapterEvent =
  | MessageCreatedEvent
  | PartCreatedEvent
  | PartDeltaEvent
  | PartDoneEvent
  | MessageDoneEvent;

interface CloudRuntimeAdapterState {
  sessionId: string;
  agentHarness: AgentHarness;
  runtimeState: SessionRuntimeState;
  activeMessageId: string | null;
  createdMessageIds: Set<string>;
  completedMessageIds: Set<string>;
  createdPartIds: Set<string>;
  completedPartIds: Set<string>;
  partsByMessageId: Map<string, Part[]>;
}

interface CloudRuntimeAdapterOptions {
  sessionId: string;
  agentHarness: AgentHarness;
}

export interface CloudRuntimeAdapter {
  handle(event: CloudSessionRuntimeEvent): CloudRuntimeAdapterEvent[];
  finalize(stopReason: string): CloudRuntimeAdapterEvent[];
}

export function createCloudRuntimeAdapter(
  options: CloudRuntimeAdapterOptions
): CloudRuntimeAdapter {
  const state: CloudRuntimeAdapterState = {
    sessionId: options.sessionId,
    agentHarness: options.agentHarness,
    runtimeState: createSessionRuntimeState(),
    activeMessageId: null,
    createdMessageIds: new Set(),
    completedMessageIds: new Set(),
    createdPartIds: new Set(),
    completedPartIds: new Set(),
    partsByMessageId: new Map(),
  };

  return {
    handle(event) {
      return handleCloudRuntimeEvent(state, event);
    },
    finalize(stopReason) {
      return finalizeActiveMessage(state, stopReason);
    },
  };
}

function handleCloudRuntimeEvent(
  state: CloudRuntimeAdapterState,
  event: CloudSessionRuntimeEvent
): CloudRuntimeAdapterEvent[] {
  applyRuntimeEvent(state.runtimeState, event);

  switch (event.type) {
    case "turn.started":
      state.activeMessageId = event.messageId;
      return [];
    case "message.updated":
      return handleMessageUpdated(state, event.message);
    case "message.part.updated":
      return handlePartUpdated(state, event.messageId, event.part);
    case "message.part.delta":
      return handlePartDelta(state, event.messageId, event.partId, event.delta);
    case "message.ended":
      return handleMessageEnded(
        state,
        event.messageId,
        event.message,
        event.finishReason ?? "end_turn"
      );
    case "turn.ended":
      if (event.status === "FAILED") return [];
      return finalizeActiveMessage(state, event.finishReason ?? "end_turn");
    default:
      return [];
  }
}

function handleMessageUpdated(
  state: CloudRuntimeAdapterState,
  message: CloudMessageInfo
): CloudRuntimeAdapterEvent[] {
  if (message.role !== "ASSISTANT") return [];
  return ensureAssistantMessage(state, message);
}

function handlePartUpdated(
  state: CloudRuntimeAdapterState,
  messageId: string,
  cloudPart: CloudPart
): CloudRuntimeAdapterEvent[] {
  const message = findRuntimeMessage(state, messageId);
  if (!message || message.role !== "ASSISTANT") return [];

  const events = ensureAssistantMessage(state, message);
  const part = toLocalPart(cloudPart);
  if (!part) return events;

  upsertMessagePart(state, messageId, part);
  events.push(createPartCreatedEvent(state, messageId, part));

  if (isTerminalPart(part)) {
    events.push(...completePart(state, messageId, part));
  }

  return events;
}

function handlePartDelta(
  state: CloudRuntimeAdapterState,
  messageId: string,
  partId: string,
  delta: string
): CloudRuntimeAdapterEvent[] {
  const message = findRuntimeMessage(state, messageId);
  if (!message || message.role !== "ASSISTANT") return [];

  const cloudPart = message.parts.find((candidate) => candidate.id === partId);
  if (!cloudPart || (cloudPart.type !== "TEXT" && cloudPart.type !== "REASONING")) return [];

  const events = ensureAssistantMessage(state, message);
  const part = toLocalPart(cloudPart);
  if (!part) return events;

  upsertMessagePart(state, messageId, part);
  if (!state.createdPartIds.has(partId)) {
    events.push(createPartCreatedEvent(state, messageId, part));
    return events;
  }

  events.push({
    type: "part.delta",
    sessionId: state.sessionId,
    agentHarness: state.agentHarness,
    partId,
    delta,
  });
  return events;
}

function handleMessageEnded(
  state: CloudRuntimeAdapterState,
  messageId: string,
  cloudMessage: CloudMessage | undefined,
  stopReason: string
): CloudRuntimeAdapterEvent[] {
  const message = cloudMessage ?? findRuntimeMessage(state, messageId);
  if (!message || message.role !== "ASSISTANT") return [];

  const events = ensureAssistantMessage(state, message);
  for (const cloudPart of message.parts) {
    const part = toLocalPart(cloudPart);
    if (!part) continue;

    upsertMessagePart(state, messageId, part);
    events.push(createPartCreatedEvent(state, messageId, part));
    events.push(...completePart(state, messageId, terminalizePart(part)));
  }
  events.push(...finalizeMessage(state, messageId, stopReason));
  return events;
}

function ensureAssistantMessage(
  state: CloudRuntimeAdapterState,
  message: CloudAssistantMessage | CloudAssistantMessageInfo
): CloudRuntimeAdapterEvent[] {
  if (state.createdMessageIds.has(message.id)) return [];

  state.createdMessageIds.add(message.id);
  state.activeMessageId = message.id;
  return [
    {
      type: "message.created",
      sessionId: state.sessionId,
      agentHarness: state.agentHarness,
      messageId: message.id,
      role: "assistant",
      messageIndex: message.messageIndex,
      parentToolCallId: message.parentId,
    },
  ];
}

function createPartCreatedEvent(
  state: CloudRuntimeAdapterState,
  messageId: string,
  part: Part
): PartCreatedEvent {
  state.createdPartIds.add(part.id);
  return {
    type: "part.created",
    sessionId: state.sessionId,
    agentHarness: state.agentHarness,
    messageId,
    partId: part.id,
    part,
  };
}

function completePart(
  state: CloudRuntimeAdapterState,
  messageId: string,
  part: Part
): CloudRuntimeAdapterEvent[] {
  if (state.completedPartIds.has(part.id)) return [];

  state.completedPartIds.add(part.id);
  upsertMessagePart(state, messageId, part);
  return [
    {
      type: "part.done",
      sessionId: state.sessionId,
      agentHarness: state.agentHarness,
      messageId,
      partId: part.id,
      part,
    },
  ];
}

function finalizeActiveMessage(
  state: CloudRuntimeAdapterState,
  stopReason: string
): CloudRuntimeAdapterEvent[] {
  if (!state.activeMessageId) return [];
  return finalizeMessage(state, state.activeMessageId, stopReason);
}

function finalizeMessage(
  state: CloudRuntimeAdapterState,
  messageId: string,
  stopReason: string
): CloudRuntimeAdapterEvent[] {
  if (state.completedMessageIds.has(messageId)) return [];
  const parts = state.partsByMessageId.get(messageId) ?? [];
  if (!state.createdMessageIds.has(messageId) && parts.length === 0) return [];

  state.completedMessageIds.add(messageId);
  return [
    {
      type: "message.done",
      sessionId: state.sessionId,
      agentHarness: state.agentHarness,
      messageId,
      stopReason,
      parts: sortLocalParts(parts.map(terminalizePart)),
    },
  ];
}

function findRuntimeMessage(
  state: CloudRuntimeAdapterState,
  messageId: string
): CloudMessage | undefined {
  return state.runtimeState.messages.find((message) => message.id === messageId);
}

function upsertMessagePart(state: CloudRuntimeAdapterState, messageId: string, part: Part): void {
  const parts = state.partsByMessageId.get(messageId) ?? [];
  const index = parts.findIndex((candidate) => candidate.id === part.id);
  if (index === -1) {
    parts.push(part);
  } else {
    parts[index] = part;
  }
  state.partsByMessageId.set(messageId, sortLocalParts(parts));
}

function sortLocalParts(parts: Part[]): Part[] {
  return [...parts].sort((a, b) => (a.partIndex ?? 0) - (b.partIndex ?? 0));
}

function toLocalPart(cloudPart: CloudPart): Part | null {
  switch (cloudPart.type) {
    case "TEXT":
      return {
        type: "TEXT",
        id: cloudPart.id,
        sessionId: cloudPart.sessionId,
        messageId: cloudPart.messageId,
        partIndex: cloudPart.partIndex,
        text: cloudPart.text,
        state: cloudPart.state,
        parentToolCallId: cloudPart.parentToolCallId,
      } satisfies TextPart;
    case "REASONING":
      return {
        type: "REASONING",
        id: cloudPart.id,
        sessionId: cloudPart.sessionId,
        messageId: cloudPart.messageId,
        partIndex: cloudPart.partIndex,
        text: cloudPart.text,
        state: cloudPart.state,
        providerMetadata: cloudPart.providerMetadata,
        parentToolCallId: cloudPart.parentToolCallId,
      } satisfies ReasoningPart;
    case "TOOL":
      return {
        type: "TOOL",
        id: cloudPart.id,
        sessionId: cloudPart.sessionId,
        messageId: cloudPart.messageId,
        partIndex: cloudPart.partIndex,
        toolCallId: cloudPart.toolCallId,
        toolName: cloudPart.toolName,
        kind: cloudPart.kind ?? classifyToolKind(cloudPart.toolName),
        title: cloudPart.title,
        locations: cloudPart.locations,
        state: toLocalToolState(cloudPart.state, cloudPart.title),
        subagent: cloudPart.subagent,
        parentToolCallId: cloudPart.parentToolCallId,
      } satisfies ToolPart;
    case "COMPACTION":
      return {
        type: "COMPACTION",
        id: cloudPart.id,
        sessionId: cloudPart.sessionId,
        messageId: cloudPart.messageId,
        partIndex: cloudPart.partIndex,
        auto: cloudPart.auto,
        preTokens: cloudPart.preTokens,
        parentToolCallId: cloudPart.parentToolCallId,
      } satisfies CompactionPart;
  }
}

function toLocalToolState(state: CloudRuntimeToolState, fallbackTitle?: string): RuntimeToolState {
  switch (state.status) {
    case "PENDING":
      return {
        status: "PENDING",
        partialInput: state.partialInput,
      };
    case "RUNNING":
      return {
        status: "RUNNING",
        input: state.input,
        title: state.title ?? fallbackTitle,
        time: state.time,
      };
    case "COMPLETED":
      return {
        status: "COMPLETED",
        input: state.input,
        output: state.output,
        title: state.title ?? fallbackTitle,
        metadata: state.metadata,
        content: toLocalToolContent(state.content, state.output),
        time: state.time,
      } satisfies CompletedToolState;
    case "ERROR":
      return {
        status: "ERROR",
        input: state.input,
        error: state.error,
        time: state.time,
      } satisfies ErrorToolState;
  }
}

function toLocalToolContent(content: unknown, output: unknown): ToolOutputContent[] | undefined {
  if (Array.isArray(content)) return content as ToolOutputContent[];

  const outputText = stringifyOutput(output);
  return outputText ? [{ type: "text", text: outputText }] : undefined;
}

function isTerminalPart(part: Part): boolean {
  switch (part.type) {
    case "TEXT":
    case "REASONING":
      return part.state === "DONE";
    case "TOOL":
      return part.state.status === "COMPLETED" || part.state.status === "ERROR";
    case "COMPACTION":
      return true;
  }
}

function terminalizePart(part: Part): Part {
  if (part.type === "TEXT" || part.type === "REASONING") {
    return { ...part, state: "DONE" };
  }
  return part;
}

function classifyToolKind(toolName: string): ToolKind {
  const normalized = toolName.toLowerCase();
  if (normalized === "bash" || normalized === "shell") return "bash";
  if (["read", "notebookread"].includes(normalized)) return "read";
  if (["write", "edit", "multiedit", "notebookedit"].includes(normalized)) return "write";
  if (["grep", "glob", "websearch", "webfetch"].includes(normalized)) return "search";
  if (["task", "agent"].includes(normalized)) return "task";
  if (normalized.startsWith("mcp__") || normalized.includes("/")) return "mcp";
  return "other";
}

function stringifyOutput(output: unknown): string {
  if (output == null) return "";
  if (typeof output === "string") return output;
  try {
    return JSON.stringify(output, null, 2);
  } catch {
    return String(output);
  }
}
