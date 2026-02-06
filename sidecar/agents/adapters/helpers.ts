// sidecar/agents/adapters/helpers.ts
// Shared factory functions for creating ContentBlock instances.
// Used by all agent adapters to eliminate duplication.

import { randomUUID } from "crypto";
import type {
  TextBlock,
  ToolUseBlock,
  ToolResultBlock,
  ThinkingBlock,
} from "../../../shared/types/session";

/**
 * Create a text content block.
 */
export function createTextBlock(text: string): TextBlock {
  return { type: "text", text };
}

/**
 * Create a thinking/reasoning content block.
 */
export function createThinkingBlock(thinking: string, signature?: string): ThinkingBlock {
  const block: ThinkingBlock = { type: "thinking", thinking };
  if (signature) block.signature = signature;
  return block;
}

/**
 * Create a tool invocation block.
 * If no id is provided, generates a random UUID.
 */
export function createToolUseBlock(
  name: string,
  input: Record<string, unknown>,
  id?: string
): ToolUseBlock {
  return {
    type: "tool_use",
    id: id ?? randomUUID(),
    name,
    input,
  };
}

/**
 * Create a tool result block linked to a tool_use block.
 */
export function createToolResultBlock(
  toolUseId: string,
  content: string | Record<string, unknown>,
  isError?: boolean
): ToolResultBlock {
  const block: ToolResultBlock = {
    type: "tool_result",
    tool_use_id: toolUseId,
    content,
  };
  if (isError !== undefined) block.is_error = isError;
  return block;
}
