// shared/enums.ts
// Canonical Zod enum schemas — single source of truth for all discriminator
// enums used across frontend, backend, and agent-server.
//
// Import the *Schema when you need runtime validation (Zod .parse/.safeParse).
// Import the inferred *type* when you only need TypeScript checking.
// Both are exported from this file.

import { z } from "zod";

// ── Session ──────────────────────────────────────────────────────────────

/** All possible session statuses across the full lifecycle. */
export const SessionStatusSchema = z.enum([
  "idle",
  "working",
  "error",
  "needs_response",
  "needs_plan_response",
]);
export type SessionStatus = z.infer<typeof SessionStatusSchema>;

const MessageRoleSchema = z.enum(["user", "assistant"]);
export type MessageRole = z.infer<typeof MessageRoleSchema>;

// ── Workspace ────────────────────────────────────────────────────────────

/** Workspace lifecycle states (git worktree). */
export const WorkspaceStateSchema = z.enum(["ready", "initializing", "archived", "error"]);
export type WorkspaceState = z.infer<typeof WorkspaceStateSchema>;

/** Workspace initialization progress. */
const SetupStatusSchema = z.enum(["none", "running", "completed", "failed"]);
export type SetupStatus = z.infer<typeof SetupStatusSchema>;

/** Workflow states for workspaces. */
export const WorkspaceStatusSchema = z.enum([
  "backlog",
  "in-progress",
  "in-review",
  "done",
  "canceled",
]);
export type WorkspaceStatus = z.infer<typeof WorkspaceStatusSchema>;
export const WORKFLOW_STATUSES = WorkspaceStatusSchema.options;

/** Sticky states resist auto-progression. Only user action (or archive) can exit. */
export const STICKY_STATUSES: ReadonlySet<WorkspaceStatus> = new Set(["backlog", "canceled"]);

/** Numeric rank for progression comparison. canceled is -1 (side-exit, not in flow). */
export const STATUS_RANK: Record<WorkspaceStatus, number> = {
  backlog: 0,
  "in-progress": 1,
  "in-review": 2,
  done: 3,
  canceled: -1,
};

// ── Agent ────────────────────────────────────────────────────────────────

/**
 * The agent harness bound to a session: the SDK/CLI wrapper that owns the
 * agent process lifecycle. These are the @zvada/agent-server engine ids
 * verbatim — deus has no alias layer. (The engine also drives `acp`; deus
 * doesn't offer it in the composer yet, so it stays out of this enum.)
 *
 * Once a session has messages, its harness is fixed — the engine binds the
 * session to a specific runtime and cannot switch mid-session. See the
 * harness-lock guard in apps/backend/src/services/agent/commands.ts.
 *
 * Display names ("Claude", "Codex") are a frontend concern, never wire values.
 */
export const AgentHarnessSchema = z.enum(["claude-code", "codex-sdk", "codex-app-server"]);
export type AgentHarness = z.infer<typeof AgentHarnessSchema>;
