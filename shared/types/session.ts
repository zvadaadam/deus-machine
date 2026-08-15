/**
 * Session and message-related TypeScript type definitions
 * Types for Claude Code session management and message handling
 */

// Canonical enum types — defined as Zod schemas in shared/enums.ts,
// imported here for local use and re-exported for backwards compat.
import type { MessageRole, SessionStatus } from "../enums";
import type { Part, UnknownPart } from "../protocol-types";
export type { MessageRole, SessionStatus };

/**
 * Base message entity
 * Core structure for all chat messages in a session
 * Matches the messages database table schema (id = UUID7, embeds created_at)
 */
export interface Message {
  id: string;
  session_id: string;
  seq: number; // Per-session monotonic sequence number (auto-assigned by trigger)
  role: MessageRole;
  /** LEGACY read path: JSON-stringified MessageContent. Rows written by the
   *  engine echo leave this NULL and render from `parts` instead. */
  content: string | null;
  turn_id?: string | null; // The turn this message belongs to (engine turnId)
  sent_at?: string | null; // ISO timestamp of the engine's message.started
  cancelled_at?: string | null; // ISO timestamp when the turn was cancelled
  model?: string | null; // Model that produced the message
  /** Set when this message is a subagent's output: the toolCallId that spawned it. */
  parent_tool_call_id?: string | null;
  /** Turn accounting, written at turn.ended onto the turn's last top-level
   *  assistant message. `tokens` is the JSON-encoded engine TokenUsage. */
  tokens?: string | null;
  cost?: number | null;
  /** The TURN's terminal stopReason (end_turn, refusal, max_turn_requests, …). */
  turn_stop_reason?: string | null;
  /** Engine Part snapshots in stream order (attached by the backend). */
  parts?: Array<Part | UnknownPart>;
}

/**
 * The id of the marker row a cancelled turn leaves behind when the model never
 * produced a message of its own (Stop pressed before the first token).
 *
 * Derived from the turn id on purpose: the backend writes this row and the
 * frontend mirrors it into the cache, so both are the SAME row — a replayed
 * `turn.ended` upserts it, and the q:delta carrying the persisted copy
 * deduplicates against the mirrored one instead of doubling the divider.
 */
export function cancelledTurnMessageId(turnId: string): string {
  return `cancelled-${turnId}`;
}

/** One row of the `compactions` table (the engine's session.compaction entity). */
export interface Compaction {
  compaction_id: string;
  session_id: string;
  turn_id: string;
  status: string;
  trigger?: string | null;
  pre_tokens?: number | null;
  post_tokens?: number | null;
  summary?: string | null;
  created_at: string;
}

/**
 * Parsed message content structure
 * Content blocks can be text, tool_use, tool_result, or thinking
 */
export type MessageContent = ContentBlock[];

export type ContentBlock = TextBlock | ImageBlock | ToolUseBlock | ToolResultBlock | ThinkingBlock;

/**
 * Text content block
 */
export interface TextBlock {
  type: "text";
  text: string;
}

/**
 * Image content block (Anthropic API format)
 * Used for user-pasted images sent to Claude's vision API
 */
export interface ImageBlock {
  type: "image";
  source: {
    type: "base64";
    media_type: string;
    data: string;
  };
}

/**
 * Tool invocation block
 * Represents a Claude Code tool being called
 */
export interface ToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, any>;
}

/**
 * Tool result block
 * Contains the output from a tool execution
 */
export interface ToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  // Arrays preserve multi-part MCP tool responses (text + image blocks).
  // Renderers use extractText / extractImage to pull the right piece.
  content: string | Record<string, any> | unknown[];
  is_error?: boolean;
}

export function isTextBlock(block: ContentBlock | string): block is TextBlock {
  return typeof block === "object" && block !== null && block.type === "text";
}

export function isImageBlock(block: ContentBlock | string): block is ImageBlock {
  return typeof block === "object" && block !== null && block.type === "image";
}

export function isToolUseBlock(block: ContentBlock | string): block is ToolUseBlock {
  return typeof block === "object" && block !== null && block.type === "tool_use";
}

export function isToolResultBlock(block: ContentBlock | string): block is ToolResultBlock {
  return (
    typeof block === "object" &&
    block !== null &&
    block.type === "tool_result" &&
    "tool_use_id" in block
  );
}

export function isThinkingBlock(block: ContentBlock | string): block is ThinkingBlock {
  return typeof block === "object" && block !== null && block.type === "thinking";
}

/**
 * Thinking block
 * Contains Claude's internal reasoning process
 * Encrypted with signature for verification
 */
export interface ThinkingBlock {
  type: "thinking";
  thinking: string;
  signature?: string; // Encrypted signature from Claude
}

/**
 * Session information
 * Metadata about a Claude Code session
 * Matches the sessions database table schema
 */
export interface Session {
  id: string;
  workspace_id: string;
  agent_harness: import("../enums").AgentHarness;
  agent_session_id?: string | null;
  title?: string | null;
  status: SessionStatus;
  message_count: number;
  error_message?: string | null;
  error_category?: import("../protocol-types").ErrorCategory | null;
  last_user_message_at?: string | null;
  context_token_count: number;
  context_used_percent: number;
  is_hidden: boolean; // SQLite INTEGER → TS boolean (0/1)
  updated_at: string;
  // From JOINs (present in list/detail queries)
  slug?: string | null;
  workspace_state?: string | null;
}
