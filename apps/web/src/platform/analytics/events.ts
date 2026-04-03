/**
 * Analytics Event Taxonomy — single source of truth for all tracked events.
 *
 * DATA MODEL DECISIONS:
 *
 *   Naming:  {object}_{action} in snake_case, past tense.
 *            object = domain noun (workspace, session, repo)
 *            action = past-tense verb (created, sent, opened)
 *            This reads naturally in PostHog queries: "show me all workspace_created".
 *
 *   Shape:   Flat records. No nesting. PostHog flattens nested objects anyway,
 *            so nesting just adds indirection with zero analytical benefit.
 *            Optional fields use `?` — callers omit when context is unavailable.
 *
 *   Context: Session context (model, agent_type) lives on events where it's
 *            analytically useful — message_sent, turn_completed, session_created.
 *            NOT on every event. PostHog person properties carry the "current"
 *            provider/theme/plan. Event properties carry per-action context.
 *            Duplicating session context onto unrelated events (diff_viewed, etc.)
 *            just inflates payload size with data PostHog already has via person props.
 *
 *   PII:     Properties are structural metadata only — never message content,
 *            file paths, API keys, or free-text user input.
 *
 * TYPE SYSTEM INVARIANTS:
 *   1. Every event key is a literal — no stringly-typed track() calls compile.
 *   2. Per-event property types are exact — extra/wrong fields are type errors.
 *   3. No-property events use Record<string, never> — track() accepts zero args.
 *   4. AnalyticsEvent = keyof AnalyticsEventMap — the map IS the schema.
 *   5. WithWorkspace / WithSession fragments enforce consistent field names
 *      across related events (no "workspace_id" vs "workspaceId" drift).
 *
 * ADDING A NEW EVENT:
 *   1. Add a key + property type to AnalyticsEventMap below.
 *   2. Call track("your_event", { ...props }) at the call site.
 *   That's it. TypeScript enforces correctness — no registration step.
 */

// ─── Property Fragments ─────────────────────────────────────────────────────
// Composition > inheritance. These enforce consistent field naming across
// related events without a class hierarchy. Internal only — not exported.

type WithWorkspace = { workspace_id: string };
type WithSession = { session_id: string };

// ─── Event Map ──────────────────────────────────────────────────────────────

export type AnalyticsEventMap = {
  // ── App Lifecycle ──────────────────────────────────────────────────────
  /** Fired once per boot after consent check passes. */
  app_launched: { version: string };

  // ── Onboarding ─────────────────────────────────────────────────────────
  onboarding_started: Record<string, never>;
  onboarding_step_viewed: { step: number; step_name: string };
  onboarding_completed: { duration_ms: number };

  // ── Repository ─────────────────────────────────────────────────────────
  /** repo_name derived from path — useful for filtering demo repo usage. */
  repo_added: { repo_name?: string };

  // ── Workspace ──────────────────────────────────────────────────────────
  workspace_created: { repository_id: string };
  workspace_archived: WithWorkspace;
  workspace_unarchived: WithWorkspace;
  workspace_status_changed: WithWorkspace & { status: string };
  /** Workspace init pipeline finished (initializing → ready or → error).
   *  duration_ms is approximate — includes polling latency (~2s window). */
  workspace_setup_completed: WithWorkspace & {
    setup_status: "completed" | "failed";
    duration_ms?: number;
  };

  // ── Session (AI Chat) ──────────────────────────────────────────────────
  session_created: WithWorkspace & {
    agent_type?: string;
    model?: string;
  };
  session_message_sent: WithSession & {
    has_images: boolean;
    model?: string;
    agent_type?: string;
    /** How many messages existed in this session before this one. */
    message_count?: number;
    /** 0–100: how full the context window is. Signals "about to compact". */
    context_used_percent?: number;
  };
  session_stopped: WithSession & { agent_type?: string };
  /** Agent finished a turn (working → idle transition).
   *  Detected via session status change in useGlobalSessionNotifications. */
  ai_turn_completed: WithSession & {
    agent_type?: string;
    model?: string;
    context_used_percent?: number;
  };
  /** Session entered error state. Category from agent-server error classification. */
  session_error_displayed: WithSession & {
    error_category?: string;
  };

  // ── Git / PR ───────────────────────────────────────────────────────────
  /** User initiated PR creation (via chat prompt or header action). */
  pr_create_requested: WithWorkspace & { target_branch: string };
  /** User clicked "Merge" on a ready-to-merge PR. High-signal completion event. */
  pr_merged: WithWorkspace & { pr_number?: number };

  // ── Feature Surfaces (Adoption Tracking) ───────────────────────────────
  // Each of these fires once per "open" action. Measures which features
  // users actually use vs. which gather dust.
  command_palette_opened: Record<string, never>;
  terminal_opened: { workspace_id?: string };
  browser_opened: { workspace_id?: string };
  simulator_opened: { workspace_id?: string };
  /** User opened the diff/changes panel for a workspace. */
  diff_viewed: { workspace_id?: string };
  /** User opened the files panel for a workspace. */
  files_opened: { workspace_id?: string };
  /** User opened the workspace in an external app (VS Code, Cursor, etc.). */
  open_in_app: { app_id: string; workspace_id?: string };

  // ── Settings ───────────────────────────────────────────────────────────
  /** key = setting name (e.g., "theme", "claude_provider").
   *  value = new value, ONLY for safe enum-type settings.
   *  Never include API keys, tokens, or free-text values. */
  setting_changed: { key: string; value?: string };

  // ── Errors ─────────────────────────────────────────────────────────────
  /** Catch-all error tracking. source = module/feature that errored.
   *  error_message is truncated to 200 chars — no stack traces. */
  error_occurred: { source: string; error_message: string };
};

export type AnalyticsEvent = keyof AnalyticsEventMap;
