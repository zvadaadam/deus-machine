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
  SetupStatus,
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
  PartRow,
  Repository,
  Stats,
  Settings,
  SettingsSection,
  SkillItem,
  CommandItem,
  AgentItem,
  McpServerItem,
  HookCommand,
  HookMatcherGroup,
  HooksMap,
  NormalizedTask,
  ManifestResponse,
  TaskRunResponse,
  RecentProject,
  ApiResponse,
  ApiError,
  PaginationParams,
  PaginatedResponse,
  WorkspaceQueryParams,
  PRStatus,
  GhCliStatus,
  DevServer,
  CheckDetail,
  PRSummary,
  BranchSummary,
} from "@shared/types";
