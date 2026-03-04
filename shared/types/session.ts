/**
 * Session and message-related TypeScript type definitions
 * Types for Claude Code session management and message handling
 */

export type MessageRole = "user" | "assistant";

/**
 * Session status indicating current agent state
 *
 * @see src/features/sidebar/lib/status.ts for status derivation logic
 */
// Backend can also emit "needs_response" and "needs_plan_response" when awaiting user input.
export type SessionStatus = "idle" | "working" | "error" | "needs_response" | "needs_plan_response";

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
  content: string; // JSON-stringified MessageContent
  turn_id?: string | null; // Conversation turn identifier
  sent_at?: string | null; // ISO timestamp when message sent to Claude
  cancelled_at?: string | null; // ISO timestamp when user cancels message
  model?: string | null; // Claude model used (e.g., 'sonnet')
  agent_message_id?: string | null; // Agent SDK-provided message identifier
  parent_tool_use_id?: string | null; // Subagent parent task ID (promoted from JSON envelope)
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
  content: string | Record<string, any>;
  is_error?: boolean;
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

// -- Tauri event payloads (sidecar → Rust → frontend) --

/** Payload for session:message and session:error Tauri events */
export interface SessionMessageEvent {
  id: string;
  type: "message" | "error";
  agentType: string;
  data?: unknown;
  error?: string;
  category?: string;
}

/** Payload for session:status-changed Tauri event */
export interface SessionStatusEvent {
  id: string;
  type: "status_changed";
  agentType: string;
  status: SessionStatus;
  errorMessage?: string;
  errorCategory?: string;
  workspaceId?: string;
}

/**
 * Session information
 * Metadata about a Claude Code session
 * Matches the sessions database table schema
 */
export interface Session {
  id: string;
  workspace_id: string;
  agent_type: string;
  model: string;
  agent_session_id?: string | null;
  title?: string | null;
  status: SessionStatus;
  message_count: number;
  error_message?: string | null;
  error_category?: string | null;
  last_user_message_at?: string | null;
  context_token_count: number;
  context_used_percent: number;
  is_hidden: boolean; // SQLite INTEGER → TS boolean (0/1)
  updated_at: string;
  // From JOINs (present in list/detail queries)
  slug?: string | null;
  workspace_state?: string | null;
}
