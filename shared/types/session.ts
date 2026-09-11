/**
 * Session and message-related TypeScript type definitions
 * Types for Claude Code session management and message handling
 */

// Canonical enum types — defined as Zod schemas in shared/enums.ts,
// imported here for local use and re-exported for backwards compat.
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
  /** Engine Part snapshots in stream order (attached by the backend). */
  parts?: Array<Part | UnknownPart>;
}

/** A turn owns its outcome and accounting, independently of its messages.
 * Older history can lack a recorded start time. */
export type SessionTurn = Omit<ConversationTurn, "status" | "errors" | "startedAt"> & {
  startedAt?: number;
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
 * Session information
 * Metadata about a Claude Code session
 * Matches the sessions database table schema
 */
export interface Session {
  id: string;
  workspace_id: string;
  agent_harness: import("../enums").AgentHarness;
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
