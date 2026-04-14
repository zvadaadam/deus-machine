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
export type { Settings, SettingsSection } from "./settings";

// Agent config types (shared between frontend and backend)
export type {
  SkillItem,
  CommandItem,
  AgentItem,
  McpServerItem,
  HookCommand,
  HookMatcherGroup,
  HooksMap,
} from "./agent-config";

// API types
export type { ApiError, PaginationParams } from "./api";

// Manifest types (shared between frontend and backend)
export type { NormalizedTask, ManifestResponse, TaskRunResponse } from "./manifest";

// Onboarding types (shared between frontend and backend)
export type { RecentProject } from "./onboarding";

// GitHub types
export type {
  PRStatus,
  GhCliStatus,
  DevServer,
  CheckDetail,
  PRSummary,
  BranchSummary,
} from "./github";

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
