/**
 * Session and message-related TypeScript type definitions
 * Types for Claude Code session management and message handling
 */

// Canonical enum types — defined as Zod schemas in shared/enums.ts,
// imported here for local use and re-exported for the session types' importers.
import type { MessageRole, SessionStatus } from "../enums";
import type { ConversationTurn, Part, UnknownPart } from "../protocol-types";
import type { TurnProviderCredentialSource } from "@deus-hq/api";
export type { MessageRole, SessionStatus };

/**
 * Base message entity
 * Core structure for all chat messages in a session
 * Matches the messages database table schema (id = UUID7, embeds created_at)
 */
export interface Message {
  id: string;
  session_id: string;
  seq: number; // Per-session monotonic sequence number (auto-assigned by trigger)
  role: MessageRole;
  turn_id?: string | null; // The turn this message belongs to (engine turnId)
  sent_at?: string | null; // ISO timestamp of the engine's message.started
  model?: string | null; // Model that produced the message
  /** Set when this message is a subagent's output: the toolCallId that spawned it. */
  parent_tool_call_id?: string | null;
  /** Who sent a user message when not the person: another chat, or an outside assistant. */
  origin?: import("@zvada/agent-server/protocol").ReportedOrigin | null;
  /** Engine Part snapshots in stream order (attached by the backend). */
  parts?: Array<Part | UnknownPart>;
}

/** A turn owns its outcome and accounting, independently of its messages.
 * Older history can lack a recorded start time. */
export type SessionTurn = Omit<ConversationTurn, "status" | "errors" | "startedAt"> & {
  startedAt?: number;
  execution?: NonNullable<ConversationTurn["execution"]> & {
    via?: string;
    gatewayRef?: string;
    modelLabel?: string;
  };
  providerCredentialSource?: TurnProviderCredentialSource;
};

/** One row of the `compactions` table (the engine's session.compaction entity). */
export interface Compaction {
  compaction_id: string;
  session_id: string;
  turn_id: string;
  status: string;
  trigger?: string | null;
  pre_tokens?: number | null;
  post_tokens?: number | null;
  summary?: string | null;
  created_at: string;
}

/**
 * One page of a session's transcript, newest messages last.
 *
 * `compactions` is required, not optional: an answer that left it out was
 * indistinguishable from a session that never compacted, and every divider
 * vanished from the transcript without the types objecting.
 */
export interface PaginatedMessages {
  messages: Message[];
  turns: SessionTurn[];
  /** Positional siblings of messages, not parts: the transcript orders them. */
  compactions: Compaction[];
  has_older: boolean;
  has_newer: boolean;
}

/** A chat as its host reports it. */
export interface Session {
  id: string;
  workspace_id: string;
  /** A chat written by another build can name a harness this one does not run. */
  agent_harness: string;
  /** True once this local chat's agent has been given the tool to message the person. */
  agent_messages: boolean;
  gateway_generation?: string | null;
  agent_session_id?: string | null;
  /** agnt cloud session id — the direct lane connects to this (cloud only). */
  provider_session_id?: string | null;
  title?: string | null;
  status: SessionStatus;
  message_count: number;
  error_message?: string | null;
  error_category?: import("../protocol-types").ErrorCategory | null;
  last_user_message_at?: string | null;
  context_token_count: number;
  context_used_percent: number;
  is_hidden: boolean; // SQLite INTEGER → TS boolean (0/1)
  updated_at: string;
  // From JOINs (present in list/detail queries)
  slug?: string | null;
  workspace_state?: string | null;
  /** Owning workspace's kind — joined on s.workspace_id (drives the direct lane). */
  workspace_kind?: import("../enums").WorkspaceKind | null;
}
