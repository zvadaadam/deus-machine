/**
 * Central export for all TypeScript types
 * Import types from here throughout the application
 *
 * @example
 * import { Workspace, Message, ApiResponse } from '@/shared/types';
 */

// Re-export everything from shared types
export type {
  Workspace,
  WorkspaceState,
  RepoGroup,
  DiffStats,
  FileChange,
  FileEdit,
  FileChangeGroup,
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
  Repo,
  Stats,
  Settings,
  MCPServer,
  Command,
  Agent,
  SettingsSection,
  ApiResponse,
  ApiError,
  PaginationParams,
  PaginatedResponse,
  WorkspaceQueryParams,
  PRStatus,
  DevServer,
} from "@shared/types";
