/**
 * Session and message-related TypeScript type definitions
 * Types for Claude Code session management and message handling
 */

export type MessageRole = "user" | "assistant";

/**
 * Session status indicating current agent state
 *
 * TODO: Backend support for 'error' status
 * Currently 'error' is derived in frontend by checking tool_result.is_error
 * Backend should update session.status to 'error' when tool execution fails
 *
 * @see src/features/sidebar/lib/status.ts for status derivation logic
 */
// Backend can also emit "needs_response" and "needs_plan_response" when awaiting user input.
export type SessionStatus =
  | "idle"
  | "working"
  | "compacting"
  | "error"
  | "needs_response"
  | "needs_plan_response";

/**
 * Base message entity
 * Core structure for all chat messages in a session
 * Matches the session_messages database table schema
 */
export interface Message {
  id: string;
  session_id: string;
  role: MessageRole;
  content: string; // JSON-stringified MessageContent
  created_at: string;
  sent_at?: string | null; // ISO timestamp when message sent to Claude
  cancelled_at?: string | null; // ISO timestamp when user cancels message
  model?: string | null; // Claude model used (e.g., 'sonnet')
  sdk_message_id?: string | null; // SDK-provided message identifier
  last_assistant_message_id?: string | null; // ID of last assistant message (for threading)
}

/**
 * Parsed message content structure
 * Content blocks can be text, tool_use, tool_result, or thinking
 */
export type MessageContent = ContentBlock[];

export type ContentBlock = TextBlock | ToolUseBlock | ToolResultBlock | ThinkingBlock;

/**
 * Text content block
 */
export interface TextBlock {
  type: "text";
  text: string;
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

/**
 * Session information
 * Metadata about a Claude Code session
 * Matches the sessions database table schema
 *
 * Note: workspace_id is not in the database but comes from JOIN queries
 */
export interface Session {
  id: string;
  workspace_id?: string; // From JOIN with workspaces table (not in sessions table)
  status: SessionStatus;
  unread_count?: number; // Number of unread messages
  context_token_count?: number; // Token count for context management
  created_at: string;
  updated_at: string;
  is_compacting: number; // Whether session is currently compacting (0 or 1)
  last_user_message_at?: string | null; // ISO timestamp of last user message
}
