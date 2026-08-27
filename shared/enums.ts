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

/**
 * Where a workspace's files live. `worktree` = local git worktree under
 * {repo}/.deus/{slug}; `cloud` = an agnt-managed sandbox (files remote,
 * provider ids on the row).
 */
export const WorkspaceKindSchema = z.enum(["worktree", "cloud"]);
export type WorkspaceKind = z.infer<typeof WorkspaceKindSchema>;

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

// ── Automations ──────────────────────────────────────────────────────────
// Cloud-only: automations live on the agnt platform (scheduled and executed
// there — they fire with this Mac closed); deus mirrors them into a local
// cache. These enums mirror the platform's wire vocabulary exactly.

export const AutomationStatusSchema = z.enum(["active", "paused"]);
export type AutomationStatus = z.infer<typeof AutomationStatusSchema>;

/** Why a paused automation is paused. Resuming an auto_failures pause
 *  forgives the failure streak; resuming a manual pause does not. */
export const AutomationPausedReasonSchema = z.enum(["manual", "auto_failures"]);
export type AutomationPausedReason = z.infer<typeof AutomationPausedReasonSchema>;

/** fresh_session = a new session per run on the automation's held sandbox.
 *  same_session = one long-lived session the runs continue (heartbeat). */
export const AutomationSessionPolicySchema = z.enum(["fresh_session", "same_session"]);
export type AutomationSessionPolicy = z.infer<typeof AutomationSessionPolicySchema>;

export const AutomationRunStatusSchema = z.enum([
  "queued",
  "running",
  "succeeded",
  "failed",
  "skipped",
]);
export type AutomationRunStatus = z.infer<typeof AutomationRunStatusSchema>;

export const AutomationRunTriggerSchema = z.enum(["cron", "webhook", "manual"]);
export type AutomationRunTrigger = z.infer<typeof AutomationRunTriggerSchema>;
