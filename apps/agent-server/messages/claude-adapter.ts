// agent-server/messages/claude-adapter.ts
// Transforms raw Claude Code SDK events into PartEvents.
//
// Handles both streaming (content_block_start/delta/stop) and non-streaming
// (complete assistant messages) paths. Tracks subagent contexts via
// parent_tool_use_id for Task tool calls.

import type {
  FinishReason,
  Part,
  ReasoningPart,
  RunningToolState,
  SubagentMetadata,
  TextPart,
  TokenUsage,
  ToolPart,
} from "@shared/messages";
import { addTokenUsage, emptyTokenUsage } from "@shared/messages";
import type { Adapter, EventTransformer, PartEvent, StreamContext } from "./adapter";
import type {
  ClaudeAssistantEvent,
  ClaudeCodeEvent,
  ClaudeContentBlock,
  ClaudeDelta,
  ClaudeRawStreamEvent,
  ClaudeResultEvent,
  ClaudeStreamEvent,
  ClaudeSystemEvent,
  ClaudeToolResultBlock,
  ClaudeUsage,
  ClaudeUserEvent,
} from "./claude-events";
import {
  completeReasoningPart,
  completeToolPart,
  createCompactionPart,
  createPendingToolPart,
  createReasoningPart,
  createTextPart,
  createToolPart,
  startToolPart,
} from "./parts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mapResultSubtype(subtype: ClaudeResultEvent["subtype"], isError?: boolean): FinishReason {
  switch (subtype) {
    case "success":
      return isError ? "error" : "end_turn";
    case "error_max_turns":
      return "max_turns";
    case "error_during_execution":
      return "error";
  }
}

function mapSdkUsage(u: ClaudeUsage): TokenUsage {
  return {
    input: u.input_tokens,
    output: u.output_tokens,
    cacheRead: u.cache_read_input_tokens,
    cacheCreation:
      u.cache_creation_input_tokens != null ? { total: u.cache_creation_input_tokens } : undefined,
  };
}

function extractSubagentMetadata(input: Record<string, unknown>): SubagentMetadata {
  return {
    type: typeof input.subagent_type === "string" ? input.subagent_type : "unknown",
    description: typeof input.description === "string" ? input.description : undefined,
    model: typeof input.model === "string" ? input.model : undefined,
  };
}

/** Both "Task" and "Agent" tool names spawn subagents in Claude Code. */
function isSubagentTool(toolName: string): boolean {
  return toolName === "Task" || toolName === "Agent";
}

/** Wrap a Part in a PartEvent. */
function created(part: Part): PartEvent {
  return { type: "part.created", part };
}
function partDone(part: Part): PartEvent {
  return { type: "part.done", part };
}

// ---------------------------------------------------------------------------
// Subagent context tracking
// ---------------------------------------------------------------------------

interface SubagentContext {
  toolCallId: string;
  toolPartId: string;
  subagentType: string;
  hasReceivedResult: boolean;
}

// ---------------------------------------------------------------------------
// Claude Code Transformer
// ---------------------------------------------------------------------------

class ClaudeCodeTransformer implements EventTransformer<ClaudeCodeEvent> {
  private ctx: StreamContext;
  private parts: Part[] = [];
  private toolParts = new Map<string, ToolPart>();
  private toolInputBuffers = new Map<string, string>();
  private blockIndexToToolId = new Map<number, string>();

  private currentTextPart: TextPart | null = null;
  private currentThinkingPart: ReasoningPart | null = null;

  private accumulatedUsage: TokenUsage = { ...emptyTokenUsage };
  private resultUsage: TokenUsage = { ...emptyTokenUsage };
  private hasReceivedStreamEvents = false;
  private totalCostUsd: number | undefined;
  private lastFinishReason: FinishReason | undefined;
  private turnCompletedEmitted = false;

  // Message lifecycle tracking
  private currentMessageId: string | null = null;
  private messagePartsStart = 0; // index into this.parts when message opened
  private messageCounter = 0;

  /** Next part index within the current message. */
  private get nextPartIndex(): number {
    return this.parts.length - this.messagePartsStart;
  }

  /** Current message ID (with suffix). Falls back to base if no message opened yet. */
  private get activeMessageId(): string {
    return this.currentMessageId ?? this.ctx.messageId;
  }

  private activeSubagents = new Map<string, SubagentContext>();
  private lastParentToolCallId: string | undefined;
  /** Usage data from task_notification events, keyed by tool_use_id */
  private taskUsage = new Map<string, Record<string, unknown>>();

  constructor(ctx: StreamContext) {
    this.ctx = ctx;
  }

  process(event: ClaudeCodeEvent): PartEvent[] {
    const parentToolCallId = this.extractParentToolCallId(event);

    if (parentToolCallId !== this.lastParentToolCallId) {
      this.closeText();
      this.closeThinking();
      this.lastParentToolCallId = parentToolCallId;
    }

    let emitted: PartEvent[] = [];
    switch (event.type) {
      case "system":
        return this.handleSystem(event);
      case "user":
        emitted = this.handleUser(event);
        break;
      case "assistant":
        emitted = this.handleAssistant(event);
        break;
      case "stream_event":
        emitted = this.handleStream(event);
        break;
      case "result":
        return this.handleResult(event);
      default:
        return [];
    }

    if (parentToolCallId) {
      emitted = this.applyParentTag(emitted, parentToolCallId);
    }

    return emitted;
  }

  finish(): { events: PartEvent[]; parts: Part[]; usage: TokenUsage; cost?: number } {
    const events: PartEvent[] = [];

    const doneText = this.closeText();
    if (doneText) events.push(doneText);
    const doneThinking = this.closeThinking();
    if (doneThinking) events.push(doneThinking);

    const usage = this.resultUsage.input > 0 ? this.resultUsage : this.accumulatedUsage;

    // Emit turn.completed if not already emitted during process()
    if (!this.turnCompletedEmitted) {
      events.push({
        type: "turn.completed",
        turnId: this.ctx.turnId,
        finishReason: this.lastFinishReason,
        tokens: usage,
        cost: this.totalCostUsd,
      });
    }

    return { events, parts: this.getParts(), usage, cost: this.totalCostUsd };
  }

  getParts(): Part[] {
    return [...this.parts];
  }

  // -------------------------------------------------------------------------
  // Parent tool call ID extraction
  // -------------------------------------------------------------------------

  private extractParentToolCallId(event: ClaudeCodeEvent): string | undefined {
    switch (event.type) {
      case "user":
      case "assistant":
      case "stream_event":
        return event.parent_tool_use_id ?? undefined;
      default:
        return undefined;
    }
  }

  // -------------------------------------------------------------------------
  // Subagent part tagging
  // -------------------------------------------------------------------------

  private applyParentTag(events: PartEvent[], parentToolCallId: string): PartEvent[] {
    return events.map((evt) => {
      if (evt.type !== "part.created" && evt.type !== "part.done") return evt;

      const part = evt.part;
      const tagged = { ...part, parentToolCallId } as Part;

      const idx = this.parts.findIndex((p) => p.id === part.id);
      if (idx !== -1) this.parts[idx] = tagged;

      if (tagged.type === "TOOL") this.toolParts.set(tagged.toolCallId, tagged);
      if (tagged.type === "TEXT" && this.currentTextPart?.id === tagged.id)
        this.currentTextPart = tagged;
      if (tagged.type === "REASONING" && this.currentThinkingPart?.id === tagged.id)
        this.currentThinkingPart = tagged;

      return { ...evt, part: tagged } as PartEvent;
    });
  }

  // -------------------------------------------------------------------------
  // Subagent lifecycle
  // -------------------------------------------------------------------------

  private registerSubagent(toolCallId: string, toolPartId: string, subagentType: string): void {
    this.activeSubagents.set(toolCallId, {
      toolCallId,
      toolPartId,
      subagentType,
      hasReceivedResult: false,
    });
  }

  private unregisterSubagent(toolCallId: string): void {
    this.activeSubagents.delete(toolCallId);
  }

  // -------------------------------------------------------------------------
  // Top-level event handlers
  // -------------------------------------------------------------------------

  private handleUser(event: ClaudeUserEvent): PartEvent[] {
    const events: PartEvent[] = [];
    if (typeof event.message.content === "string") return events;

    for (const block of event.message.content) {
      if (block.type !== "tool_result") continue;
      const tr = block as ClaudeToolResultBlock;
      const existing = this.toolParts.get(tr.tool_use_id);
      if (!existing) continue;

      const output = typeof tr.content === "string" ? tr.content : JSON.stringify(tr.content);
      const metadata = this.taskUsage.get(tr.tool_use_id);
      const updated = completeToolPart(existing, output, tr.is_error ?? false, metadata);
      this.replacePart(existing, updated);
      this.toolParts.set(tr.tool_use_id, updated);
      events.push(partDone(updated));

      if (this.activeSubagents.has(tr.tool_use_id)) {
        this.unregisterSubagent(tr.tool_use_id);
        this.taskUsage.delete(tr.tool_use_id);
      }
    }

    return events;
  }

  private handleAssistant(event: ClaudeAssistantEvent): PartEvent[] {
    // Skip non-streaming assistant events when we're in streaming mode —
    // EXCEPT for subagent responses which always arrive as complete assistant events.
    const isSubagentResponse = !!event.parent_tool_use_id;
    if (this.hasReceivedStreamEvents && !isSubagentResponse) return [];

    const events: PartEvent[] = [this.openMessage()];
    for (const block of event.message.content) {
      const part = this.processContentBlock(block);
      if (part) events.push(part);
    }

    if (event.message.usage) {
      this.accumulatedUsage = addTokenUsage(
        this.accumulatedUsage,
        mapSdkUsage(event.message.usage)
      );
    }

    const msgDone = this.closeMessage((event.message as any).stop_reason ?? undefined);
    if (msgDone) events.push(msgDone);

    return events;
  }

  private handleStream(event: ClaudeStreamEvent): PartEvent[] {
    this.hasReceivedStreamEvents = true;
    return this.processStreamEvent(event.event);
  }

  private handleResult(event: ClaudeResultEvent): PartEvent[] {
    const events: PartEvent[] = [];
    const doneText = this.closeText();
    if (doneText) events.push(doneText);
    const doneThinking = this.closeThinking();
    if (doneThinking) events.push(doneThinking);

    if (event.usage) {
      this.resultUsage = mapSdkUsage(event.usage);
    }
    if (event.total_cost_usd != null) {
      this.totalCostUsd = event.total_cost_usd;
    }

    const usage = this.resultUsage.input > 0 ? this.resultUsage : this.accumulatedUsage;
    const finishReason = mapResultSubtype(event.subtype, event.is_error);
    this.lastFinishReason = finishReason;

    const activeCount = this.activeSubagents.size;
    if (activeCount >= 2) return events;

    if (activeCount === 1) {
      const ctx = [...this.activeSubagents.values()][0]!;
      if (!ctx.hasReceivedResult) {
        ctx.hasReceivedResult = true;
        // Subagent result — don't emit turn.completed, it belongs to the parent
        return events;
      }
    }

    this.turnCompletedEmitted = true;
    events.push({
      type: "turn.completed",
      turnId: this.ctx.turnId,
      finishReason,
      tokens: usage,
      cost: this.totalCostUsd,
    });
    return events;
  }

  // -------------------------------------------------------------------------
  // System event handling
  // -------------------------------------------------------------------------

  private handleSystem(event: ClaudeSystemEvent): PartEvent[] {
    if (event.subtype === "compact_boundary") {
      this.closeText();
      this.closeThinking();
      const auto = event.compact_metadata.trigger === "auto";
      const part = createCompactionPart(
        this.ctx.sessionId,
        this.activeMessageId,
        auto,
        event.compact_metadata.pre_tokens,
        this.nextPartIndex
      );
      this.parts.push(part);
      return [created(part), partDone(part)];
    }

    // Task lifecycle events — update the corresponding tool part with progress info
    if (event.subtype === "task_started" || event.subtype === "task_progress") {
      const toolPart = this.toolParts.get(event.tool_use_id);
      if (toolPart && toolPart.state.status === "RUNNING") {
        const updated: ToolPart = {
          ...toolPart,
          state: {
            ...toolPart.state,
            title: event.description,
          },
        };
        this.replacePart(toolPart, updated);
        this.toolParts.set(event.tool_use_id, updated);
        return [created(updated)];
      }
    }

    // task_notification — stash usage data so it can be attached when the tool result arrives
    if (event.subtype === "task_notification" && event.usage) {
      this.taskUsage.set(event.tool_use_id, {
        totalTokens: event.usage.total_tokens,
        toolUses: event.usage.tool_uses,
        durationMs: event.usage.duration_ms,
      });
    }

    return [];
  }

  // -------------------------------------------------------------------------
  // Content block processing (non-streaming path)
  // -------------------------------------------------------------------------

  private processContentBlock(block: ClaudeContentBlock): PartEvent | null {
    switch (block.type) {
      case "text": {
        this.closeThinking();
        if (this.currentTextPart) {
          const updated: TextPart = {
            ...this.currentTextPart,
            text: this.currentTextPart.text + block.text,
          };
          this.replacePart(this.currentTextPart, updated);
          this.currentTextPart = updated;
          return partDone(updated);
        }
        const part = createTextPart(
          this.ctx.sessionId,
          this.activeMessageId,
          block.text,
          "DONE",
          this.nextPartIndex
        );
        this.parts.push(part);
        this.currentTextPart = part;
        return partDone(part);
      }

      case "thinking": {
        this.closeText();
        if (this.currentThinkingPart) {
          const updated = completeReasoningPart(
            this.currentThinkingPart,
            this.currentThinkingPart.text + block.thinking
          );
          this.replacePart(this.currentThinkingPart, updated);
          this.currentThinkingPart = updated;
          return partDone(updated);
        }
        const part = createReasoningPart(
          this.ctx.sessionId,
          this.activeMessageId,
          block.thinking,
          "DONE",
          this.nextPartIndex
        );
        this.parts.push(part);
        this.currentThinkingPart = part;
        return partDone(part);
      }

      case "tool_use": {
        this.closeText();
        this.closeThinking();
        const isAgent = isSubagentTool(block.name);
        const part = createToolPart(this.ctx.sessionId, this.activeMessageId, {
          toolCallId: block.id,
          toolName: block.name,
          kind: isAgent ? "task" : undefined,
          partIndex: this.nextPartIndex,
          state: {
            status: "RUNNING",
            input: block.input,
            time: { start: new Date().toISOString() },
          } satisfies RunningToolState,
          subagent: isAgent ? extractSubagentMetadata(block.input) : undefined,
        });
        this.parts.push(part);
        this.toolParts.set(block.id, part);

        if (isAgent) {
          this.registerSubagent(block.id, part.id, part.subagent?.type ?? "unknown");
        }

        return created(part);
      }
    }
  }

  // -------------------------------------------------------------------------
  // Stream event processing
  // -------------------------------------------------------------------------

  private processStreamEvent(event: ClaudeRawStreamEvent): PartEvent[] {
    switch (event.type) {
      case "content_block_start":
        return this.onBlockStart(event);
      case "content_block_delta":
        return this.onBlockDelta(event);
      case "content_block_stop":
        return this.onBlockStop(event);
      case "message_start":
        return this.onMessageStart(event);
      case "message_delta":
        return this.onMessageDelta(event);
      case "message_stop":
        return this.onMessageStop();
    }
  }

  private onBlockStart(
    event: Extract<ClaudeRawStreamEvent, { type: "content_block_start" }>
  ): PartEvent[] {
    const block = event.content_block;
    if (block.type === "tool_use") {
      this.closeText();
      this.closeThinking();
      const part = createPendingToolPart(
        this.ctx.sessionId,
        this.activeMessageId,
        block.id,
        block.name,
        this.nextPartIndex
      );
      this.parts.push(part);
      this.toolParts.set(block.id, part);
      this.toolInputBuffers.set(block.id, "");
      this.blockIndexToToolId.set(event.index, block.id);
      return [created(part)];
    }
    return [];
  }

  private onBlockDelta(
    event: Extract<ClaudeRawStreamEvent, { type: "content_block_delta" }>
  ): PartEvent[] {
    const delta: ClaudeDelta = event.delta;
    switch (delta.type) {
      case "text_delta": {
        const closed: PartEvent[] = [];
        const dt = this.closeThinking();
        if (dt) closed.push(dt);

        if (this.currentTextPart) {
          const accumulated: TextPart = {
            ...this.currentTextPart,
            text: this.currentTextPart.text + delta.text,
            state: "STREAMING",
          };
          this.replacePart(this.currentTextPart, accumulated);
          this.currentTextPart = accumulated;
          return [...closed, { type: "part.delta", partId: accumulated.id, delta: delta.text }];
        }
        const part = createTextPart(
          this.ctx.sessionId,
          this.activeMessageId,
          delta.text,
          "STREAMING",
          this.nextPartIndex
        );
        this.parts.push(part);
        this.currentTextPart = part;
        return [...closed, created(part)];
      }

      case "thinking_delta": {
        const closed: PartEvent[] = [];
        const dt = this.closeText();
        if (dt) closed.push(dt);

        if (this.currentThinkingPart) {
          const accumulated: ReasoningPart = {
            ...this.currentThinkingPart,
            text: this.currentThinkingPart.text + delta.thinking,
            state: "STREAMING",
          };
          this.replacePart(this.currentThinkingPart, accumulated);
          this.currentThinkingPart = accumulated;
          return [...closed, { type: "part.delta", partId: accumulated.id, delta: delta.thinking }];
        }
        const part = createReasoningPart(
          this.ctx.sessionId,
          this.activeMessageId,
          delta.thinking,
          "STREAMING",
          this.nextPartIndex
        );
        this.parts.push(part);
        this.currentThinkingPart = part;
        return [...closed, created(part)];
      }

      case "input_json_delta": {
        const toolId = this.blockIndexToToolId.get(event.index);
        if (!toolId) return [];
        this.toolInputBuffers.set(
          toolId,
          (this.toolInputBuffers.get(toolId) ?? "") + delta.partial_json
        );
        return [];
      }

      case "signature_delta":
        return [];
    }
  }

  private onBlockStop(
    event: Extract<ClaudeRawStreamEvent, { type: "content_block_stop" }>
  ): PartEvent[] {
    const closed: PartEvent[] = [];
    const dt = this.closeText();
    if (dt) closed.push(dt);
    const dr = this.closeThinking();
    if (dr) closed.push(dr);

    const toolId = this.blockIndexToToolId.get(event.index);
    if (toolId) {
      const existing = this.toolParts.get(toolId);
      if (existing) {
        const buffer = this.toolInputBuffers.get(toolId) ?? "{}";
        let input: Record<string, unknown>;
        try {
          input = JSON.parse(buffer);
        } catch {
          input = { _raw: buffer };
        }

        let updated = startToolPart(existing, input);

        if (isSubagentTool(existing.toolName)) {
          const subagent = extractSubagentMetadata(input);
          updated = { ...updated, kind: "task", subagent } as ToolPart;
          this.registerSubagent(toolId, updated.id, subagent.type);
        }

        this.replacePart(existing, updated);
        this.toolParts.set(toolId, updated);
        this.toolInputBuffers.delete(toolId);
        this.blockIndexToToolId.delete(event.index);
        return [...closed, created(updated)];
      }
    }

    return closed;
  }

  private onMessageStart(
    event: Extract<ClaudeRawStreamEvent, { type: "message_start" }>
  ): PartEvent[] {
    if (event.message.usage) {
      this.accumulatedUsage = addTokenUsage(
        this.accumulatedUsage,
        mapSdkUsage(event.message.usage)
      );
    }
    return [this.openMessage()];
  }

  private onMessageDelta(
    event: Extract<ClaudeRawStreamEvent, { type: "message_delta" }>
  ): PartEvent[] {
    if (event.usage?.output_tokens) {
      this.accumulatedUsage = addTokenUsage(this.accumulatedUsage, {
        input: 0,
        output: event.usage.output_tokens,
      });
    }
    return [];
  }

  private onMessageStop(): PartEvent[] {
    const events: PartEvent[] = [];
    const dt = this.closeText();
    if (dt) events.push(dt);
    const dr = this.closeThinking();
    if (dr) events.push(dr);
    const msgDone = this.closeMessage();
    if (msgDone) events.push(msgDone);
    return events;
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  /** Open a new assistant message, returning a message.created event. */
  private openMessage(): PartEvent {
    this.messageCounter++;
    this.currentMessageId = `${this.ctx.messageId}-${this.messageCounter}`;
    this.messagePartsStart = this.parts.length;
    const evt: PartEvent = {
      type: "message.created",
      messageId: this.currentMessageId,
      role: "assistant",
    };
    if (this.lastParentToolCallId) {
      evt.parentToolCallId = this.lastParentToolCallId;
    }
    return evt;
  }

  /** Close the current message, returning a message.done event with accumulated parts. */
  private closeMessage(stopReason?: string): PartEvent | null {
    if (!this.currentMessageId) return null;
    const msgParts = this.parts.slice(this.messagePartsStart);
    const evt: PartEvent = {
      type: "message.done",
      messageId: this.currentMessageId,
      stopReason,
      parts: msgParts,
    };
    if (this.lastParentToolCallId) {
      evt.parentToolCallId = this.lastParentToolCallId;
    }
    this.currentMessageId = null;
    return evt;
  }

  private closeText(): PartEvent | null {
    if (!this.currentTextPart) return null;
    if (this.currentTextPart.state === "STREAMING") {
      const donePart: TextPart = { ...this.currentTextPart, state: "DONE" };
      this.replacePart(this.currentTextPart, donePart);
      this.currentTextPart = null;
      return partDone(donePart);
    }
    this.currentTextPart = null;
    return null;
  }

  private closeThinking(): PartEvent | null {
    if (!this.currentThinkingPart) return null;
    if (this.currentThinkingPart.state === "STREAMING") {
      const donePart = completeReasoningPart(this.currentThinkingPart);
      this.replacePart(this.currentThinkingPart, donePart);
      this.currentThinkingPart = null;
      return partDone(donePart);
    }
    this.currentThinkingPart = null;
    return null;
  }

  private replacePart(old: Part, next: Part): void {
    const i = this.parts.indexOf(old);
    if (i !== -1) this.parts[i] = next;
  }
}

// ---------------------------------------------------------------------------
// Adapter export
// ---------------------------------------------------------------------------

export const claudeCodeAdapter: Adapter<ClaudeCodeEvent> = {
  id: "claude-code",
  createTransformer(ctx: StreamContext) {
    return new ClaudeCodeTransformer(ctx);
  },
};
