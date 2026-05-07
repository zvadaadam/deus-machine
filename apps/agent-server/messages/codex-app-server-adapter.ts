// agent-server/messages/codex-app-server-adapter.ts
// Transforms Codex app-server notifications into unified Parts.

import type {
  AgentResultContent,
  DiffContent,
  FinishReason,
  Part,
  RunningToolState,
  TokenUsage,
  ToolOutputContent,
} from "@shared/messages";
import { emptyTokenUsage } from "@shared/messages";
import { uuidv7 } from "@shared/lib/uuid";
import type {
  CodexAppServerNotification,
  CodexThreadItem,
  CodexThreadTokenUsage,
} from "../agents/codex-server/codex-server-types";
import type { Adapter, EventTransformer, PartEvent, StreamContext } from "./adapter";
import {
  completeReasoningPart,
  createCompactionPart,
  createReasoningPart,
  createTextPart,
  createToolPart,
} from "./parts";
import {
  completeTrackedToolPart,
  startFileChangeToolPart,
  startMcpToolPart,
  startShellToolPart,
} from "./codex-part-helpers";

type CodexCollabTool = Extract<CodexThreadItem, { type: "collabAgentToolCall" }>["tool"];

const CODEX_COLLAB_TOOL_NAMES = {
  spawnAgent: "spawn_agent",
  sendInput: "send_input",
  resumeAgent: "resume_agent",
  closeAgent: "close_agent",
  wait: "wait_agent",
} as const satisfies Record<CodexCollabTool, string>;

class CodexAppServerTransformer implements EventTransformer<CodexAppServerNotification> {
  private readonly ctx: StreamContext;
  private readonly parts = new Map<string, Part>();
  private readonly itemParts = new Map<string, string>();
  private readonly commandOutput = new Map<string, string>();
  private readonly fileChangeOutput = new Map<string, string>();
  private readonly receiverThreadToSpawnToolCallId = new Map<string, string>();
  private readonly subagentMessages = new Map<
    string,
    { messageId: string; parentToolCallId: string; done: boolean }
  >();
  private readonly emittedAgentResultMessages = new Set<string>();
  private currentThreadId: string | undefined;
  private totalUsage: TokenUsage = { ...emptyTokenUsage };
  private lastFinishReason: FinishReason | undefined;
  private turnCompletedEmitted = false;

  constructor(ctx: StreamContext) {
    this.ctx = ctx;
  }

  process(notification: CodexAppServerNotification): PartEvent[] {
    const threadId = notificationThreadId(notification);
    const previousThreadId = this.currentThreadId;
    this.currentThreadId = threadId;

    try {
      const boundaryEvents = this.ensureSubagentMessage(threadId);
      let emitted: PartEvent[] = [];

      switch (notification.method) {
        case "thread/started":
        case "thread/status/changed":
        case "item/fileChange/patchUpdated":
        case "item/mcpToolCall/progress":
          emitted = [];
          break;
        case "turn/started":
          emitted = this.handleTurnStarted(notification.params.turn.id);
          break;
        case "turn/completed":
          emitted = this.handleTurnCompleted(notification.params.turn.status);
          break;
        case "thread/tokenUsage/updated":
          emitted = this.handleTokenUsage(notification.params.tokenUsage);
          break;
        case "item/started":
          emitted = this.handleItemStarted(notification.params.item);
          break;
        case "item/completed":
          emitted = this.handleItemCompleted(notification.params.item);
          break;
        case "item/agentMessage/delta":
          emitted = this.upsertTextDelta(notification.params.itemId, notification.params.delta);
          break;
        case "item/plan/delta":
          emitted = this.upsertTextDelta(notification.params.itemId, notification.params.delta);
          break;
        case "item/reasoning/textDelta":
        case "item/reasoning/summaryTextDelta":
          emitted = this.upsertReasoningDelta(
            notification.params.itemId,
            notification.params.delta
          );
          break;
        case "item/commandExecution/outputDelta":
          emitted = this.handleCommandOutputDelta(
            notification.params.itemId,
            notification.params.delta
          );
          break;
        case "item/fileChange/outputDelta":
          emitted = this.handleFileChangeOutputDelta(
            notification.params.itemId,
            notification.params.delta
          );
          break;
        case "error":
          this.lastFinishReason = "error";
          emitted = [];
          break;
        default:
          emitted = [];
      }

      return [...boundaryEvents, ...this.tagSubagentEvents(threadId, emitted)];
    } finally {
      this.currentThreadId = previousThreadId;
    }
  }

  finish(): { events: PartEvent[]; parts: Part[]; usage: TokenUsage; cost?: number } {
    const events = this.finalizeStreamingParts();
    if (!this.turnCompletedEmitted) {
      events.push(
        {
          type: "message.done",
          messageId: this.ctx.messageId,
          stopReason: this.lastFinishReason ?? "end_turn",
          parts: this.partsForMessage(this.ctx.messageId),
        },
        {
          type: "turn.completed",
          turnId: this.ctx.turnId,
          finishReason: this.lastFinishReason ?? "end_turn",
          tokens: { ...this.totalUsage },
        }
      );
    }
    return { events, parts: this.getParts(), usage: this.totalUsage };
  }

  getParts(): Part[] {
    return Array.from(this.parts.values());
  }

  isKnownSubagentThread(threadId: string | undefined): boolean {
    return !!threadId && this.receiverThreadToSpawnToolCallId.has(threadId);
  }

  private handleTurnStarted(turnId?: string): PartEvent[] {
    if (this.currentParentToolCallId()) return [];

    return [
      { type: "turn.started", turnId: this.ctx.turnId ?? turnId },
      { type: "message.created", messageId: this.ctx.messageId, role: "assistant" },
    ];
  }

  private handleTurnCompleted(status?: string): PartEvent[] {
    const finishReason: FinishReason =
      status === "failed" ? "error" : status === "interrupted" ? "cancelled" : "end_turn";

    if (this.currentParentToolCallId()) {
      return this.closeSubagentMessage(finishReason);
    }

    this.lastFinishReason = finishReason;
    this.turnCompletedEmitted = true;

    return [
      ...this.finalizeStreamingParts(),
      {
        type: "message.done",
        messageId: this.ctx.messageId,
        stopReason: finishReason,
        parts: this.partsForMessage(this.ctx.messageId),
      },
      {
        type: "turn.completed",
        turnId: this.ctx.turnId,
        finishReason,
        tokens: { ...this.totalUsage },
      },
    ];
  }

  private handleTokenUsage(tokenUsage: CodexThreadTokenUsage): PartEvent[] {
    const usage = tokenUsage.last;
    this.totalUsage = {
      input: this.totalUsage.input + usage.inputTokens,
      output: this.totalUsage.output + usage.outputTokens,
      reasoning:
        usage.reasoningOutputTokens > 0
          ? (this.totalUsage.reasoning ?? 0) + usage.reasoningOutputTokens
          : this.totalUsage.reasoning,
      cacheRead:
        usage.cachedInputTokens > 0
          ? (this.totalUsage.cacheRead ?? 0) + usage.cachedInputTokens
          : this.totalUsage.cacheRead,
    };
    return [];
  }

  private handleItemStarted(item: CodexThreadItem): PartEvent[] {
    switch (item.type) {
      case "agentMessage":
        return item.text ? this.upsertText(item.id, item.text, "STREAMING") : [];
      case "plan":
        return item.text ? this.upsertText(item.id, `Plan:\n${item.text}`, "STREAMING") : [];
      case "reasoning":
        return this.upsertReasoning(item.id, this.reasoningText(item), "STREAMING");
      case "commandExecution":
        return this.startCommandPart(item);
      case "fileChange":
        return this.startFileChangePart(item);
      case "mcpToolCall":
        return this.startMcpPart(item);
      case "dynamicToolCall":
        return this.startDynamicToolPart(item);
      case "collabAgentToolCall":
        return this.startCollabAgentPart(item);
      case "webSearch":
        return this.startWebSearchPart(item);
      case "contextCompaction":
        return this.createCompactionPart(item.id);
      default:
        return [];
    }
  }

  private handleItemCompleted(item: CodexThreadItem): PartEvent[] {
    switch (item.type) {
      case "agentMessage":
        return this.upsertText(item.id, item.text, "DONE");
      case "plan":
        return this.upsertText(item.id, `Plan:\n${item.text}`, "DONE");
      case "reasoning":
        return this.upsertReasoning(item.id, this.reasoningText(item), "DONE");
      case "commandExecution":
        return this.completeCommandPart(item);
      case "fileChange":
        return this.completeFileChangePart(item);
      case "mcpToolCall":
        return this.completeMcpPart(item);
      case "dynamicToolCall":
        return this.completeDynamicToolPart(item);
      case "collabAgentToolCall":
        return this.completeCollabAgentPart(item);
      case "webSearch":
        return this.completeSimpleToolPart(item.id, item.action ?? { query: item.query }, false);
      default:
        return [];
    }
  }

  private upsertTextDelta(itemId: string, delta: string): PartEvent[] {
    const partId = this.itemParts.get(itemId);
    if (partId) {
      const existing = this.parts.get(partId);
      if (existing?.type === "TEXT") {
        const updated: Part = {
          ...existing,
          text: existing.text + delta,
          state: "STREAMING",
        };
        this.parts.set(partId, updated);
        return [{ type: "part.delta", partId, delta }];
      }
    }

    const ctx = this.eventCtx();
    const part = createTextPart(ctx.sessionId, ctx.messageId, delta, "STREAMING");
    this.parts.set(part.id, part);
    this.itemParts.set(itemId, part.id);
    return [{ type: "part.created", part }];
  }

  private upsertText(itemId: string, text: string, state: "STREAMING" | "DONE"): PartEvent[] {
    const partId = this.itemParts.get(itemId);
    if (partId) {
      const existing = this.parts.get(partId);
      if (existing?.type === "TEXT") {
        const updated: Part = { ...existing, text, state };
        this.parts.set(partId, updated);
        return state === "DONE" ? [{ type: "part.done", part: updated }] : [];
      }
    }

    const ctx = this.eventCtx();
    const part = createTextPart(ctx.sessionId, ctx.messageId, text, state);
    this.parts.set(part.id, part);
    this.itemParts.set(itemId, part.id);
    return [{ type: state === "DONE" ? "part.done" : "part.created", part }];
  }

  private upsertReasoningDelta(itemId: string, delta: string): PartEvent[] {
    const partId = this.itemParts.get(itemId);
    if (partId) {
      const existing = this.parts.get(partId);
      if (existing?.type === "REASONING") {
        const updated: Part = {
          ...existing,
          text: existing.text + delta,
          state: "STREAMING",
        };
        this.parts.set(partId, updated);
        return [{ type: "part.delta", partId, delta }];
      }
    }

    const ctx = this.eventCtx();
    const part = createReasoningPart(ctx.sessionId, ctx.messageId, delta, "STREAMING");
    this.parts.set(part.id, part);
    this.itemParts.set(itemId, part.id);
    return [{ type: "part.created", part }];
  }

  private upsertReasoning(itemId: string, text: string, state: "STREAMING" | "DONE"): PartEvent[] {
    if (!text && state === "STREAMING") return [];

    const partId = this.itemParts.get(itemId);
    if (partId) {
      const existing = this.parts.get(partId);
      if (existing?.type === "REASONING") {
        const updated: Part =
          state === "DONE" ? completeReasoningPart(existing, text) : { ...existing, text, state };
        this.parts.set(partId, updated);
        return state === "DONE" ? [{ type: "part.done", part: updated }] : [];
      }
    }

    const ctx = this.eventCtx();
    const part = createReasoningPart(ctx.sessionId, ctx.messageId, text, state);
    this.parts.set(part.id, part);
    this.itemParts.set(itemId, part.id);
    return [{ type: state === "DONE" ? "part.done" : "part.created", part }];
  }

  private startCommandPart(
    item: Extract<CodexThreadItem, { type: "commandExecution" }>
  ): PartEvent[] {
    return startShellToolPart(this.eventCtx(), this.partMaps(), {
      itemId: item.id,
      command: item.command,
      cwd: item.cwd,
    });
  }

  private completeCommandPart(
    item: Extract<CodexThreadItem, { type: "commandExecution" }>
  ): PartEvent[] {
    const isError =
      item.status === "failed" ||
      item.status === "declined" ||
      (item.exitCode !== null && item.exitCode !== undefined && item.exitCode !== 0);
    const outputText = item.aggregatedOutput ?? this.commandOutput.get(item.id) ?? "";
    const output = { aggregated_output: outputText, exit_code: item.exitCode };
    const events = this.completeSimpleToolPart(
      item.id,
      isError ? outputText || output : output,
      isError
    );
    this.commandOutput.delete(item.id);
    return events;
  }

  private handleCommandOutputDelta(itemId: string, delta: string): PartEvent[] {
    this.commandOutput.set(itemId, (this.commandOutput.get(itemId) ?? "") + delta);
    return [];
  }

  private startFileChangePart(item: Extract<CodexThreadItem, { type: "fileChange" }>): PartEvent[] {
    const paths = item.changes.map((change) => change.path);
    return startFileChangeToolPart(this.eventCtx(), this.partMaps(), {
      itemId: item.id,
      changes: item.changes,
      paths,
    });
  }

  private completeFileChangePart(
    item: Extract<CodexThreadItem, { type: "fileChange" }>
  ): PartEvent[] {
    const isError = item.status === "failed" || item.status === "declined";
    const content: DiffContent[] = item.changes.map((change) => ({
      type: "diff",
      path: change.path,
      newText:
        change.diff || this.fileChangeOutput.get(item.id) || `${change.kind.type}: ${change.path}`,
    }));

    const events = this.completeSimpleToolPart(
      item.id,
      { changes: item.changes },
      isError,
      content
    );
    this.fileChangeOutput.delete(item.id);
    return events;
  }

  private handleFileChangeOutputDelta(itemId: string, delta: string): PartEvent[] {
    this.fileChangeOutput.set(itemId, (this.fileChangeOutput.get(itemId) ?? "") + delta);
    return [];
  }

  private startMcpPart(item: Extract<CodexThreadItem, { type: "mcpToolCall" }>): PartEvent[] {
    return startMcpToolPart(this.eventCtx(), this.partMaps(), {
      itemId: item.id,
      server: item.server,
      tool: item.tool,
      input: item.arguments,
    });
  }

  private completeMcpPart(item: Extract<CodexThreadItem, { type: "mcpToolCall" }>): PartEvent[] {
    const isError = item.status === "failed" || !!item.error;
    return this.completeSimpleToolPart(
      item.id,
      isError ? (item.error?.message ?? "Unknown MCP error") : item.result,
      isError
    );
  }

  private startDynamicToolPart(
    item: Extract<CodexThreadItem, { type: "dynamicToolCall" }>
  ): PartEvent[] {
    const toolName = item.namespace ? `${item.namespace}/${item.tool}` : item.tool;
    const ctx = this.eventCtx();
    const part = createToolPart(ctx.sessionId, ctx.messageId, {
      toolCallId: item.id,
      toolName,
      kind: "other",
      state: {
        status: "RUNNING",
        input: item.arguments,
        title: item.tool,
        time: { start: new Date().toISOString() },
      } satisfies RunningToolState,
    });
    part.title = item.tool;
    this.parts.set(part.id, part);
    this.itemParts.set(item.id, part.id);
    return [{ type: "part.created", part }];
  }

  private completeDynamicToolPart(
    item: Extract<CodexThreadItem, { type: "dynamicToolCall" }>
  ): PartEvent[] {
    return this.completeSimpleToolPart(
      item.id,
      item.contentItems ?? { success: item.success },
      item.status === "failed" || item.success === false
    );
  }

  private startCollabAgentPart(
    item: Extract<CodexThreadItem, { type: "collabAgentToolCall" }>
  ): PartEvent[] {
    this.rememberSpawnReceivers(item);
    const toolName = CODEX_COLLAB_TOOL_NAMES[item.tool];
    const receiverThreadId = item.receiverThreadIds[0];
    const description = readString(item.prompt);
    const model = readString(item.model);
    const ctx = this.eventCtx();
    const part = createToolPart(ctx.sessionId, ctx.messageId, {
      toolCallId: item.id,
      toolName,
      kind: item.tool === "spawnAgent" ? "task" : "other",
      state: {
        status: "RUNNING",
        input: {
          prompt: item.prompt,
          receiverThreadIds: item.receiverThreadIds,
          agentsStates: item.agentsStates,
        },
        title: toolName,
        time: { start: new Date().toISOString() },
      } satisfies RunningToolState,
      subagent:
        item.tool === "spawnAgent"
          ? {
              type: "codex",
              ...(description ? { description } : {}),
              ...(model ? { model } : {}),
              ...(receiverThreadId ? { agentId: receiverThreadId } : {}),
            }
          : undefined,
    });
    part.title = toolName;
    this.parts.set(part.id, part);
    this.itemParts.set(item.id, part.id);
    return [{ type: "part.created", part }];
  }

  private completeCollabAgentPart(
    item: Extract<CodexThreadItem, { type: "collabAgentToolCall" }>
  ): PartEvent[] {
    this.rememberSpawnReceivers(item);
    const agentResults = this.toAgentResultContent(item);
    const events = this.completeSimpleToolPart(
      item.id,
      { receiverThreadIds: item.receiverThreadIds, agentsStates: item.agentsStates },
      item.status === "failed",
      agentResults.length > 0 ? agentResults : undefined
    );
    if (item.tool === "wait") {
      events.push(...this.createAgentResultMessages(item, agentResults));
    }
    return events;
  }

  private startWebSearchPart(item: Extract<CodexThreadItem, { type: "webSearch" }>): PartEvent[] {
    const ctx = this.eventCtx();
    const part = createToolPart(ctx.sessionId, ctx.messageId, {
      toolCallId: item.id,
      toolName: "web_search",
      kind: "search",
      state: {
        status: "RUNNING",
        input: { query: item.query },
        title: item.query,
        time: { start: new Date().toISOString() },
      } satisfies RunningToolState,
    });
    part.title = item.query;
    this.parts.set(part.id, part);
    this.itemParts.set(item.id, part.id);
    return [{ type: "part.created", part }];
  }

  private createCompactionPart(itemId: string): PartEvent[] {
    const ctx = this.eventCtx();
    const part = createCompactionPart(ctx.sessionId, ctx.messageId, true);
    this.parts.set(part.id, part);
    this.itemParts.set(itemId, part.id);
    return [{ type: "part.created", part }];
  }

  private completeSimpleToolPart(
    itemId: string,
    output: unknown,
    isError: boolean,
    content?: ToolOutputContent[]
  ): PartEvent[] {
    return completeTrackedToolPart(this.partMaps(), itemId, output, isError, content);
  }

  private finalizeStreamingParts(messageId?: string): PartEvent[] {
    const events: PartEvent[] = [];
    for (const part of this.parts.values()) {
      if (messageId && part.messageId !== messageId) continue;

      if (part.type === "TEXT" && part.state === "STREAMING") {
        const done: Part = { ...part, state: "DONE" };
        this.parts.set(part.id, done);
        events.push({ type: "part.done", part: done });
      } else if (part.type === "REASONING" && part.state === "STREAMING") {
        const done = completeReasoningPart(part);
        this.parts.set(part.id, done);
        events.push({ type: "part.done", part: done });
      }
    }
    return events;
  }

  private reasoningText(item: Extract<CodexThreadItem, { type: "reasoning" }>): string {
    return [...item.summary, ...item.content].join("\n");
  }

  private partMaps() {
    return { parts: this.parts, itemParts: this.itemParts };
  }

  private eventCtx(): StreamContext {
    return {
      ...this.ctx,
      messageId: this.eventMessageId(),
    };
  }

  private eventMessageId(): string {
    const subagent = this.subagentMessageForThread(this.currentThreadId);
    return subagent?.messageId ?? this.ctx.messageId;
  }

  private currentParentToolCallId(): string | undefined {
    return this.subagentMessageForThread(this.currentThreadId)?.parentToolCallId;
  }

  private subagentMessageForThread(
    threadId: string | undefined
  ): { messageId: string; parentToolCallId: string; done: boolean } | undefined {
    if (!threadId) return undefined;
    return this.subagentMessages.get(threadId);
  }

  private ensureSubagentMessage(threadId: string | undefined): PartEvent[] {
    if (!threadId) return [];
    const parentToolCallId = this.receiverThreadToSpawnToolCallId.get(threadId);
    if (!parentToolCallId) return [];

    const existing = this.subagentMessages.get(threadId);
    if (existing) return [];

    const messageId = uuidv7();
    this.subagentMessages.set(threadId, { messageId, parentToolCallId, done: false });
    return [{ type: "message.created", messageId, role: "assistant", parentToolCallId }];
  }

  private closeSubagentMessage(stopReason: FinishReason): PartEvent[] {
    const threadId = this.currentThreadId;
    const subagent = this.subagentMessageForThread(threadId);
    if (!threadId || !subagent || subagent.done) return [];

    subagent.done = true;
    return [
      ...this.finalizeStreamingParts(subagent.messageId),
      {
        type: "message.done",
        messageId: subagent.messageId,
        stopReason,
        parts: this.partsForMessage(subagent.messageId),
        parentToolCallId: subagent.parentToolCallId,
      },
    ];
  }

  private partsForMessage(messageId: string): Part[] {
    return Array.from(this.parts.values()).filter((part) => part.messageId === messageId);
  }

  private tagSubagentEvents(threadId: string | undefined, events: PartEvent[]): PartEvent[] {
    const parentToolCallId = this.subagentMessageForThread(threadId)?.parentToolCallId;
    if (!parentToolCallId) return events;

    return events.map((event) => {
      if (event.type !== "part.created" && event.type !== "part.done") return event;

      const tagged = { ...event.part, parentToolCallId } as Part;
      this.parts.set(tagged.id, tagged);
      return { ...event, part: tagged } as PartEvent;
    });
  }

  private rememberSpawnReceivers(
    item: Extract<CodexThreadItem, { type: "collabAgentToolCall" }>
  ): void {
    if (item.tool !== "spawnAgent") return;
    for (const receiverThreadId of item.receiverThreadIds) {
      this.receiverThreadToSpawnToolCallId.set(receiverThreadId, item.id);
    }
  }

  private toAgentResultContent(
    item: Extract<CodexThreadItem, { type: "collabAgentToolCall" }>
  ): AgentResultContent[] {
    return Object.entries(item.agentsStates).map(([agentId, rawState]) => {
      const state = asRecord(rawState);
      const label = readString(state?.agentNickname) ?? readString(state?.agentRole);
      const message = readAgentMessage(rawState);
      return {
        type: "agent_result",
        agentId,
        status: normalizeAgentStatus(readString(state?.status)),
        ...(label ? { label } : {}),
        ...(message ? { message } : {}),
      };
    });
  }

  private createAgentResultMessages(
    item: Extract<CodexThreadItem, { type: "collabAgentToolCall" }>,
    agentResults: AgentResultContent[]
  ): PartEvent[] {
    const events: PartEvent[] = [];
    for (const result of agentResults) {
      if (!result.agentId || !result.message) continue;

      const parentToolCallId = this.receiverThreadToSpawnToolCallId.get(result.agentId);
      if (!parentToolCallId) continue;
      if (this.subagentMessages.has(result.agentId)) continue;

      const key = `${item.id}:${result.agentId}`;
      if (this.emittedAgentResultMessages.has(key)) continue;
      this.emittedAgentResultMessages.add(key);

      const messageId = uuidv7();
      const part = createTextPart(this.ctx.sessionId, messageId, result.message, "DONE");
      part.parentToolCallId = parentToolCallId;

      events.push(
        { type: "message.created", messageId, role: "assistant", parentToolCallId },
        { type: "part.done", part },
        {
          type: "message.done",
          messageId,
          stopReason: result.status === "failed" ? "error" : "end_turn",
          parts: [part],
          parentToolCallId,
        }
      );
    }
    return events;
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function notificationThreadId(notification: CodexAppServerNotification): string | undefined {
  const params = notification.params;
  if (!params || typeof params !== "object" || !("threadId" in params)) return undefined;
  const threadId = (params as { threadId?: unknown }).threadId;
  return typeof threadId === "string" ? threadId : undefined;
}

function readAgentMessage(value: unknown): string | undefined {
  const state = asRecord(value);
  if (!state) return undefined;

  const direct = readString(state.message) ?? readString(state.summary) ?? readString(state.output);
  if (direct) return direct;

  const error = state.error;
  if (typeof error === "string") return error;
  const errorRecord = asRecord(error);
  return readString(errorRecord?.message);
}

function normalizeAgentStatus(value: string | undefined): AgentResultContent["status"] {
  switch (value) {
    case "pending":
    case "pendingInit":
      return "pending";
    case "running":
      return "running";
    case "completed":
      return "completed";
    case "interrupted":
    case "cancelled":
    case "shutdown":
      return "cancelled";
    case "errored":
    case "failed":
    case "notFound":
      return "failed";
    default:
      return "completed";
  }
}

export const codexAppServerAdapter: Adapter<CodexAppServerNotification> = {
  id: "codex-app-server",
  createTransformer(ctx: StreamContext) {
    return new CodexAppServerTransformer(ctx);
  },
};
