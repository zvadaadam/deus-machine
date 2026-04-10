// agent-server/messages/codex-sdk-adapter.ts
// Transforms Codex SDK ThreadEvents into unified Parts.
//
// The Codex SDK exposes a high-level event model (item.started → item.updated →
// item.completed) rather than raw CLI events (begin/end pairs, deltas). This
// adapter works directly with that model, tracking item state to compute text
// deltas and managing the lifecycle of tool Parts.

import type {
  CommandExecutionItem,
  FileChangeItem,
  McpToolCallItem,
  ThreadEvent,
  ThreadItem,
  Usage,
} from "@openai/codex-sdk";
import type {
  DiffContent,
  FinishReason,
  Part,
  RunningToolState,
  TokenUsage,
  ToolPart,
} from "@shared/messages";
import { emptyTokenUsage } from "@shared/messages";
import type { Adapter, EventTransformer, StreamContext } from "./adapter";
import {
  completeToolPart,
  createReasoningPart,
  createStepFinishPart,
  createStepStartPart,
  createTextPart,
  createToolPart,
} from "./parts";

// ---------------------------------------------------------------------------
// CodexSdkTransformer
// ---------------------------------------------------------------------------

class CodexSdkTransformer implements EventTransformer<ThreadEvent> {
  private ctx: StreamContext;
  private parts = new Map<string, Part>();
  private itemParts = new Map<string, string>(); // item.id → part.id
  private prevText = new Map<string, string>(); // item.id → last seen text
  private totalUsage: TokenUsage = { ...emptyTokenUsage };
  private lastFinishReason: FinishReason | undefined;

  constructor(ctx: StreamContext) {
    this.ctx = ctx;
  }

  process(event: ThreadEvent): Part[] {
    switch (event.type) {
      case "thread.started":
        return [];
      case "turn.started":
        return this.handleTurnStarted();
      case "item.started":
        return this.handleItemStarted(event.item);
      case "item.updated":
        return this.handleItemUpdated(event.item);
      case "item.completed":
        return this.handleItemCompleted(event.item);
      case "turn.completed":
        return this.handleTurnCompleted(event.usage);
      case "turn.failed":
        return this.handleTurnFailed();
      case "error":
        return [];
    }
  }

  finish(): { parts: Part[]; usage: TokenUsage; finishReason?: FinishReason } {
    return {
      parts: this.getParts(),
      usage: this.totalUsage,
      finishReason: this.lastFinishReason,
    };
  }

  getParts(): Part[] {
    return Array.from(this.parts.values());
  }

  // -------------------------------------------------------------------------
  // Turn lifecycle
  // -------------------------------------------------------------------------

  private handleTurnStarted(): Part[] {
    const part = createStepStartPart(this.ctx.sessionId, this.ctx.messageId);
    this.parts.set(part.id, part);
    return [part];
  }

  private handleTurnCompleted(usage: Usage): Part[] {
    this.totalUsage = {
      input: this.totalUsage.input + usage.input_tokens,
      output: this.totalUsage.output + usage.output_tokens,
      cacheRead: (this.totalUsage.cacheRead ?? 0) + usage.cached_input_tokens,
    };
    this.lastFinishReason = "end_turn";

    const part = createStepFinishPart(this.ctx.sessionId, this.ctx.messageId, {
      finishReason: "end_turn",
      tokens: { ...this.totalUsage },
    });
    this.parts.set(part.id, part);
    return [part];
  }

  private handleTurnFailed(): Part[] {
    this.lastFinishReason = "error";

    const part = createStepFinishPart(this.ctx.sessionId, this.ctx.messageId, {
      finishReason: "error",
    });
    this.parts.set(part.id, part);
    return [part];
  }

  // -------------------------------------------------------------------------
  // Item lifecycle dispatch
  // -------------------------------------------------------------------------

  private handleItemStarted(item: ThreadItem): Part[] {
    switch (item.type) {
      case "agent_message":
        return this.upsertTextPart(item.id, item.text, "STREAMING");
      case "reasoning":
        return this.upsertReasoningPart(item.id, item.text, "STREAMING");
      case "command_execution":
        return this.startCommandPart(item);
      case "file_change":
        return this.startFileChangePart(item);
      case "mcp_tool_call":
        return this.startMcpPart(item);
      case "web_search":
      case "todo_list":
      case "error":
        return [];
    }
  }

  private handleItemUpdated(item: ThreadItem): Part[] {
    switch (item.type) {
      case "agent_message":
        return this.upsertTextPart(item.id, item.text, "STREAMING");
      case "reasoning":
        return this.upsertReasoningPart(item.id, item.text, "STREAMING");
      default:
        return [];
    }
  }

  private handleItemCompleted(item: ThreadItem): Part[] {
    switch (item.type) {
      case "agent_message":
        return this.upsertTextPart(item.id, item.text, "DONE");
      case "reasoning":
        return this.upsertReasoningPart(item.id, item.text, "DONE");
      case "command_execution":
        return this.completeCommandPart(item);
      case "file_change":
        return this.completeFileChangePart(item);
      case "mcp_tool_call":
        return this.completeMcpPart(item);
      case "web_search":
      case "todo_list":
      case "error":
        return [];
    }
  }

  // -------------------------------------------------------------------------
  // Text
  // -------------------------------------------------------------------------

  private upsertTextPart(itemId: string, text: string, state: "STREAMING" | "DONE"): Part[] {
    const partId = this.itemParts.get(itemId);

    if (partId) {
      const existing = this.parts.get(partId);
      if (existing && existing.type === "TEXT") {
        const updated: Part = { ...existing, text, state };
        this.parts.set(partId, updated);
        if (state === "DONE") this.prevText.delete(itemId);
        else this.prevText.set(itemId, text);
        return [updated];
      }
    }

    const part = createTextPart(this.ctx.sessionId, this.ctx.messageId, text, state);
    this.parts.set(part.id, part);
    this.itemParts.set(itemId, part.id);
    this.prevText.set(itemId, text);
    if (state === "DONE") this.prevText.delete(itemId);
    return [part];
  }

  // -------------------------------------------------------------------------
  // Reasoning
  // -------------------------------------------------------------------------

  private upsertReasoningPart(itemId: string, text: string, state: "STREAMING" | "DONE"): Part[] {
    const partId = this.itemParts.get(itemId);

    if (partId) {
      const existing = this.parts.get(partId);
      if (existing && existing.type === "REASONING") {
        const updated: Part = { ...existing, text, state };
        this.parts.set(partId, updated);
        if (state === "DONE") this.prevText.delete(itemId);
        else this.prevText.set(itemId, text);
        return [updated];
      }
    }

    const part = createReasoningPart(this.ctx.sessionId, this.ctx.messageId, text, state);
    this.parts.set(part.id, part);
    this.itemParts.set(itemId, part.id);
    if (state === "DONE") this.prevText.delete(itemId);
    else this.prevText.set(itemId, text);
    return [part];
  }

  // -------------------------------------------------------------------------
  // Shell commands -> ToolPart (kind: "bash")
  // -------------------------------------------------------------------------

  private startCommandPart(item: CommandExecutionItem): Part[] {
    const part = createToolPart(this.ctx.sessionId, this.ctx.messageId, {
      toolCallId: item.id,
      toolName: "shell",
      kind: "bash",
      state: {
        status: "RUNNING",
        input: { command: item.command },
        title: item.command,
        time: { start: new Date().toISOString() },
      } satisfies RunningToolState,
    });
    part.title = item.command;

    this.parts.set(part.id, part);
    this.itemParts.set(item.id, part.id);
    return [part];
  }

  private completeCommandPart(item: CommandExecutionItem): Part[] {
    const partId = this.itemParts.get(item.id);
    if (!partId) return [];

    const existing = this.parts.get(partId) as ToolPart | undefined;
    if (!existing) return [];

    const isError =
      item.status === "failed" || (item.exit_code !== undefined && item.exit_code !== 0);

    const output = {
      aggregated_output: item.aggregated_output,
      exit_code: item.exit_code,
    };

    const updated = completeToolPart(
      existing,
      isError ? item.aggregated_output || `Exit code: ${item.exit_code}` : output,
      isError
    );

    if (updated.state.status === "COMPLETED" && item.aggregated_output) {
      (updated as ToolPart).state = {
        ...updated.state,
        content: [{ type: "text" as const, text: item.aggregated_output }],
      };
    }

    this.parts.set(partId, updated);
    return [updated];
  }

  // -------------------------------------------------------------------------
  // File changes -> ToolPart (kind: "write")
  // -------------------------------------------------------------------------

  private startFileChangePart(item: FileChangeItem): Part[] {
    const paths = item.changes.map((c) => c.path);
    const title = paths.length === 1 ? `Edit ${paths[0]}` : `Edit ${paths.length} files`;

    const part = createToolPart(this.ctx.sessionId, this.ctx.messageId, {
      toolCallId: item.id,
      toolName: "apply_patch",
      kind: "write",
      state: {
        status: "RUNNING",
        input: item.changes,
        title,
        time: { start: new Date().toISOString() },
      } satisfies RunningToolState,
    });
    part.title = title;
    part.locations = paths.map((path) => ({ path }));

    this.parts.set(part.id, part);
    this.itemParts.set(item.id, part.id);
    return [part];
  }

  private completeFileChangePart(item: FileChangeItem): Part[] {
    const partId = this.itemParts.get(item.id);
    if (!partId) return [];

    const existing = this.parts.get(partId) as ToolPart | undefined;
    if (!existing) return [];

    const isError = item.status === "failed";

    const content: DiffContent[] = item.changes.map((c) => ({
      type: "diff" as const,
      path: c.path,
      newText: `${c.kind}: ${c.path}`,
    }));

    const updated = completeToolPart(existing, { changes: item.changes }, isError);

    if (updated.state.status === "COMPLETED" && content.length > 0) {
      (updated as ToolPart).state = { ...updated.state, content };
    }

    this.parts.set(partId, updated);
    return [updated];
  }

  // -------------------------------------------------------------------------
  // MCP tool calls -> ToolPart (kind: "mcp")
  // -------------------------------------------------------------------------

  private startMcpPart(item: McpToolCallItem): Part[] {
    const toolName = `${item.server}/${item.tool}`;
    const part = createToolPart(this.ctx.sessionId, this.ctx.messageId, {
      toolCallId: item.id,
      toolName,
      kind: "mcp",
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
    return [part];
  }

  private completeMcpPart(item: McpToolCallItem): Part[] {
    const partId = this.itemParts.get(item.id);
    if (!partId) return [];

    const existing = this.parts.get(partId) as ToolPart | undefined;
    if (!existing) return [];

    const isError = item.status === "failed" || !!item.error;
    const output = isError ? (item.error?.message ?? "Unknown MCP error") : item.result;

    const updated = completeToolPart(existing, output, isError);
    this.parts.set(partId, updated);
    return [updated];
  }
}

// ---------------------------------------------------------------------------
// Adapter export
// ---------------------------------------------------------------------------

export const codexSdkAdapter: Adapter<ThreadEvent> = {
  id: "codex-sdk",
  createTransformer(ctx: StreamContext) {
    return new CodexSdkTransformer(ctx);
  },
};
