// agent-server/messages/claude-adapter.ts
// Transforms raw Claude Code SDK events into unified Parts.
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
import type { Adapter, EventTransformer, StreamContext } from "./adapter";
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
  appendToolInput,
  completeToolPart,
  createCompactionPart,
  createPendingToolPart,
  createReasoningPart,
  createStepFinishPart,
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
    model: typeof input.model === "string" ? input.model : undefined,
  };
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

  private activeSubagents = new Map<string, SubagentContext>();
  private lastParentToolCallId: string | undefined;

  constructor(ctx: StreamContext) {
    this.ctx = ctx;
  }

  process(event: ClaudeCodeEvent): Part[] {
    const parentToolCallId = this.extractParentToolCallId(event);

    if (parentToolCallId !== this.lastParentToolCallId) {
      this.closeText();
      this.closeThinking();
      this.lastParentToolCallId = parentToolCallId;
    }

    let emitted: Part[];
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
    }

    if (parentToolCallId) {
      emitted = this.applyParentTag(emitted, parentToolCallId);
    }

    return emitted;
  }

  finish(): { parts: Part[]; usage: TokenUsage; cost?: number; finishReason?: FinishReason } {
    this.closeText();
    this.closeThinking();
    const usage = this.resultUsage.input > 0 ? this.resultUsage : this.accumulatedUsage;
    return {
      parts: this.getParts(),
      usage,
      cost: this.totalCostUsd,
      finishReason: this.lastFinishReason,
    };
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

  private applyParentTag(parts: Part[], parentToolCallId: string): Part[] {
    return parts.map((part) => {
      const tagged = { ...part, parentToolCallId } as Part;

      const idx = this.parts.findIndex((p) => p.id === part.id);
      if (idx !== -1) this.parts[idx] = tagged;

      if (tagged.type === "TOOL") {
        this.toolParts.set(tagged.toolCallId, tagged);
      }
      if (tagged.type === "TEXT" && this.currentTextPart?.id === tagged.id) {
        this.currentTextPart = tagged;
      }
      if (tagged.type === "REASONING" && this.currentThinkingPart?.id === tagged.id) {
        this.currentThinkingPart = tagged;
      }

      return tagged;
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

  private handleUser(event: ClaudeUserEvent): Part[] {
    const changed: Part[] = [];
    if (typeof event.message.content === "string") return changed;

    for (const block of event.message.content) {
      if (block.type !== "tool_result") continue;
      const tr = block as ClaudeToolResultBlock;
      const existing = this.toolParts.get(tr.tool_use_id);
      if (!existing) continue;

      const output = typeof tr.content === "string" ? tr.content : JSON.stringify(tr.content);
      const updated = completeToolPart(existing, output, tr.is_error ?? false);
      this.replacePart(existing, updated);
      this.toolParts.set(tr.tool_use_id, updated);
      changed.push(updated);

      if (this.activeSubagents.has(tr.tool_use_id)) {
        this.unregisterSubagent(tr.tool_use_id);
      }
    }

    return changed;
  }

  private handleAssistant(event: ClaudeAssistantEvent): Part[] {
    if (this.hasReceivedStreamEvents) return [];

    const changed: Part[] = [];
    for (const block of event.message.content) {
      const part = this.processContentBlock(block);
      if (part) changed.push(part);
    }

    if (event.message.usage) {
      this.accumulatedUsage = addTokenUsage(
        this.accumulatedUsage,
        mapSdkUsage(event.message.usage)
      );
    }

    return changed;
  }

  private handleStream(event: ClaudeStreamEvent): Part[] {
    this.hasReceivedStreamEvents = true;
    return this.processStreamEvent(event.event);
  }

  private handleResult(event: ClaudeResultEvent): Part[] {
    this.closeText();
    this.closeThinking();

    if (event.usage) {
      this.resultUsage = mapSdkUsage(event.usage);
    }
    if (event.total_cost_usd != null) {
      this.totalCostUsd = event.total_cost_usd;
    }

    const activeCount = this.activeSubagents.size;
    if (activeCount >= 2) return [];

    const usage = this.resultUsage.input > 0 ? this.resultUsage : this.accumulatedUsage;
    const finishReason = mapResultSubtype(event.subtype, event.is_error);
    if (activeCount === 0) {
      this.lastFinishReason = finishReason;
    }

    const step = createStepFinishPart(this.ctx.sessionId, this.ctx.messageId, {
      finishReason,
      tokens: usage,
      cost: this.totalCostUsd,
    });

    if (activeCount === 1) {
      const ctx = [...this.activeSubagents.values()][0]!;
      if (!ctx.hasReceivedResult) {
        ctx.hasReceivedResult = true;
        const tagged = { ...step, parentToolCallId: ctx.toolCallId };
        this.parts.push(tagged);
        return [tagged];
      }
    }

    this.parts.push(step);
    return [step];
  }

  // -------------------------------------------------------------------------
  // System event handling
  // -------------------------------------------------------------------------

  private handleSystem(event: ClaudeSystemEvent): Part[] {
    if (event.subtype === "compact_boundary") {
      this.closeText();
      this.closeThinking();
      const auto = event.compact_metadata.trigger === "auto";
      const part = createCompactionPart(
        this.ctx.sessionId,
        this.ctx.messageId,
        auto,
        event.compact_metadata.pre_tokens
      );
      this.parts.push(part);
      return [part];
    }
    return [];
  }

  // -------------------------------------------------------------------------
  // Content block processing (non-streaming path)
  // -------------------------------------------------------------------------

  private processContentBlock(block: ClaudeContentBlock): Part | null {
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
          return updated;
        }
        const part = createTextPart(this.ctx.sessionId, this.ctx.messageId, block.text, "DONE");
        this.parts.push(part);
        this.currentTextPart = part;
        return part;
      }

      case "thinking": {
        this.closeText();
        if (this.currentThinkingPart) {
          const updated: ReasoningPart = {
            ...this.currentThinkingPart,
            text: this.currentThinkingPart.text + block.thinking,
          };
          this.replacePart(this.currentThinkingPart, updated);
          this.currentThinkingPart = updated;
          return updated;
        }
        const part = createReasoningPart(
          this.ctx.sessionId,
          this.ctx.messageId,
          block.thinking,
          "DONE"
        );
        this.parts.push(part);
        this.currentThinkingPart = part;
        return part;
      }

      case "tool_use": {
        this.closeText();
        this.closeThinking();
        const isTask = block.name === "Task";
        const part = createToolPart(this.ctx.sessionId, this.ctx.messageId, {
          toolCallId: block.id,
          toolName: block.name,
          kind: isTask ? "task" : undefined,
          state: {
            status: "RUNNING",
            input: block.input,
            time: { start: new Date().toISOString() },
          } satisfies RunningToolState,
          subagent: isTask ? extractSubagentMetadata(block.input) : undefined,
        });
        this.parts.push(part);
        this.toolParts.set(block.id, part);

        if (isTask) {
          this.registerSubagent(block.id, part.id, part.subagent?.type ?? "unknown");
        }

        return part;
      }
    }
  }

  // -------------------------------------------------------------------------
  // Stream event processing
  // -------------------------------------------------------------------------

  private processStreamEvent(event: ClaudeRawStreamEvent): Part[] {
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
  ): Part[] {
    const block = event.content_block;
    if (block.type === "tool_use") {
      this.closeText();
      this.closeThinking();
      const part = createPendingToolPart(
        this.ctx.sessionId,
        this.ctx.messageId,
        block.id,
        block.name
      );
      this.parts.push(part);
      this.toolParts.set(block.id, part);
      this.toolInputBuffers.set(block.id, "");
      this.blockIndexToToolId.set(event.index, block.id);
      return [part];
    }
    return [];
  }

  private onBlockDelta(
    event: Extract<ClaudeRawStreamEvent, { type: "content_block_delta" }>
  ): Part[] {
    const delta: ClaudeDelta = event.delta;
    switch (delta.type) {
      case "text_delta": {
        this.closeThinking();
        if (this.currentTextPart) {
          const updated: TextPart = {
            ...this.currentTextPart,
            text: this.currentTextPart.text + delta.text,
            state: "STREAMING",
          };
          this.replacePart(this.currentTextPart, updated);
          this.currentTextPart = updated;
          return [updated];
        }
        const part = createTextPart(
          this.ctx.sessionId,
          this.ctx.messageId,
          delta.text,
          "STREAMING"
        );
        this.parts.push(part);
        this.currentTextPart = part;
        return [part];
      }

      case "thinking_delta": {
        this.closeText();
        if (this.currentThinkingPart) {
          const updated: ReasoningPart = {
            ...this.currentThinkingPart,
            text: this.currentThinkingPart.text + delta.thinking,
            state: "STREAMING",
          };
          this.replacePart(this.currentThinkingPart, updated);
          this.currentThinkingPart = updated;
          return [updated];
        }
        const part = createReasoningPart(
          this.ctx.sessionId,
          this.ctx.messageId,
          delta.thinking,
          "STREAMING"
        );
        this.parts.push(part);
        this.currentThinkingPart = part;
        return [part];
      }

      case "input_json_delta": {
        const toolId = this.blockIndexToToolId.get(event.index);
        if (!toolId) return [];
        this.toolInputBuffers.set(
          toolId,
          (this.toolInputBuffers.get(toolId) ?? "") + delta.partial_json
        );
        const existing = this.toolParts.get(toolId);
        if (existing) {
          const updated = appendToolInput(existing, delta.partial_json);
          this.replacePart(existing, updated);
          this.toolParts.set(toolId, updated);
          return [updated];
        }
        return [];
      }

      case "signature_delta":
        return [];
    }
  }

  private onBlockStop(
    event: Extract<ClaudeRawStreamEvent, { type: "content_block_stop" }>
  ): Part[] {
    this.closeText();
    this.closeThinking();

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

        if (existing.toolName === "Task") {
          const subagent = extractSubagentMetadata(input);
          updated = { ...updated, kind: "task", subagent } as ToolPart;
          this.registerSubagent(toolId, updated.id, subagent.type);
        }

        this.replacePart(existing, updated);
        this.toolParts.set(toolId, updated);
        this.toolInputBuffers.delete(toolId);
        this.blockIndexToToolId.delete(event.index);
        return [updated];
      }
    }

    return [];
  }

  private onMessageStart(event: Extract<ClaudeRawStreamEvent, { type: "message_start" }>): Part[] {
    if (event.message.usage) {
      this.accumulatedUsage = addTokenUsage(
        this.accumulatedUsage,
        mapSdkUsage(event.message.usage)
      );
    }
    return [];
  }

  private onMessageDelta(event: Extract<ClaudeRawStreamEvent, { type: "message_delta" }>): Part[] {
    if (event.usage?.output_tokens) {
      this.accumulatedUsage = addTokenUsage(this.accumulatedUsage, {
        input: 0,
        output: event.usage.output_tokens,
      });
    }
    return [];
  }

  private onMessageStop(): Part[] {
    this.closeText();
    this.closeThinking();
    return [];
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  private closeText(): void {
    if (!this.currentTextPart) return;
    if (this.currentTextPart.state === "STREAMING") {
      const updated: TextPart = { ...this.currentTextPart, state: "DONE" };
      this.replacePart(this.currentTextPart, updated);
      this.currentTextPart = updated;
    }
    this.currentTextPart = null;
  }

  private closeThinking(): void {
    if (!this.currentThinkingPart) return;
    if (this.currentThinkingPart.state === "STREAMING") {
      const updated: ReasoningPart = { ...this.currentThinkingPart, state: "DONE" };
      this.replacePart(this.currentThinkingPart, updated);
      this.currentThinkingPart = updated;
    }
    this.currentThinkingPart = null;
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
