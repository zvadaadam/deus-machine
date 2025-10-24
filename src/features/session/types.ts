/**
 * Session and message-related TypeScript type definitions
 * Types for Claude Code session management and message handling
 */

export type MessageRole = 'user' | 'assistant';
export type SessionStatus = 'idle' | 'working' | 'compacting';

/**
 * Base message entity
 * Core structure for all chat messages in a session
 */
export interface Message {
  id: string;
  role: MessageRole;
  content: string;  // JSON-stringified MessageContent
  created_at: string;
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
  type: 'text';
  text: string;
}

/**
 * Tool invocation block
 * Represents a Claude Code tool being called
 */
export interface ToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, any>;
}

/**
 * Tool result block
 * Contains the output from a tool execution
 */
export interface ToolResultBlock {
  type: 'tool_result';
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
  type: 'thinking';
  thinking: string;
  signature?: string;  // Encrypted signature from Claude
}

/**
 * Session information
 * Metadata about a Claude Code session
 */
export interface Session {
  id: string;
  workspace_id: string;
  status: SessionStatus;
  is_compacting: number;
  working_started_at: string | null;
  created_at: string;
  updated_at: string;
}
