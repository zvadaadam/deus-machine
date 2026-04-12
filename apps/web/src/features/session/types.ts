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
  PartRow,
} from "@shared/types/session";

export {
  isTextBlock,
  isImageBlock,
  isToolUseBlock,
  isToolResultBlock,
  isThinkingBlock,
} from "@shared/types/session";
