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
  MESSAGE_ASSISTANT: "message.assistant",
  MESSAGE_TOOL_RESULT: "message.tool_result",
  MESSAGE_RESULT: "message.result",
  MESSAGE_CANCELLED: "message.cancelled",

  // Unified parts (transformed SDK events → canonical Part types)
  MESSAGE_PARTS: "message.parts",
  MESSAGE_PARTS_FINISHED: "message.parts_finished",

  // Interaction requests (agent needs client/user action)
  REQUEST_OPENED: "request.opened",
  REQUEST_RESOLVED: "request.resolved",

  // Tool relay (agent needs frontend to perform an action)
  TOOL_REQUEST: "tool.request",

  // Metadata
  AGENT_SESSION_ID: "agent.session_id",
  SESSION_TITLE: "session.title",
} as const;

export type AgentEventName = (typeof AGENT_EVENT_NAMES)[keyof typeof AGENT_EVENT_NAMES];

// ============================================================================
// Capabilities (returned in initialize handshake, per agent)
// ============================================================================

/** How model switching works for this agent. */
export const ModelSwitchModeSchema = z.enum(["in-session", "restart-session", "unsupported"]);
export type ModelSwitchMode = z.infer<typeof ModelSwitchModeSchema>;

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

export const TurnCancelRequestSchema = z.object({
  sessionId: z.string().min(1),
});
export type TurnCancelRequest = z.infer<typeof TurnCancelRequestSchema>;

export const TurnRespondRequestSchema = z.object({
  sessionId: z.string().min(1),
  requestId: z.string().min(1),
  result: z.unknown(),
});
export type TurnRespondRequest = z.infer<typeof TurnRespondRequestSchema>;

export const SessionResetRequestSchema = z.object({
  sessionId: z.string().min(1),
});
export type SessionResetRequest = z.infer<typeof SessionResetRequestSchema>;

export const SessionStopRequestSchema = z.object({
  sessionId: z.string().min(1),
});
export type SessionStopRequest = z.infer<typeof SessionStopRequestSchema>;

// ============================================================================
// Provider Operation Schemas
// ============================================================================

export const ProviderAuthRequestSchema = z.object({
  agentType: AgentTypeSchema,
  cwd: z.string().min(1),
});
export type ProviderAuthRequest = z.infer<typeof ProviderAuthRequestSchema>;

export const ProviderInitWorkspaceRequestSchema = z.object({
  agentType: AgentTypeSchema,
  cwd: z.string().min(1),
  ghToken: z.string().optional(),
  providerEnvVars: z.string().optional(),
});
export type ProviderInitWorkspaceRequest = z.infer<typeof ProviderInitWorkspaceRequestSchema>;

export const ProviderContextUsageRequestSchema = z.object({
  sessionId: z.string().min(1),
  agentSessionId: z.string().min(1),
});
export type ProviderContextUsageRequest = z.infer<typeof ProviderContextUsageRequestSchema>;

export const ProviderUpdateModeRequestSchema = z.object({
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
export type MessageAssistantEvent = z.infer<typeof MessageAssistantEventSchema>;

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
export type MessageToolResultEvent = z.infer<typeof MessageToolResultEventSchema>;

export const MessageResultEventSchema = z.object({
  type: z.literal("message.result"),
  sessionId: z.string(),
  agentType: AgentTypeSchema,
  subtype: z.string(),
  usage: z.unknown().optional(),
});
export type MessageResultEvent = z.infer<typeof MessageResultEventSchema>;

export const MessageCancelledEventSchema = z.object({
  type: z.literal("message.cancelled"),
  sessionId: z.string(),
  agentType: AgentTypeSchema,
});
export type MessageCancelledEvent = z.infer<typeof MessageCancelledEventSchema>;

// ── Unified Parts ───────────────────────────────────────────────────

export const MessagePartsEventSchema = z.object({
  type: z.literal("message.parts"),
  sessionId: z.string(),
  agentType: AgentTypeSchema,
  messageId: z.string(),
  parts: z.array(PartSchema),
});
export type MessagePartsEvent = z.infer<typeof MessagePartsEventSchema>;

export const MessagePartsFinishedEventSchema = z.object({
  type: z.literal("message.parts_finished"),
  sessionId: z.string(),
  agentType: AgentTypeSchema,
  messageId: z.string(),
  usage: TokenUsageSchema,
  cost: z.number().optional(),
  finishReason: FinishReasonSchema.optional(),
});
export type MessagePartsFinishedEvent = z.infer<typeof MessagePartsFinishedEventSchema>;

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
export type RequestOpenedEvent = z.infer<typeof RequestOpenedEventSchema>;

export const RequestResolvedEventSchema = z.object({
  type: z.literal("request.resolved"),
  requestId: z.string(),
  sessionId: z.string(),
});
export type RequestResolvedEvent = z.infer<typeof RequestResolvedEventSchema>;

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
  MessageAssistantEventSchema,
  MessageToolResultEventSchema,
  MessageResultEventSchema,
  MessageCancelledEventSchema,
  // Unified parts (transformed into canonical Part types)
  MessagePartsEventSchema,
  MessagePartsFinishedEventSchema,
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
