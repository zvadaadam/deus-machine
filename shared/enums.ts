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

export const AgentTypeSchema = z.enum(["claude", "codex"]);
export type AgentType = z.infer<typeof AgentTypeSchema>;

/** Structured error categories for agent error responses. */
export const ErrorCategorySchema = z.enum([
  "auth",
  "rate_limit",
  "context_limit",
  "network",
  "abort",
  "invalid_request",
  "db_write",
  "process_exit",
  "internal",
]);
export type ErrorCategory = z.infer<typeof ErrorCategorySchema>;
