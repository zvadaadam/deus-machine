// shared/agent-events.ts
// Canonical provider-neutral event types for the agent-server protocol.
//
// These events flow: Agent SDK → AgentHandler → Agent-Server → Backend → Frontend
// Every agent (Claude, Codex, future providers) normalizes its native events
// into these canonical types. The backend uses them for persistence + WS push.
//

import { z } from "zod";

import { AgentTypeSchema, ErrorCategorySchema } from "./enums";
import { PartSchema, TokenUsageSchema, FinishReasonSchema } from "./messages";
import type { FinishReason, Part, TokenUsage } from "./messages";

// ============================================================================
// Part Event Types
// ============================================================================
//
// PartEvents are the canonical events emitted by the agent-server adapters.
// They describe the full lifecycle of a turn:
//
//   turn.started       — a new turn begins
//   message.created    — a new assistant message begins (1+ per turn for Claude, 1 for Codex)
//   part.created       — a new part appeared (text, reasoning, tool, compaction)
//   part.delta         — streaming text token (append to existing part)
//   part.done          — part is finalized (full data, ready to persist)
//   message.done       — assistant message complete (carries all parts for batch persistence)
//   turn.completed     — turn is done (carries usage, cost, finishReason)
//

export type PartEvent =
  | { type: "turn.started"; turnId?: string }
  | { type: "message.created"; messageId: string; role: "assistant"; parentToolCallId?: string }
  | { type: "part.created"; part: Part }
  | { type: "part.delta"; partId: string; delta: string }
  | { type: "part.done"; part: Part }
  | {
      type: "message.done";
      messageId: string;
      stopReason?: string;
      parts: Part[];
      parentToolCallId?: string;
    }
  | {
      type: "turn.completed";
      turnId?: string;
      finishReason?: FinishReason;
      tokens?: TokenUsage;
      cost?: number;
    };

// ============================================================================
// Event Name Constants
// ============================================================================

export const AGENT_EVENT_NAMES = {
  // Session lifecycle
  SESSION_STARTED: "session.started",
  SESSION_IDLE: "session.idle",
  SESSION_ERROR: "session.error",
  SESSION_CANCELLED: "session.cancelled",

  // Messages (one per SDK message)
  MESSAGE_SYSTEM: "message.system",
  MESSAGE_ASSISTANT: "message.assistant",
  MESSAGE_TOOL_RESULT: "message.tool_result",
  MESSAGE_RESULT: "message.result",
  MESSAGE_CANCELLED: "message.cancelled",

  // Turn, message & part lifecycle
  TURN_STARTED: "turn.started",
  MESSAGE_CREATED: "message.created",
  PART_CREATED: "part.created",
  PART_DELTA: "part.delta",
  PART_DONE: "part.done",
  MESSAGE_DONE: "message.done",
  TURN_COMPLETED: "turn.completed",

  // Interaction requests (agent needs client/user action)
  REQUEST_OPENED: "request.opened",
  REQUEST_RESOLVED: "request.resolved",

  // Tool relay (agent needs frontend to perform an action)
  TOOL_REQUEST: "tool.request",

  // Metadata
  AGENT_SESSION_ID: "agent.session_id",
  SESSION_TITLE: "session.title",
} as const;

// ============================================================================
// Capabilities (returned in initialize handshake, per agent)
// ============================================================================

/** How model switching works for this agent. */
export const ModelSwitchModeSchema = z.enum(["in-session", "restart-session", "unsupported"]);
export const AgentCapabilitiesSchema = z.object({
  // Per-agent feature support
  auth: z.boolean(),
  workspaceInit: z.boolean(),
  contextUsage: z.boolean(),

  // Model switching behavior
  modelSwitch: ModelSwitchModeSchema,

  // Session features
  multiTurn: z.boolean(),
  sessionResume: z.boolean(),
  permissionMode: z.boolean(),
});
export type AgentCapabilities = z.infer<typeof AgentCapabilitiesSchema>;

// ============================================================================
// Handshake (initialize / initialized)
// ============================================================================

export const AgentInfoSchema = z.object({
  type: AgentTypeSchema,
  capabilities: AgentCapabilitiesSchema,
  initialized: z.boolean(),
});
export type AgentInfo = z.infer<typeof AgentInfoSchema>;

export const InitializeResultSchema = z.object({
  version: z.string(),
  agents: z.array(AgentInfoSchema),
});
export type InitializeResult = z.infer<typeof InitializeResultSchema>;

// ============================================================================
// Turn Options (params for turn/start RPC)
// ============================================================================

export const TurnOptionsSchema = z.object({
  cwd: z.string().min(1),
  model: z.string().min(1).optional(),
  maxThinkingTokens: z.number().int().positive().optional(),
  maxTurns: z.number().int().positive().optional(),
  turnId: z.string().min(1).optional(),
  permissionMode: z.string().optional(),
  providerEnvVars: z.string().optional(),
  ghToken: z.string().optional(),
  deusEnv: z.record(z.string(), z.string()).optional(),
  additionalDirectories: z.array(z.string()).optional(),
  chromeEnabled: z.boolean().optional(),
  strictDataPrivacy: z.boolean().optional(),
  shouldResetGenerator: z.boolean().optional(),
  resume: z.string().min(1).optional(),
  resumeSessionAt: z.string().min(1).optional(),
});
export type TurnOptions = z.infer<typeof TurnOptionsSchema>;

// ============================================================================
// RPC Request/Response Schemas (client → agent-server)
// ============================================================================

export const TurnStartRequestSchema = z.object({
  sessionId: z.string().min(1),
  agentType: AgentTypeSchema,
  prompt: z.string().min(1),
  options: TurnOptionsSchema,
});
export type TurnStartRequest = z.infer<typeof TurnStartRequestSchema>;

export const TurnStartResponseSchema = z.object({
  accepted: z.boolean(),
  reason: z.string().optional(),
});
export type TurnStartResponse = z.infer<typeof TurnStartResponseSchema>;

const TurnCancelRequestSchema = z.object({
  sessionId: z.string().min(1),
});
export type TurnCancelRequest = z.infer<typeof TurnCancelRequestSchema>;

const TurnRespondRequestSchema = z.object({
  sessionId: z.string().min(1),
  requestId: z.string().min(1),
  result: z.unknown(),
});
export type TurnRespondRequest = z.infer<typeof TurnRespondRequestSchema>;

const SessionResetRequestSchema = z.object({
  sessionId: z.string().min(1),
});
export type SessionResetRequest = z.infer<typeof SessionResetRequestSchema>;

const SessionStopRequestSchema = z.object({
  sessionId: z.string().min(1),
});
export type SessionStopRequest = z.infer<typeof SessionStopRequestSchema>;

// ============================================================================
// Provider Operation Schemas
// ============================================================================

const ProviderAuthRequestSchema = z.object({
  agentType: AgentTypeSchema,
  cwd: z.string().min(1),
});
export type ProviderAuthRequest = z.infer<typeof ProviderAuthRequestSchema>;

const ProviderInitWorkspaceRequestSchema = z.object({
  agentType: AgentTypeSchema,
  cwd: z.string().min(1),
  ghToken: z.string().optional(),
  providerEnvVars: z.string().optional(),
});
export type ProviderInitWorkspaceRequest = z.infer<typeof ProviderInitWorkspaceRequestSchema>;

const ProviderContextUsageRequestSchema = z.object({
  sessionId: z.string().min(1),
  agentSessionId: z.string().min(1),
});
export type ProviderContextUsageRequest = z.infer<typeof ProviderContextUsageRequestSchema>;

const ProviderUpdateModeRequestSchema = z.object({
  sessionId: z.string().min(1),
  permissionMode: z.string().min(1),
});
export type ProviderUpdateModeRequest = z.infer<typeof ProviderUpdateModeRequestSchema>;

// ============================================================================
// Agent-Server RPC Method Constants
// ============================================================================

export const AGENT_RPC_METHODS = {
  // Handshake
  INITIALIZE: "initialize",
  INITIALIZED: "initialized",

  // Turn lifecycle
  TURN_START: "turn/start",
  TURN_CANCEL: "turn/cancel",
  TURN_RESPOND: "turn/respond",

  // Session lifecycle
  SESSION_RESET: "session/reset",
  SESSION_STOP: "session/stop",

  // Provider operations
  PROVIDER_AUTH: "provider/auth",
  PROVIDER_INIT_WORKSPACE: "provider/initWorkspace",
  PROVIDER_CONTEXT_USAGE: "provider/contextUsage",
  PROVIDER_UPDATE_MODE: "provider/updateMode",

  // Introspection
  AGENT_LIST: "agent/list",
} as const;

/**
 * Frontend-facing RPC methods. The agent-server's tools call these as JSON-RPC
 * requests through the tunnel. The backend relays them to the frontend via
 * q:event tool:request, the frontend handles them, and the result flows back.
 */
export const FRONTEND_RPC_METHODS = {
  EXIT_PLAN_MODE: "exitPlanMode",
  ASK_USER_QUESTION: "askUserQuestion",
  GET_DIFF: "getDiff",
  DIFF_COMMENT: "diffComment",
  GET_TERMINAL_OUTPUT: "getTerminalOutput",
  BROWSER_SNAPSHOT: "browserSnapshot",
  BROWSER_CLICK: "browserClick",
  BROWSER_TYPE: "browserType",
  BROWSER_NAVIGATE: "browserNavigate",
  BROWSER_GET_STATE: "browserGetState",
  BROWSER_WAIT_FOR: "browserWaitFor",
  BROWSER_EVALUATE: "browserEvaluate",
  BROWSER_PRESS_KEY: "browserPressKey",
  BROWSER_HOVER: "browserHover",
  BROWSER_SELECT_OPTION: "browserSelectOption",
  BROWSER_NAVIGATE_BACK: "browserNavigateBack",
  BROWSER_CONSOLE_MESSAGES: "browserConsoleMessages",
  BROWSER_NETWORK_REQUESTS: "browserNetworkRequests",
  BROWSER_SCREENSHOT: "browserScreenshot",
  BROWSER_SCROLL: "browserScroll",
  SIM_SCREENSHOT: "simScreenshot",
  SIM_TAP: "simTap",
  SIM_SWIPE: "simSwipe",
  SIM_TYPE_TEXT: "simTypeText",
  SIM_PRESS_KEY: "simPressKey",
  SIM_BUILD_AND_RUN: "simBuildAndRun",
  SIM_LIST_DEVICES: "simListDevices",
  SIM_START: "simStart",
} as const;

// ============================================================================
// Notification Payloads (agent-server → client)
// ============================================================================

// ── Session Lifecycle ──────────────────────────────────────────────────

export const SessionStartedEventSchema = z.object({
  type: z.literal("session.started"),
  sessionId: z.string(),
  agentType: AgentTypeSchema,
});
export type SessionStartedEvent = z.infer<typeof SessionStartedEventSchema>;

export const SessionIdleEventSchema = z.object({
  type: z.literal("session.idle"),
  sessionId: z.string(),
  agentType: AgentTypeSchema,
});
export type SessionIdleEvent = z.infer<typeof SessionIdleEventSchema>;

export const SessionErrorEventSchema = z.object({
  type: z.literal("session.error"),
  sessionId: z.string(),
  agentType: AgentTypeSchema,
  error: z.string(),
  category: ErrorCategorySchema,
});
export type SessionErrorEvent = z.infer<typeof SessionErrorEventSchema>;

export const SessionCancelledEventSchema = z.object({
  type: z.literal("session.cancelled"),
  sessionId: z.string(),
  agentType: AgentTypeSchema,
});
export type SessionCancelledEvent = z.infer<typeof SessionCancelledEventSchema>;

// ── Messages ──────────────────────────────────────────────────────────

export const MessageSystemEventSchema = z.object({
  type: z.literal("message.system"),
  sessionId: z.string(),
  agentType: AgentTypeSchema,
  data: z.unknown(),
});

export const MessageAssistantEventSchema = z.object({
  type: z.literal("message.assistant"),
  sessionId: z.string(),
  agentType: AgentTypeSchema,
  message: z.object({
    id: z.string(),
    role: z.literal("assistant"),
    content: z.unknown(),
    stop_reason: z.string().nullish(),
    parent_tool_use_id: z.string().nullish(),
  }),
  model: z.string().optional(),
});

export const MessageToolResultEventSchema = z.object({
  type: z.literal("message.tool_result"),
  sessionId: z.string(),
  agentType: AgentTypeSchema,
  message: z.object({
    id: z.string(),
    role: z.literal("user"),
    content: z.unknown(),
    parent_tool_use_id: z.string().nullish(),
  }),
  model: z.string().optional(),
});

export const MessageResultEventSchema = z.object({
  type: z.literal("message.result"),
  sessionId: z.string(),
  agentType: AgentTypeSchema,
  subtype: z.string(),
  usage: z.unknown().optional(),
});

export const MessageCancelledEventSchema = z.object({
  type: z.literal("message.cancelled"),
  sessionId: z.string(),
  agentType: AgentTypeSchema,
});
export type MessageCancelledEvent = z.infer<typeof MessageCancelledEventSchema>;

// ── Turn, Message & Part Lifecycle ───────────────────────────────────

export const TurnStartedEventSchema = z.object({
  type: z.literal("turn.started"),
  sessionId: z.string(),
  agentType: AgentTypeSchema,
  messageId: z.string(),
  turnId: z.string().optional(),
});

export const MessageCreatedEventSchema = z.object({
  type: z.literal("message.created"),
  sessionId: z.string(),
  agentType: AgentTypeSchema,
  messageId: z.string(),
  role: z.literal("assistant"),
  parentToolCallId: z.string().optional(),
});
export type MessageCreatedEvent = z.infer<typeof MessageCreatedEventSchema>;

export const PartCreatedEventSchema = z.object({
  type: z.literal("part.created"),
  sessionId: z.string(),
  agentType: AgentTypeSchema,
  messageId: z.string(),
  partId: z.string(),
  part: PartSchema,
});
export type PartCreatedEvent = z.infer<typeof PartCreatedEventSchema>;

export const PartDeltaEventSchema = z.object({
  type: z.literal("part.delta"),
  sessionId: z.string(),
  agentType: AgentTypeSchema,
  partId: z.string(),
  delta: z.string(),
});
export type PartDeltaEvent = z.infer<typeof PartDeltaEventSchema>;

export const PartDoneEventSchema = z.object({
  type: z.literal("part.done"),
  sessionId: z.string(),
  agentType: AgentTypeSchema,
  messageId: z.string(),
  partId: z.string(),
  part: PartSchema,
});
export type PartDoneEvent = z.infer<typeof PartDoneEventSchema>;

export const MessageDoneEventSchema = z.object({
  type: z.literal("message.done"),
  sessionId: z.string(),
  agentType: AgentTypeSchema,
  messageId: z.string(),
  stopReason: z.string().optional(),
  parts: z.array(PartSchema),
  parentToolCallId: z.string().optional(),
});
export type MessageDoneEvent = z.infer<typeof MessageDoneEventSchema>;

export const TurnCompletedEventSchema = z.object({
  type: z.literal("turn.completed"),
  sessionId: z.string(),
  agentType: AgentTypeSchema,
  messageId: z.string(),
  turnId: z.string().optional(),
  finishReason: FinishReasonSchema.optional(),
  tokens: TokenUsageSchema.optional(),
  cost: z.number().optional(),
});

// ── Interaction Requests ──────────────────────────────────────────────

/** Types of interaction the agent can request from the client/user. */
export const InteractionRequestTypeSchema = z.enum([
  "tool_approval",
  "user_question",
  "plan_approval",
  "hook",
]);
export type InteractionRequestType = z.infer<typeof InteractionRequestTypeSchema>;

export const RequestOpenedEventSchema = z.object({
  type: z.literal("request.opened"),
  requestId: z.string(),
  sessionId: z.string(),
  agentType: AgentTypeSchema,
  requestType: InteractionRequestTypeSchema,
  data: z.unknown(),
});

export const RequestResolvedEventSchema = z.object({
  type: z.literal("request.resolved"),
  requestId: z.string(),
  sessionId: z.string(),
});

// ── Tool Relay ────────────────────────────────────────────────────────

export const ToolRequestEventSchema = z.object({
  type: z.literal("tool.request"),
  requestId: z.string(),
  sessionId: z.string(),
  method: z.string(),
  params: z.record(z.string(), z.unknown()),
  timeoutMs: z.number(),
});
export type ToolRequestEvent = z.infer<typeof ToolRequestEventSchema>;

// ── Metadata ──────────────────────────────────────────────────────────

export const AgentSessionIdEventSchema = z.object({
  type: z.literal("agent.session_id"),
  sessionId: z.string(),
  agentSessionId: z.string(),
});
export type AgentSessionIdEvent = z.infer<typeof AgentSessionIdEventSchema>;

export const SessionTitleEventSchema = z.object({
  type: z.literal("session.title"),
  sessionId: z.string(),
  agentType: AgentTypeSchema,
  title: z.string(),
});
export type SessionTitleEvent = z.infer<typeof SessionTitleEventSchema>;

// ============================================================================
// Discriminated Union of All Agent Events
// ============================================================================

export const AgentEventSchema = z.discriminatedUnion("type", [
  // Session lifecycle
  SessionStartedEventSchema,
  SessionIdleEventSchema,
  SessionErrorEventSchema,
  SessionCancelledEventSchema,
  // Messages (legacy — raw SDK content blocks)
  MessageSystemEventSchema,
  MessageAssistantEventSchema,
  MessageToolResultEventSchema,
  MessageResultEventSchema,
  MessageCancelledEventSchema,
  // Turn, message & part lifecycle
  TurnStartedEventSchema,
  MessageCreatedEventSchema,
  PartCreatedEventSchema,
  PartDeltaEventSchema,
  PartDoneEventSchema,
  MessageDoneEventSchema,
  TurnCompletedEventSchema,
  // Interaction requests
  RequestOpenedEventSchema,
  RequestResolvedEventSchema,
  // Tool relay
  ToolRequestEventSchema,
  // Metadata
  AgentSessionIdEventSchema,
  SessionTitleEventSchema,
]);
export type AgentEvent = z.infer<typeof AgentEventSchema>;
