// agent-server/messages/codex-adapter.ts
// Transforms Codex CLI events into unified Parts.

import type {
  DiffContent,
  Part,
  PendingToolState,
  RunningToolState,
  TextContent,
  TokenUsage,
  ToolPart,
} from "@shared/messages";
import { emptyTokenUsage } from "@shared/messages";
import type { Adapter, EventTransformer, StreamContext } from "./adapter";
import type { CodexEvent } from "./codex-events";
import {
  completeToolPart,
  createReasoningPart,
  createStepFinishPart,
  createStepStartPart,
  createTextPart,
  createToolPart,
} from "./parts";

// ---------------------------------------------------------------------------
// Codex Transformer
// ---------------------------------------------------------------------------

class CodexTransformer implements EventTransformer<CodexEvent> {
  private ctx: StreamContext;
  private parts = new Map<string, Part>();
  private currentTextPart: string | null = null;
  private currentReasoningPart: string | null = null;
  private toolParts = new Map<string, string>(); // call_id → partId
  private totalUsage: TokenUsage = { ...emptyTokenUsage };

  constructor(ctx: StreamContext) {
    this.ctx = ctx;
  }

  process(event: CodexEvent): Part[] {
    switch (event.type) {
      case "agent_message_delta":
        return this.handleTextDelta(event.delta);
      case "agent_message":
        return this.handleTextComplete(event.message);
      case "agent_reasoning_delta":
        return this.handleReasoningDelta(event.delta);
      case "agent_reasoning":
        return this.handleReasoningComplete(event.text);
      case "exec_command_begin":
        return this.handleExecBegin(event);
      case "exec_command_end":
        return this.handleExecEnd(event);
      case "exec_approval_request":
        return this.handleExecApproval(event);
      case "patch_apply_begin":
        return this.handlePatchBegin(event);
      case "patch_apply_end":
        return this.handlePatchEnd(event);
      case "apply_patch_approval_request":
        return this.handlePatchApproval(event);
      case "mcp_tool_call_begin":
        return this.handleMcpBegin(event);
      case "mcp_tool_call_end":
        return this.handleMcpEnd(event);
      case "task_started":
        return this.handleTurnStarted();
      case "task_complete":
        return this.handleTurnComplete();
      case "turn_aborted":
        return this.handleTurnAborted(event);
      case "token_count":
        return this.handleTokenCount(event);
      case "session_configured":
      case "error":
        return [];
    }
  }

  finish(): { parts: Part[]; usage: TokenUsage } {
    this.finalizeCurrentTextPart();
    this.finalizeCurrentReasoningPart();
    return { parts: this.getParts(), usage: this.totalUsage };
  }

  getParts(): Part[] {
    return Array.from(this.parts.values());
  }

  // -------------------------------------------------------------------------
  // Text streaming
  // -------------------------------------------------------------------------

  private handleTextDelta(delta: string): Part[] {
    this.finalizeCurrentReasoningPart();

    if (this.currentTextPart) {
      const existing = this.parts.get(this.currentTextPart);
      if (existing && existing.type === "TEXT") {
        const updated: Part = { ...existing, text: existing.text + delta, state: "STREAMING" };
        this.parts.set(existing.id, updated);
        return [updated];
      }
    }

    const part = createTextPart(this.ctx.sessionId, this.ctx.messageId, delta, "STREAMING");
    this.parts.set(part.id, part);
    this.currentTextPart = part.id;
    return [part];
  }

  private handleTextComplete(message: string): Part[] {
    this.finalizeCurrentReasoningPart();

    if (this.currentTextPart) {
      const existing = this.parts.get(this.currentTextPart);
      if (existing && existing.type === "TEXT") {
        const updated: Part = { ...existing, text: message, state: "DONE" };
        this.parts.set(existing.id, updated);
        this.currentTextPart = null;
        return [updated];
      }
    }

    const part = createTextPart(this.ctx.sessionId, this.ctx.messageId, message, "DONE");
    this.parts.set(part.id, part);
    this.currentTextPart = null;
    return [part];
  }

  // -------------------------------------------------------------------------
  // Reasoning
  // -------------------------------------------------------------------------

  private handleReasoningDelta(delta: string): Part[] {
    if (this.currentReasoningPart) {
      const existing = this.parts.get(this.currentReasoningPart);
      if (existing && existing.type === "REASONING") {
        const updated: Part = { ...existing, text: existing.text + delta, state: "STREAMING" };
        this.parts.set(existing.id, updated);
        return [updated];
      }
    }

    const part = createReasoningPart(this.ctx.sessionId, this.ctx.messageId, delta, "STREAMING");
    this.parts.set(part.id, part);
    this.currentReasoningPart = part.id;
    return [part];
  }

  private handleReasoningComplete(text: string): Part[] {
    if (this.currentReasoningPart) {
      const existing = this.parts.get(this.currentReasoningPart);
      if (existing && existing.type === "REASONING") {
        const updated: Part = { ...existing, text, state: "DONE" };
        this.parts.set(existing.id, updated);
        this.currentReasoningPart = null;
        return [updated];
      }
    }

    const part = createReasoningPart(this.ctx.sessionId, this.ctx.messageId, text, "DONE");
    this.parts.set(part.id, part);
    this.currentReasoningPart = null;
    return [part];
  }

  // -------------------------------------------------------------------------
  // Shell commands → ToolPart (kind: "bash")
  // -------------------------------------------------------------------------

  private handleExecBegin(event: Extract<CodexEvent, { type: "exec_command_begin" }>): Part[] {
    this.finalizeCurrentTextPart();
    this.finalizeCurrentReasoningPart();

    const commandStr = event.command.join(" ");
    const part = createToolPart(this.ctx.sessionId, this.ctx.messageId, {
      toolCallId: event.call_id,
      toolName: "shell",
      kind: "bash",
      state: {
        status: "RUNNING",
        input: { command: commandStr, cwd: event.cwd },
        title: commandStr,
        time: { start: new Date().toISOString() },
      } satisfies RunningToolState,
    });
    part.title = commandStr;
    part.locations = [{ path: event.cwd }];

    this.parts.set(part.id, part);
    this.toolParts.set(event.call_id, part.id);
    return [part];
  }

  private handleExecEnd(event: Extract<CodexEvent, { type: "exec_command_end" }>): Part[] {
    const partId = this.toolParts.get(event.call_id);
    if (!partId) return [];

    const existing = this.parts.get(partId) as ToolPart | undefined;
    if (!existing) return [];

    const isError = event.exit_code !== 0;
    const output = {
      stdout: event.stdout,
      stderr: event.stderr,
      exit_code: event.exit_code,
      aggregated_output: event.aggregated_output,
    };

    const content: TextContent[] = [];
    if (event.aggregated_output || event.stdout) {
      content.push({ type: "text", text: event.aggregated_output || event.stdout });
    }

    const updated = completeToolPart(
      existing,
      isError ? event.stderr || event.stdout : output,
      isError
    );

    if (updated.state.status === "COMPLETED" && content.length > 0) {
      (updated as ToolPart).state = { ...updated.state, content };
    }

    this.parts.set(partId, updated);
    return [updated];
  }

  private handleExecApproval(
    event: Extract<CodexEvent, { type: "exec_approval_request" }>
  ): Part[] {
    this.finalizeCurrentTextPart();
    this.finalizeCurrentReasoningPart();

    const existingPartId = this.toolParts.get(event.call_id);
    if (existingPartId) {
      const existing = this.parts.get(existingPartId) as ToolPart | undefined;
      if (existing) {
        const updated: ToolPart = {
          ...existing,
          state: {
            status: "PENDING",
            partialInput: event.command.join(" "),
          } satisfies PendingToolState,
        };
        this.parts.set(existingPartId, updated);
        return [updated];
      }
    }

    const part = createToolPart(this.ctx.sessionId, this.ctx.messageId, {
      toolCallId: event.call_id,
      toolName: "shell",
      kind: "bash",
      state: {
        status: "PENDING",
        partialInput: event.command.join(" "),
      } satisfies PendingToolState,
    });
    part.title = event.command.join(" ");

    this.parts.set(part.id, part);
    this.toolParts.set(event.call_id, part.id);
    return [part];
  }

  // -------------------------------------------------------------------------
  // File patches → ToolPart (kind: "write")
  // -------------------------------------------------------------------------

  private handlePatchBegin(event: Extract<CodexEvent, { type: "patch_apply_begin" }>): Part[] {
    this.finalizeCurrentTextPart();
    this.finalizeCurrentReasoningPart();

    const paths = Object.keys(event.changes);
    const title = paths.length === 1 ? `Edit ${paths[0]}` : `Edit ${paths.length} files`;

    const part = createToolPart(this.ctx.sessionId, this.ctx.messageId, {
      toolCallId: event.call_id,
      toolName: "apply_patch",
      kind: "write",
      state: {
        status: "RUNNING",
        input: event.changes,
        title,
        time: { start: new Date().toISOString() },
      } satisfies RunningToolState,
    });
    part.title = title;
    part.locations = paths.map((path) => ({ path }));

    this.parts.set(part.id, part);
    this.toolParts.set(event.call_id, part.id);
    return [part];
  }

  private handlePatchEnd(event: Extract<CodexEvent, { type: "patch_apply_end" }>): Part[] {
    const partId = this.toolParts.get(event.call_id);
    if (!partId) return [];

    const existing = this.parts.get(partId) as ToolPart | undefined;
    if (!existing) return [];

    const content: DiffContent[] = [];
    for (const [path, change] of Object.entries(event.changes)) {
      if (!change) continue;
      if (change.type === "update") {
        content.push({ type: "diff", path, newText: change.unified_diff });
      } else if (change.type === "add") {
        content.push({ type: "diff", path, newText: change.content });
      } else if (change.type === "delete") {
        content.push({ type: "diff", path, oldText: change.content, newText: "" });
      }
    }

    const updated = completeToolPart(
      existing,
      { success: event.success, changes: event.changes },
      !event.success
    );

    if (updated.state.status === "COMPLETED" && content.length > 0) {
      (updated as ToolPart).state = { ...updated.state, content };
    }

    this.parts.set(partId, updated);
    return [updated];
  }

  private handlePatchApproval(
    event: Extract<CodexEvent, { type: "apply_patch_approval_request" }>
  ): Part[] {
    this.finalizeCurrentTextPart();
    this.finalizeCurrentReasoningPart();

    const paths = Object.keys(event.changes);
    const title = paths.length === 1 ? `Edit ${paths[0]}` : `Edit ${paths.length} files`;

    const part = createToolPart(this.ctx.sessionId, this.ctx.messageId, {
      toolCallId: event.call_id,
      toolName: "apply_patch",
      kind: "write",
      state: {
        status: "PENDING",
        partialInput: JSON.stringify(event.changes),
      } satisfies PendingToolState,
    });
    part.title = title;
    part.locations = paths.map((path) => ({ path }));

    this.parts.set(part.id, part);
    this.toolParts.set(event.call_id, part.id);
    return [part];
  }

  // -------------------------------------------------------------------------
  // MCP tool calls → ToolPart (kind: "mcp")
  // -------------------------------------------------------------------------

  private handleMcpBegin(event: Extract<CodexEvent, { type: "mcp_tool_call_begin" }>): Part[] {
    this.finalizeCurrentTextPart();
    this.finalizeCurrentReasoningPart();

    const toolName = `${event.invocation.server}/${event.invocation.tool}`;
    const part = createToolPart(this.ctx.sessionId, this.ctx.messageId, {
      toolCallId: event.call_id,
      toolName,
      kind: "mcp",
      state: {
        status: "RUNNING",
        input: event.invocation.arguments,
        title: event.invocation.tool,
        time: { start: new Date().toISOString() },
      } satisfies RunningToolState,
    });
    part.title = event.invocation.tool;

    this.parts.set(part.id, part);
    this.toolParts.set(event.call_id, part.id);
    return [part];
  }

  private handleMcpEnd(event: Extract<CodexEvent, { type: "mcp_tool_call_end" }>): Part[] {
    const partId = this.toolParts.get(event.call_id);
    if (!partId) return [];

    const existing = this.parts.get(partId) as ToolPart | undefined;
    if (!existing) return [];

    const isError = "Err" in event.result;
    const output = isError
      ? (event.result as { Err: string }).Err
      : (event.result as { Ok: { content: unknown[]; isError?: boolean } }).Ok;

    const mcpIsError = isError || (!isError && (output as { isError?: boolean }).isError === true);

    const updated = completeToolPart(existing, output, mcpIsError);
    this.parts.set(partId, updated);
    return [updated];
  }

  // -------------------------------------------------------------------------
  // Turn lifecycle
  // -------------------------------------------------------------------------

  private handleTurnStarted(): Part[] {
    const part = createStepStartPart(this.ctx.sessionId, this.ctx.messageId);
    this.parts.set(part.id, part);
    return [part];
  }

  private handleTurnComplete(): Part[] {
    this.finalizeCurrentTextPart();
    this.finalizeCurrentReasoningPart();

    const part = createStepFinishPart(this.ctx.sessionId, this.ctx.messageId, {
      finishReason: "end_turn",
      tokens: { ...this.totalUsage },
    });
    this.parts.set(part.id, part);
    return [part];
  }

  private handleTurnAborted(event: Extract<CodexEvent, { type: "turn_aborted" }>): Part[] {
    this.finalizeCurrentTextPart();
    this.finalizeCurrentReasoningPart();

    const part = createStepFinishPart(this.ctx.sessionId, this.ctx.messageId, {
      finishReason: event.reason === "interrupted" ? "cancelled" : "end_turn",
      tokens: { ...this.totalUsage },
    });
    this.parts.set(part.id, part);
    return [part];
  }

  // -------------------------------------------------------------------------
  // Token counting
  // -------------------------------------------------------------------------

  private handleTokenCount(event: Extract<CodexEvent, { type: "token_count" }>): Part[] {
    if (!event.info) return [];

    const usage = event.info.last_token_usage;
    this.totalUsage = {
      input: this.totalUsage.input + usage.input_tokens,
      output: this.totalUsage.output + usage.output_tokens,
      reasoning: usage.reasoning_output_tokens
        ? (this.totalUsage.reasoning ?? 0) + usage.reasoning_output_tokens
        : this.totalUsage.reasoning,
      cacheRead: usage.cached_input_tokens
        ? (this.totalUsage.cacheRead ?? 0) + usage.cached_input_tokens
        : this.totalUsage.cacheRead,
    };

    return [];
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  private finalizeCurrentTextPart(): void {
    if (!this.currentTextPart) return;
    const part = this.parts.get(this.currentTextPart);
    if (part && part.type === "TEXT" && part.state === "STREAMING") {
      this.parts.set(part.id, { ...part, state: "DONE" });
    }
    this.currentTextPart = null;
  }

  private finalizeCurrentReasoningPart(): void {
    if (!this.currentReasoningPart) return;
    const part = this.parts.get(this.currentReasoningPart);
    if (part && part.type === "REASONING" && part.state === "STREAMING") {
      this.parts.set(part.id, { ...part, state: "DONE" });
    }
    this.currentReasoningPart = null;
  }
}

// ---------------------------------------------------------------------------
// Adapter export
// ---------------------------------------------------------------------------

export const codexAdapter: Adapter<CodexEvent> = {
  id: "codex",
  createTransformer(ctx: StreamContext) {
    return new CodexTransformer(ctx);
  },
};
