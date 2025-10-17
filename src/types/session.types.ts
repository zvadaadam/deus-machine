/**
 * Session and message-related TypeScript type definitions
 * Types for Claude Code session management and message handling
 */

export type MessageRole = 'user' | 'assistant';

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
 * Content blocks can be text, tool_use, or tool_result
 */
export type MessageContent = ContentBlock[];

export type ContentBlock = TextBlock | ToolUseBlock | ToolResultBlock;

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
 * Session information
 * Metadata about a Claude Code session
 */
export interface Session {
  id: string;
  workspace_id: string;
  status: 'idle' | 'working' | 'compacting';
  is_compacting: number;
  created_at: string;
  updated_at: string;
}
