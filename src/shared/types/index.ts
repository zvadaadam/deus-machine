/**
 * Central export for all TypeScript types
 * Import types from here throughout the application
 *
 * @example
 * import { Workspace, Message, ApiResponse } from '@/shared/types';
 */

// Workspace types
export type {
  Workspace,
  WorkspaceState,
  SessionStatus,
  RepoGroup,
  DiffStats,
  FileChange,
  FileEdit,
  FileChangeGroup,
} from './workspace.types';

// Session types
export type {
  Message,
  MessageRole,
  MessageContent,
  ContentBlock,
  TextBlock,
  ToolUseBlock,
  ToolResultBlock,
  ThinkingBlock,
  Session,
} from './session.types';

// Repository types
export type {
  Repo,
  Stats,
} from './repo.types';

// API types
export type {
  ApiResponse,
  ApiError,
  PaginationParams,
  PaginatedResponse,
  WorkspaceQueryParams,
} from './api.types';

// GitHub types
export type {
  PRStatus,
  DevServer,
} from './github.types';
