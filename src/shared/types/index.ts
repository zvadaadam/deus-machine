/**
 * Central export for all TypeScript types
 * Import types from here throughout the application
 *
 * @example
 * import { Workspace, Message, ApiResponse } from '@/shared/types';
 */

// Note: Workspace types moved to features/workspace/types.ts
// Re-export for backward compatibility (to be removed later)
export type {
  Workspace,
  WorkspaceState,
  RepoGroup,
  DiffStats,
  FileChange,
  FileEdit,
  FileChangeGroup,
} from '@/features/workspace';

// Note: Session types moved to features/session/types.ts
// Re-export for backward compatibility (to be removed later)
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
  SessionStatus,
} from '@/features/session';

// Note: Repo and Stats types moved to features/repository/types.ts
// Re-export for backward compatibility (to be removed later)
export type { Repo, Stats } from '@/features/repository';

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
