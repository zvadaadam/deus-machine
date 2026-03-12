/**
 * Shared type definitions barrel export
 * Import types from here in both frontend and backend
 */

// Workspace types
export type {
  Workspace,
  WorkspaceState,
  SetupStatus,
  RepoGroup,
  DiffStats,
  FileChange,
  FileEdit,
  FileChangeGroup,
} from "./workspace";

// Session types
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
  SessionErrorEvent,
  SessionEnterPlanModeEvent,
  SessionStatusEvent,
  SessionNotification,
} from "./session";

// Session type guards
export {
  isTextBlock,
  isImageBlock,
  isToolUseBlock,
  isToolResultBlock,
  isThinkingBlock,
} from "./session";

// Repository types
export type { Repository, Stats } from "./repository";

// Settings types
export type { Settings, MCPServer, Command, Agent, SettingsSection } from "./settings";

// API types
export type {
  ApiResponse,
  ApiError,
  PaginationParams,
  PaginatedResponse,
  WorkspaceQueryParams,
} from "./api";

// GitHub types
export type { PRStatus, GhCliStatus, DevServer, CheckDetail } from "./github";

// Query protocol types
export type {
  QueryResource,
  MutationName,
  QClientFrame,
  QServerFrame,
  QRequestFrame,
  QSubscribeFrame,
  QUnsubscribeFrame,
  QMutateFrame,
  QResponseFrame,
  QSnapshotFrame,
  QDeltaFrame,
  QMutateResultFrame,
  QInvalidateFrame,
  QErrorFrame,
} from "./query-protocol";
