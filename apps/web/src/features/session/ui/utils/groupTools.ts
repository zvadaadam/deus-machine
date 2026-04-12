/**
 * Tool Streak Grouping
 *
 * Two levels of grouping for tool_use blocks:
 *
 * 1. **Within a message** (`groupToolStreaks`) — Groups consecutive tool_use content
 *    blocks inside a single message's parsed content array. Used by MessageItem during
 *    streaming when the SDK accumulates multiple tool calls in one message.
 *
 * 2. **Across messages** (`groupMessageToolStreaks`) — Groups consecutive assistant
 *    messages that each contain only tool_use blocks. Used by AssistantTurn when
 *    loading from DB, where the agent-server stores each tool call as a separate message row.
 *
 * Both functions output tool blocks compatible with ToolGroupBlock.
 */

import type { ContentBlock, Message, ToolUseBlock } from "@/shared/types";
import { isToolUseBlock } from "@shared/types/session";

export interface SingleBlock {
  kind: "single";
  block: ContentBlock | string;
  originalIndex: number;
}

export interface ToolStreak {
  kind: "streak";
  blocks: ToolUseBlock[];
  originalIndices: number[];
  isTrailing: boolean;
}

export type GroupedItem = SingleBlock | ToolStreak;

/**
 * Read-only exploration tools that can be visually grouped.
 * Important action tools (Edit, Write, Bash) always render individually
 * so the user sees each mutation clearly.
 */
const GROUPABLE_TOOLS = new Set([
  "Read",
  "Grep",
  "Glob",
  "WebFetch",
  "WebSearch",
  "ToolSearch",
  "ListMcpResourcesTool",
  "ReadMcpResourceTool",
]);

function isGroupableToolUse(block: ContentBlock | string): block is ToolUseBlock {
  return isToolUseBlock(block) && GROUPABLE_TOOLS.has(block.name);
}

export function groupToolStreaks(blocks: (ContentBlock | string)[]): GroupedItem[] {
  if (blocks.length === 0) return [];

  const result: GroupedItem[] = [];
  let streakBlocks: ToolUseBlock[] = [];
  let streakIndices: number[] = [];

  const flushStreak = (isTrailing: boolean) => {
    if (streakBlocks.length > 0) {
      result.push({
        kind: "streak",
        blocks: streakBlocks,
        originalIndices: streakIndices,
        isTrailing,
      });
      streakBlocks = [];
      streakIndices = [];
    }
  };

  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];

    if (isGroupableToolUse(block)) {
      streakBlocks.push(block);
      streakIndices.push(i);
    } else {
      // Non-groupable block (text, thinking, Edit, Bash, etc.) seals any active streak
      flushStreak(false);
      result.push({ kind: "single", block, originalIndex: i });
    }
  }

  // Trailing streak — still at the end of the array
  flushStreak(true);

  return result;
}

// ── Message-level grouping ──────────────────────────────────────────────

/**
 * Groups consecutive groupable-tool-only messages into streaks for AssistantTurn rendering.
 *
 * The agent-server stores each tool call as a separate message row. When loading from DB,
 * a sequence like [Read, Grep, Read, Edit] becomes 4 separate Message objects. This function
 * groups the consecutive Read/Grep messages into a ToolGroupBlock while Edit renders
 * individually — only read-only exploration tools (GROUPABLE_TOOLS) are grouped.
 */

export interface MessageSingle {
  kind: "message";
  message: Message;
}

export interface MessageToolStreak {
  kind: "message-tool-streak";
  toolBlocks: ToolUseBlock[];
  /** First tool's ID — used as React key for stable identity */
  firstToolId: string;
}

export type GroupedMessage = MessageSingle | MessageToolStreak;

type ContentParser = (content: string) => (ContentBlock | string)[] | string | null;

export function groupMessageToolStreaks(
  messages: Message[],
  parseContent: ContentParser
): GroupedMessage[] {
  if (messages.length === 0) return [];

  const result: GroupedMessage[] = [];
  let streakBlocks: ToolUseBlock[] = [];

  const flushStreak = () => {
    if (streakBlocks.length > 0) {
      result.push({
        kind: "message-tool-streak",
        toolBlocks: streakBlocks,
        firstToolId: streakBlocks[0].id,
      });
      streakBlocks = [];
    }
  };

  for (const msg of messages) {
    // Parts-based messages render internally via PartsRenderer — skip grouping.
    // They contain all content (text + tools) in one message, unlike the legacy
    // model where each tool call was a separate message row.
    if (msg.parts && msg.parts.length > 0) {
      flushStreak();
      result.push({ kind: "message", message: msg });
      continue;
    }

    const blocks = parseContent(msg.content);

    if (!Array.isArray(blocks) || blocks.length === 0) {
      flushStreak();
      result.push({ kind: "message", message: msg });
      continue;
    }

    // Check if ALL blocks are groupable tool_use (read-only exploration tools).
    // Messages with Edit, Bash, Write, etc. always render individually.
    const toolUseBlocks: ToolUseBlock[] = [];
    let allGroupable = true;

    for (const block of blocks) {
      if (isGroupableToolUse(block)) {
        toolUseBlocks.push(block);
      } else {
        allGroupable = false;
      }
    }

    if (allGroupable && toolUseBlocks.length > 0) {
      streakBlocks.push(...toolUseBlocks);
    } else {
      flushStreak();
      result.push({ kind: "message", message: msg });
    }
  }

  flushStreak();
  return result;
}
