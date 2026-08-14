// shared/protocol-types.ts
// The canonical agent protocol vocabulary — re-exported verbatim from
// @zvada/agent-server/protocol. Deus has no dialect: the engine's Part /
// ToolState / LifecycleEvent shapes ARE the shapes that cross the wire, land
// in SQLite (`parts.data` is the engine `Part` verbatim) and render in the UI.
//
// Type-only on purpose. The package ships readable TypeScript source, so a
// value import would pull zod (and the whole protocol module graph) into the
// renderer bundle; every consumer that needs runtime behaviour —
// `reduceConversation`, `classifyError`, the zod schemas — imports it directly
// from "@zvada/agent-server/protocol" instead.
//
// Deus extensions live at the bottom: the protocol's open unions (Law 3) let
// us add categories without forking the vocabulary.

export type {
  // ---- events ----
  LifecycleEvent,
  UnknownEvent,
  SessionCreatedEvent,
  SessionEndedEvent,
  SessionUsageEvent,
  SessionCompactionEvent,
  TurnStartedEvent,
  TurnEndedEvent,
  MessageStartedEvent,
  MessagePartEvent,
  MessagePartDeltaEvent,
  MessageEndedEvent,
  PermissionRequestedEvent,
  PermissionResolvedEvent,
  ErrorEvent,
  RawEvent,
  Delta,
  StopReason,
  SessionEndReason,
  CompactionStatus,
  // ---- parts ----
  Part,
  UnknownPart,
  TextPart,
  ReasoningPart,
  ToolPart,
  ImagePart,
  FilePart,
  SubagentMetadata,
  // ---- tool state ----
  ToolState,
  ToolStatePending,
  ToolStateInProgress,
  ToolStateCompleted,
  ToolStateFailed,
  ToolStateCancelled,
  ToolResultContent,
  RuntimeToolStatus,
  ToolKind,
  ToolLocation,
  // ---- input ----
  AgentInput,
  PartInput,
  TextPartInput,
  ImagePartInput,
  FilePartInput,
  TextElement,
  // ---- config ----
  RunConfig,
  PermissionMode,
  ThinkingLevel,
  AgentHarness,
  AgentCapabilities,
  ModelSwitchMode,
  // ---- accounting + errors ----
  TokenUsage,
  ErrorInfo,
  ErrorCategory,
  // ---- wire ----
  WireEventEnvelope,
  InitializeResult,
  TurnStartParams,
  // ---- the reference fold (frontend + tests) ----
  ConversationState,
  ConversationMessage,
  ConversationCompaction,
  ConversationTurn,
  ConversationPermission,
  TimelineEntry,
} from "@zvada/agent-server/protocol";

/**
 * Deus's own error category, layered onto the protocol's open `ErrorCategory`
 * union (Law 3: unknown non-`_` values are reserved for the protocol, so a
 * product extension is just another string the vocabulary tolerates).
 * `db_write` marks a failure that happened in deus's persistence layer, not in
 * the agent.
 */
export const DEUS_ERROR_CATEGORY_DB_WRITE = "db_write";
