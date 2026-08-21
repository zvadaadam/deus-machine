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
export type { Compaction, Message, MessageRole, Session, SessionStatus } from "./session";

// Repository types
export type { Repository, Stats } from "./repository";

// Settings types
export type { Settings, SettingsSection } from "./settings";

// Deus Cloud auth
export type {
  ClaudeSubscriptionResult,
  CodexSubscriptionResult,
  DeusCloudAuthResult,
  DeusCloudSessionStatus,
} from "./deus-cloud-auth";

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
export type { ApiError } from "./api";

// Manifest types (shared between frontend and backend)
export type { NormalizedTask, ManifestResponse, TaskRunResponse } from "./manifest";

// Onboarding types (shared between frontend and backend)
export type { RecentProject } from "./onboarding";

// Local server discovery types (shared between frontend and backend)
export type {
  LocalServer,
  LocalServerSource,
  LocalServerStatus,
  LocalServerTheme,
  LocalServersSnapshot,
} from "./local-server";

// Simulator capability types
export type { SimulatorCapabilities } from "./simulator";

// GitHub types
export type { PRStatus, GhCliStatus, CheckDetail, PRSummary, BranchSummary } from "./github";

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
