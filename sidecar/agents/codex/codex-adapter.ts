// sidecar/agents/codex/codex-adapter.ts
// Codex adapter — converts Codex SDK ThreadEvents into ContentBlock[].
//
// STATUS: Active — wired into codex-handler.ts, used in production.
//
// Codex uses a fundamentally different event model than Claude:
// - Items instead of content blocks (agent_message, command_execution, file_change, etc.)
// - Explicit lifecycle events (thread.started, turn.started/completed/failed)
// - item.started → item.updated → item.completed progression
//
// The Codex binary already accumulates begin/delta/end protocol events into
// clean ThreadEvent objects, so we only need to handle the high-level events.
//
// Tool name mapping is designed to match the frontend's ToolRegistry (case-sensitive):
//   agent_message    → TextBlock
//   reasoning        → ThinkingBlock
//   command_execution → ToolUseBlock("Bash") + ToolResultBlock
//   file_change      → ToolUseBlock("Write"/"Edit"/"Bash") + ToolResultBlock per file
//   mcp_tool_call    → ToolUseBlock("{server}:{tool}") + ToolResultBlock (falls back to default renderer)
//   web_search       → ignored (not rendered)
//   todo_list        → ignored (not rendered)
//
// Reference: Echo backend's codex adapter at sample-backend/src/messages/adapters/codex.ts

import type { ContentBlock } from "../../../shared/types/session";
import type { EventTransformer, TransformResult, TokenUsage } from "../adapters/types";
import {
  createTextBlock,
  createThinkingBlock,
  createToolUseBlock,
  createToolResultBlock,
} from "../adapters/helpers";

// ============================================================================
// Codex SDK Event Types
// ============================================================================

export type CodexEvent =
  | CodexThreadStartedEvent
  | CodexTurnStartedEvent
  | CodexTurnCompletedEvent
  | CodexTurnFailedEvent
  | CodexItemStartedEvent
  | CodexItemUpdatedEvent
  | CodexItemCompletedEvent
  | CodexErrorEvent;

export interface CodexThreadStartedEvent {
  type: "thread.started";
  thread_id: string;
}

export interface CodexTurnStartedEvent {
  type: "turn.started";
}

export interface CodexTurnCompletedEvent {
  type: "turn.completed";
  usage: {
    input_tokens: number;
    cached_input_tokens: number;
    output_tokens: number;
  };
}

export interface CodexTurnFailedEvent {
  type: "turn.failed";
  error: { message: string };
}

export interface CodexItemStartedEvent {
  type: "item.started";
  item: CodexItem;
}

export interface CodexItemUpdatedEvent {
  type: "item.updated";
  item: CodexItem;
}

export interface CodexItemCompletedEvent {
  type: "item.completed";
  item: CodexItem;
}

export interface CodexErrorEvent {
  type: "error";
  message: string;
}

// ============================================================================
// Codex Item Types
// ============================================================================

export type CodexItem =
  | CodexAgentMessageItem
  | CodexReasoningItem
  | CodexCommandExecutionItem
  | CodexFileChangeItem
  | CodexMcpToolCallItem
  | CodexWebSearchItem
  | CodexTodoListItem
  | CodexErrorItem;

export interface CodexAgentMessageItem {
  id: string;
  type: "agent_message";
  text: string;
}

export interface CodexReasoningItem {
  id: string;
  type: "reasoning";
  text: string;
}

export interface CodexCommandExecutionItem {
  id: string;
  type: "command_execution";
  command: string;
  aggregated_output: string;
  exit_code?: number;
  status: "in_progress" | "completed" | "failed";
}

export interface CodexFileChangeItem {
  id: string;
  type: "file_change";
  changes: Array<{
    path: string;
    kind: "add" | "delete" | "update";
  }>;
  status: "completed" | "failed";
}

export interface CodexMcpToolCallItem {
  id: string;
  type: "mcp_tool_call";
  server: string;
  tool: string;
  arguments: unknown;
  result?: { content: unknown[]; structured_content: unknown };
  error?: { message: string };
  status: "in_progress" | "completed" | "failed";
}

export interface CodexWebSearchItem {
  id: string;
  type: "web_search";
  query: string;
}

export interface CodexTodoListItem {
  id: string;
  type: "todo_list";
  items: Array<{ text: string; completed: boolean }>;
}

export interface CodexErrorItem {
  id: string;
  type: "error";
  message: string;
}

// ============================================================================
// Transformer
// ============================================================================

/**
 * Creates a Codex event transformer.
 *
 * Accumulates ContentBlocks from Codex ThreadEvents. Only item.completed events
 * produce blocks for persistence — item.started/updated are for streaming UI only.
 */
export function createCodexTransformer(): EventTransformer<CodexEvent> {
  const allBlocks: ContentBlock[] = [];
  // Track items by ID for update-in-place (text/reasoning can arrive
  // via item.started then update via item.updated before item.completed)
  const itemBlockIndex = new Map<string, number>();
  let usage: TokenUsage | undefined;
  let error: string | undefined;

  function processItem(item: CodexItem, isCompleted: boolean): ContentBlock[] {
    const result: ContentBlock[] = [];

    switch (item.type) {
      case "agent_message": {
        if (!item.text || item.text.trim() === "") break;

        const existingIdx = itemBlockIndex.get(item.id);
        if (existingIdx !== undefined) {
          // Update existing text block in place
          const existing = allBlocks[existingIdx];
          if (existing && existing.type === "text") {
            existing.text = item.text;
            result.push(existing);
          }
        } else {
          const block = createTextBlock(item.text);
          itemBlockIndex.set(item.id, allBlocks.length);
          allBlocks.push(block);
          result.push(block);
        }
        break;
      }

      case "reasoning": {
        if (!item.text || item.text.trim() === "") break;

        const existingIdx = itemBlockIndex.get(item.id);
        if (existingIdx !== undefined) {
          const existing = allBlocks[existingIdx];
          if (existing && existing.type === "thinking") {
            existing.thinking = item.text;
            result.push(existing);
          }
        } else {
          const block = createThinkingBlock(item.text);
          itemBlockIndex.set(item.id, allBlocks.length);
          allBlocks.push(block);
          result.push(block);
        }
        break;
      }

      case "command_execution": {
        const isError =
          item.status === "failed" || (typeof item.exit_code === "number" && item.exit_code !== 0);

        if (isCompleted) {
          const toolUse = createToolUseBlock("Bash", { command: item.command }, item.id);
          const toolResult = createToolResultBlock(
            item.id,
            item.aggregated_output || `Exit code: ${item.exit_code ?? "unknown"}`,
            isError
          );
          allBlocks.push(toolUse, toolResult);
          result.push(toolUse, toolResult);
        }
        break;
      }

      case "file_change": {
        if (!isCompleted) break;

        for (const change of item.changes) {
          const toolId = `${item.id}_${change.path}`;
          const isError = item.status === "failed";

          const toolName =
            change.kind === "add" ? "Write" : change.kind === "update" ? "Edit" : "Bash";
          const input =
            change.kind === "delete"
              ? { command: `rm ${change.path}` }
              : { file_path: change.path };

          const toolUse = createToolUseBlock(toolName, input, toolId);
          const toolResult = createToolResultBlock(
            toolId,
            `${change.kind} ${change.path}`,
            isError
          );
          allBlocks.push(toolUse, toolResult);
          result.push(toolUse, toolResult);
        }
        break;
      }

      case "mcp_tool_call": {
        if (!isCompleted) break;

        const isError = item.status === "failed" || !!item.error;
        const toolName = `${item.server}:${item.tool}`;

        const toolUse = createToolUseBlock(
          toolName,
          (item.arguments as Record<string, unknown>) ?? {},
          item.id
        );
        const output = isError
          ? item.error?.message || "MCP tool call failed"
          : JSON.stringify(item.result, null, 2);
        const toolResult = createToolResultBlock(item.id, output, isError);

        allBlocks.push(toolUse, toolResult);
        result.push(toolUse, toolResult);
        break;
      }

      case "error": {
        error = item.message;
        break;
      }

      // web_search, todo_list: not mapped to content blocks
    }

    return result;
  }

  return {
    process(event: CodexEvent): ContentBlock[] {
      switch (event.type) {
        case "thread.started":
        case "turn.started":
          return [];

        case "turn.completed":
          usage = {
            inputTokens: event.usage.input_tokens,
            outputTokens: event.usage.output_tokens,
            cacheReadTokens: event.usage.cached_input_tokens,
          };
          return [];

        case "turn.failed":
          error = event.error.message;
          return [];

        case "item.started":
        case "item.updated":
          return processItem(event.item, false);

        case "item.completed":
          return processItem(event.item, true);

        case "error":
          error = event.message;
          return [];

        default:
          return [];
      }
    },

    finish(): TransformResult {
      return { blocks: allBlocks, usage, error };
    },
  };
}
