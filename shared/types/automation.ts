/**
 * Automation type definitions — a prompt the agnt platform runs on a schedule,
 * in a cloud sandbox, with the Mac open or closed.
 *
 * Cloud-only: the platform (agnt Postgres + the Automation Durable Object) is
 * the source of truth; these rows are deus's CACHE of it, refreshed through
 * @deus-hq/sdk. Field names match the automations / automation_runs cache
 * tables (snake_case). `id` is the agnt automation id verbatim.
 */

import type {
  AutomationPausedReason,
  AutomationRunStatus,
  AutomationRunTrigger,
  AutomationSessionPolicy,
  AutomationStatus,
} from "../enums";

export interface Automation {
  /** agnt automation id. */
  id: string;
  /** Display name (the platform's mutable `description`; the org-unique
   *  platform `name` is a slug deus derives and never shows). */
  name: string;
  prompt: string;
  /** 5-field cron expression from the spec's cron trigger; null = webhook-only. */
  cron: string | null;
  /** IANA timezone of the cron trigger; null = UTC. */
  timezone: string | null;
  /** The spec's environment name — the repo link (repo-<slug>-<hash8>). */
  environment: string;
  /** Local repo resolved from the environment name; null when the repo isn't
   *  on this machine (automations are org-wide, repos are local). */
  repository_id: string | null;
  status: AutomationStatus;
  paused_reason: AutomationPausedReason | null;
  session_policy: AutomationSessionPolicy;
  /** Engine model id from the spec; null = platform default. */
  model: string | null;
  next_run_at: string | null;
  last_run_at: string | null;
  /** Platform-derived: failed runs since the last success/fence — 5 auto-pauses. */
  consecutive_failures: number;
  /** Who created it from THIS deus ("user" | "agent"); synced-in rows default "user". */
  created_by: string;
  /** Adopted deus workspace row for the automation's held sandbox, once opened. */
  workspace_id: string | null;
  /** When this cache row last mirrored the platform. */
  synced_at: string;
  updated_at: string;

  // ── Derived by the list/detail queries, never stored ──
  repo_name?: string | null;
  last_run_status?: AutomationRunStatus | null;
}

export interface AutomationRun {
  /** agnt run id. */
  id: string;
  automation_id: string;
  status: AutomationRunStatus;
  trigger: AutomationRunTrigger;
  /** agnt session id (fresh_session runs: sessionId === runId). */
  provider_session_id: string | null;
  /** Adopted deus rows, set when the run is opened in the app. */
  session_id: string | null;
  workspace_id: string | null;
  scheduled_at: string | null;
  started_at: string | null;
  completed_at: string | null;
  stop_reason: string | null;
  error_message: string | null;
  cost: number | null;
  summary: string | null;
}
