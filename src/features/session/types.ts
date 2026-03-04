/**
 * Re-export session types from shared definitions
 * Original types moved to shared/types/session.ts
 */
export type {
  Message,
  MessageRole,
  MessageContent,
  ContentBlock,
  TextBlock,
  ImageBlock,
  ToolUseBlock,
  ToolResultBlock,
  ThinkingBlock,
  Session,
  SessionStatus,
  SessionMessageEvent,
  SessionStatusEvent,
} from "@shared/types/session";
