// backend/src/services/automations/platform.ts
// The @deus-hq/sdk boundary: every agnt call the automations feature makes,
// plus the wire→cache-row mapping. The platform is the source of truth —
// it schedules, executes, settles and auto-pauses; deus only mirrors.

import {
  createAutomation as sdkCreateAutomation,
  getAutomation as sdkGetAutomation,
  listAutomations as sdkListAutomations,
  updateAutomation as sdkUpdateAutomation,
  deleteAutomation as sdkDeleteAutomation,
  pauseAutomation as sdkPauseAutomation,
  resumeAutomation as sdkResumeAutomation,
  triggerAutomation as sdkTriggerAutomation,
  listAutomationRuns as sdkListAutomationRuns,
  getSession as sdkGetSession,
  createEnvironment as sdkCreateEnvironment,
  Environment,
  type AutomationSummary,
  type AutomationRunSummary,
  type AutomationSpec,
} from "@deus-hq/sdk";
import { getCloudConfig } from "../agent/cloud/config";
import type { AutomationRow, AutomationRunRow } from "../../db/types";

/** Org caps mirrored from the platform (soft limits, kept for pagination). */
const LIST_CAP = 100;
const RUNS_CAP = 50;

interface PlatformAuth {
  baseUrl: string;
  apiKey: string;
}

/** The cloud lane's gate. Every automation call goes through this. */
export function requirePlatform(): PlatformAuth {
  const config = getCloudConfig();
  if (!config) {
    throw new Error("Automations run in Deus Cloud — sign in under Settings → Cloud to use them.");
  }
  return { baseUrl: config.baseUrl, apiKey: config.apiKey };
}

export function platformConfigured(): boolean {
  return getCloudConfig() !== null;
}

// ─── Wire → cache-row mapping ────────────────────────────────

function cronTriggerOf(spec: AutomationSpec): { cron: string; timezone?: string } | null {
  const trigger = spec.triggers.find((t) => t.type === "cron");
  return trigger && trigger.type === "cron" ? trigger : null;
}

/**
 * Map a platform summary onto the cache-row shape. `repoIdByEnvName` links
 * the spec's environment name back to a local repo (null when the repo isn't
 * on this machine); `previous` preserves the deus-local columns the platform
 * doesn't know (created_by, adopted workspace).
 */
export function summaryToRow(
  summary: AutomationSummary,
  repoIdByEnvName: Map<string, string>,
  previous?: Pick<AutomationRow, "created_by" | "workspace_id">
): Omit<AutomationRow, "synced_at"> {
  const cron = cronTriggerOf(summary.spec);
  return {
    id: summary.id,
    name: summary.description?.trim() || summary.name,
    prompt: summary.spec.prompt,
    cron: cron?.cron ?? null,
    timezone: cron?.timezone ?? null,
    environment: summary.spec.environment,
    repository_id: repoIdByEnvName.get(summary.spec.environment) ?? null,
    status: summary.status,
    paused_reason: summary.pausedReason,
    session_policy: summary.spec.sessionPolicy,
    model: summary.spec.model ?? null,
    next_run_at: summary.nextRunAt,
    last_run_at: summary.lastRunAt,
    consecutive_failures: summary.consecutiveFailures,
    created_by: previous?.created_by ?? "user",
    workspace_id: previous?.workspace_id ?? null,
    updated_at: summary.updatedAt,
  };
}

export function runSummaryToRow(
  run: AutomationRunSummary,
  previous?: Pick<AutomationRunRow, "session_id" | "workspace_id">
): AutomationRunRow {
  return {
    id: run.id,
    automation_id: run.automationId,
    status: run.status,
    trigger: run.triggerMetadata.type,
    provider_session_id: run.sessionId,
    session_id: previous?.session_id ?? null,
    workspace_id: previous?.workspace_id ?? null,
    scheduled_at: run.scheduledAt,
    started_at: run.startedAt,
    completed_at: run.completedAt,
    stop_reason: run.stopReason,
    error_message: run.error?.message ?? null,
    cost: run.cost,
    // Fold the skip reason into the summary slot — one line per run in the UI.
    summary: run.summary ?? run.skipReason,
  };
}

// ─── Platform calls ──────────────────────────────────────────

export async function fetchAutomations(): Promise<AutomationSummary[]> {
  const auth = requirePlatform();
  const out: AutomationSummary[] = [];
  for await (const summary of sdkListAutomations(auth)) {
    out.push(summary);
    if (out.length >= LIST_CAP) break;
  }
  return out;
}

export async function fetchAutomation(id: string): Promise<AutomationSummary> {
  return sdkGetAutomation(id, requirePlatform());
}

export async function fetchRuns(automationId: string): Promise<AutomationRunSummary[]> {
  const auth = requirePlatform();
  const out: AutomationRunSummary[] = [];
  for await (const run of sdkListAutomationRuns(automationId, auth)) {
    out.push(run);
    if (out.length >= RUNS_CAP) break;
  }
  return out;
}

export interface CreatePlatformAutomationInput {
  displayName: string;
  prompt: string;
  cron: string;
  timezone: string | null;
  environment: string;
  model: string | null;
  sessionPolicy: "fresh_session" | "same_session";
}

/**
 * The platform `name` is org-unique, lowercase-hyphen, immutable, and usable
 * as an ID-or-name ref — so deus derives a slug and keeps the human name in
 * `description` (mutable). One retry with a random suffix absorbs collisions.
 */
function slugName(displayName: string): string {
  const slug = displayName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60);
  if (!slug) return "automation";
  // The platform's name grammar demands a leading letter ("24/7 monitor"
  // would otherwise fail validation, which the 409-only retry never catches).
  return /^[a-z]/.test(slug) ? slug : `auto-${slug}`.slice(0, 60);
}

export async function createPlatformAutomation(
  input: CreatePlatformAutomationInput
): Promise<string> {
  const auth = requirePlatform();
  const base = {
    ...auth,
    description: input.displayName,
    prompt: input.prompt,
    cron: input.cron,
    ...(input.timezone ? { timezone: input.timezone } : {}),
    environment: input.environment,
    ...(input.model ? { model: input.model } : {}),
    sessionPolicy: input.sessionPolicy,
  };
  try {
    const handle = await sdkCreateAutomation({ ...base, name: slugName(input.displayName) });
    return handle.id;
  } catch (err) {
    // Org-unique name collision — retry once with a random suffix.
    if ((err as { statusCode?: number }).statusCode === 409) {
      const suffix = Math.random().toString(16).slice(2, 6);
      const handle = await sdkCreateAutomation({
        ...base,
        name: `${slugName(input.displayName).slice(0, 55)}-${suffix}`,
      });
      return handle.id;
    }
    throw err;
  }
}

export async function updatePlatformAutomation(
  id: string,
  update: { description?: string; spec?: AutomationSpec; status?: "active" | "paused" }
): Promise<void> {
  await sdkUpdateAutomation(id, { ...requirePlatform(), ...update });
}

export async function deletePlatformAutomation(id: string): Promise<void> {
  await sdkDeleteAutomation(id, requirePlatform());
}

export async function pausePlatformAutomation(id: string): Promise<void> {
  await sdkPauseAutomation(id, requirePlatform());
}

export async function resumePlatformAutomation(id: string): Promise<void> {
  await sdkResumeAutomation(id, requirePlatform());
}

export async function triggerPlatformAutomation(
  id: string,
  idempotencyKey: string
): Promise<{ runId: string; status: string }> {
  const response = await sdkTriggerAutomation(id, { ...requirePlatform(), idempotencyKey });
  return { runId: response.runId, status: response.status };
}

export interface PlatformSessionDetail {
  workspaceId: string | null;
  /** Engine-shaped messages (the platform stores the same vocabulary deus
   *  persists verbatim) — the transcript-backfill source for adopted runs. */
  messages: Array<Record<string, unknown>>;
}

/** The run's sandbox workspace + transcript, resolved through its agnt session. */
export async function fetchSessionDetail(sessionId: string): Promise<PlatformSessionDetail> {
  const detail = await sdkGetSession(sessionId, requirePlatform());
  return {
    workspaceId: detail.workspaceId,
    messages: (detail.messages ?? []) as unknown as Array<Record<string, unknown>>,
  };
}

/**
 * Ensure a named environment exists for the repo. When the agent-authored one
 * is missing, create a minimal recipe (base image + repo clone) under the SAME
 * derived name — the agent's richer config can replace it later through the
 * normal environment-setup flow, and git auth resolves from org-scoped
 * secrets (PAT / App token) exactly like named-environment workspaces do.
 */
export async function ensurePlatformEnvironment(
  name: string,
  httpsOriginUrl: string,
  alreadyConfigured: boolean
): Promise<void> {
  if (alreadyConfigured) return;
  const auth = requirePlatform();
  await sdkCreateEnvironment({
    ...auth,
    name,
    environment: Environment.from("agnt-base").repo(httpsOriginUrl),
  });
}
