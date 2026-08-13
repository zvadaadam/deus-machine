// shared/agent-events.ts
// Canonical provider-neutral event types for the agent-server protocol.
//
// These events flow: Agent SDK → AgentHandler → Agent-Server → Backend → Frontend
// Every agent (Claude, Codex, future providers) normalizes its native events
// into these canonical types. The backend uses them for persistence + WS push.
//

import { z } from "zod";

import { AgentHarnessSchema, ErrorCategorySchema } from "./enums";
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
  SESSION_CONTEXT_USAGE: "session.contextUsage",

  // Messages
  MESSAGE_CANCELLED: "message.cancelled",

  // Turn, message & part lifecycle
  TURN_STARTED: "turn.started",
  MESSAGE_CREATED: "message.created",
  PART_CREATED: "part.created",
  PART_DELTA: "part.delta",
  PART_DONE: "part.done",
  MESSAGE_DONE: "message.done",
  TURN_COMPLETED: "turn.completed",

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
  type: AgentHarnessSchema,
  capabilities: AgentCapabilitiesSchema,
  initialized: z.boolean(),
});
export type AgentInfo = z.infer<typeof AgentInfoSchema>;

// ============================================================================
// Provider Operation Schemas
// ============================================================================

const ProviderAuthRequestSchema = z.object({
  agentHarness: AgentHarnessSchema,
  cwd: z.string().min(1),
});
export type ProviderAuthRequest = z.infer<typeof ProviderAuthRequestSchema>;

// ============================================================================
// Notification Payloads (agent-server → client)
// ============================================================================

// ── Session Lifecycle ──────────────────────────────────────────────────

export const SessionStartedEventSchema = z.object({
  type: z.literal("session.started"),
  sessionId: z.string(),
  agentHarness: AgentHarnessSchema,
});
export type SessionStartedEvent = z.infer<typeof SessionStartedEventSchema>;

export const SessionIdleEventSchema = z.object({
  type: z.literal("session.idle"),
  sessionId: z.string(),
  agentHarness: AgentHarnessSchema,
});
export type SessionIdleEvent = z.infer<typeof SessionIdleEventSchema>;

export const SessionContextUsageEventSchema = z.object({
  type: z.literal("session.contextUsage"),
  sessionId: z.string(),
  agentHarness: AgentHarnessSchema,
  /** Tokens currently in the context window. */
  used: z.number(),
  /** Context window size, when the provider reports it. */
  size: z.number().optional(),
  /** Cumulative session cost in USD, when reported. */
  cost: z.number().optional(),
});
export type SessionContextUsageEvent = z.infer<typeof SessionContextUsageEventSchema>;

export const SessionErrorEventSchema = z.object({
  type: z.literal("session.error"),
  sessionId: z.string(),
  agentHarness: AgentHarnessSchema,
  error: z.string(),
  category: ErrorCategorySchema,
});
export type SessionErrorEvent = z.infer<typeof SessionErrorEventSchema>;

export const SessionCancelledEventSchema = z.object({
  type: z.literal("session.cancelled"),
  sessionId: z.string(),
  agentHarness: AgentHarnessSchema,
});
export type SessionCancelledEvent = z.infer<typeof SessionCancelledEventSchema>;

// ── Messages ──────────────────────────────────────────────────────────

export const MessageCancelledEventSchema = z.object({
  type: z.literal("message.cancelled"),
  sessionId: z.string(),
  agentHarness: AgentHarnessSchema,
});
export type MessageCancelledEvent = z.infer<typeof MessageCancelledEventSchema>;

// ── Turn, Message & Part Lifecycle ───────────────────────────────────

export const TurnStartedEventSchema = z.object({
  type: z.literal("turn.started"),
  sessionId: z.string(),
  agentHarness: AgentHarnessSchema,
  messageId: z.string(),
  turnId: z.string().optional(),
});

export const MessageCreatedEventSchema = z.object({
  type: z.literal("message.created"),
  sessionId: z.string(),
  agentHarness: AgentHarnessSchema,
  messageId: z.string(),
  role: z.literal("assistant"),
  parentToolCallId: z.string().optional(),
});
export type MessageCreatedEvent = z.infer<typeof MessageCreatedEventSchema>;

export const PartCreatedEventSchema = z.object({
  type: z.literal("part.created"),
  sessionId: z.string(),
  agentHarness: AgentHarnessSchema,
  messageId: z.string(),
  partId: z.string(),
  part: PartSchema,
});
export type PartCreatedEvent = z.infer<typeof PartCreatedEventSchema>;

export const PartDeltaEventSchema = z.object({
  type: z.literal("part.delta"),
  sessionId: z.string(),
  agentHarness: AgentHarnessSchema,
  partId: z.string(),
  delta: z.string(),
});
export type PartDeltaEvent = z.infer<typeof PartDeltaEventSchema>;

export const PartDoneEventSchema = z.object({
  type: z.literal("part.done"),
  sessionId: z.string(),
  agentHarness: AgentHarnessSchema,
  messageId: z.string(),
  partId: z.string(),
  part: PartSchema,
});
export type PartDoneEvent = z.infer<typeof PartDoneEventSchema>;

export const MessageDoneEventSchema = z.object({
  type: z.literal("message.done"),
  sessionId: z.string(),
  agentHarness: AgentHarnessSchema,
  messageId: z.string(),
  stopReason: z.string().optional(),
  parts: z.array(PartSchema),
  parentToolCallId: z.string().optional(),
});
export type MessageDoneEvent = z.infer<typeof MessageDoneEventSchema>;

export const TurnCompletedEventSchema = z.object({
  type: z.literal("turn.completed"),
  sessionId: z.string(),
  agentHarness: AgentHarnessSchema,
  messageId: z.string(),
  turnId: z.string().optional(),
  finishReason: FinishReasonSchema.optional(),
  tokens: TokenUsageSchema.optional(),
  cost: z.number().optional(),
});

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
  agentHarness: AgentHarnessSchema,
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
  SessionContextUsageEventSchema,
  // Messages
  MessageCancelledEventSchema,
  // Turn, message & part lifecycle
  TurnStartedEventSchema,
  MessageCreatedEventSchema,
  PartCreatedEventSchema,
  PartDeltaEventSchema,
  PartDoneEventSchema,
  MessageDoneEventSchema,
  TurnCompletedEventSchema,
  // Metadata
  AgentSessionIdEventSchema,
  SessionTitleEventSchema,
]);
export type AgentEvent = z.infer<typeof AgentEventSchema>;
