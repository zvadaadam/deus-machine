// backend/src/services/automations/service.ts
// Automations orchestration — cloud-only. The agnt platform schedules,
// executes, settles and auto-pauses; this service is the deus half: validate
// early for instant UX errors, call the platform, mirror the result into the
// local cache, invalidate the WS subscriptions. One service, two callers:
// the q:mutate arms and the agent's deus/automation/* tool both land here.

import { Cron } from "croner";
import { uuidv7 } from "@shared/lib/uuid";
import { AutomationSessionPolicySchema } from "@shared/enums";
import type { Automation, AutomationRun } from "@shared/types";
import { httpsOrigin } from "@shared/git-origin";
import { getDatabase } from "../../lib/database";
import { getRepositoryById } from "../../db";
import { invalidate } from "../query-engine";
import { environmentNameForRepo, getCloudEnvironmentInfo } from "../cloud-environment.service";
import { generateUniqueName } from "../workspace.service";
import type { AutomationWithDetailsRow, RepositoryRow } from "../../db/types";
import * as platform from "./platform";
import * as store from "./store";

/** Platform parity: next-fire gaps must be at least 5 minutes apart. */
export const MIN_FIRE_INTERVAL_MS = 5 * 60 * 1000;

const AUTOMATION_RESOURCES = ["automations", "automation_runs"] as const;

// ─── Schedule preflight (instant UX errors; the platform re-validates) ───

export function validateSchedule(cron: string, timezone: string | null): void {
  let fires: Date[];
  try {
    // croner validates the timezone lazily (first date conversion), so the
    // sampling has to sit inside the try for a bad IANA name to surface here.
    fires = new Cron(cron, { timezone: timezone ?? undefined, paused: true }).nextRuns(25);
  } catch (err) {
    throw new Error(
      `Invalid schedule: ${err instanceof Error ? err.message : "unparseable cron expression"}`
    );
  }
  if (fires.length === 0) throw new Error("Invalid schedule: it never fires.");
  for (let i = 1; i < fires.length; i++) {
    if (fires[i].getTime() - fires[i - 1].getTime() < MIN_FIRE_INTERVAL_MS) {
      throw new Error("Schedules must be at least 5 minutes apart.");
    }
  }
}

// ─── Cache reads (the WS query layer is synchronous) ─────────

function toAutomation(row: AutomationWithDetailsRow): Automation {
  return row as unknown as Automation;
}

export function listAutomations(): Automation[] {
  return store.listAutomationsWithDetails().map(toAutomation);
}

export function getAutomation(id: string): Automation | null {
  const row = store.getAutomationWithDetails(id);
  return row ? toAutomation(row) : null;
}

export function listAutomationRuns(automationId: string): AutomationRun[] {
  return store.listRuns(automationId) as unknown as AutomationRun[];
}

export function automationsConfigured(): boolean {
  return platform.platformConfigured();
}

// ─── Repo ↔ environment link ─────────────────────────────────

function repoWithOrigin(repositoryId: string): RepositoryRow & { git_origin_url: string } {
  const repo = getRepositoryById(getDatabase(), repositoryId);
  if (!repo) throw new Error("Repository not found.");
  if (!repo.git_origin_url) {
    throw new Error(
      "Automations run in cloud sandboxes, so the repository needs a git remote — push it to GitHub first."
    );
  }
  return repo as RepositoryRow & { git_origin_url: string };
}

/** env name → local repo id, for mapping platform rows back to repos. */
async function repoIdByEnvName(): Promise<Map<string, string>> {
  const repos = getDatabase()
    .prepare("SELECT id, git_origin_url FROM repositories WHERE git_origin_url IS NOT NULL")
    .all() as Array<{ id: string; git_origin_url: string }>;
  const entries = await Promise.all(
    repos.map(
      async (repo) =>
        [await environmentNameForRepo(httpsOrigin(repo.git_origin_url)), repo.id] as const
    )
  );
  return new Map(entries);
}

/** The repo's derived environment, created platform-side when missing. */
async function ensureRepoEnvironment(repositoryId: string): Promise<string> {
  const repo = repoWithOrigin(repositoryId);
  const origin = httpsOrigin(repo.git_origin_url);
  const info = await getCloudEnvironmentInfo(origin);
  if (info.lookupFailed) {
    throw new Error("Deus Cloud is unreachable right now — try again in a moment.");
  }
  await platform.ensurePlatformEnvironment(info.name, origin, info.configured);
  return info.name;
}

// ─── Sync (platform → cache) ─────────────────────────────────

let refreshInFlight: Promise<void> | null = null;
let lastFullRefreshAt = 0;
const FULL_REFRESH_MIN_INTERVAL_MS = 5_000;

/**
 * Mirror the platform into the cache. With `automationId`, one automation +
 * its run ledger; without, the full list (throttled + single-flight — the
 * view fires this on mount and focus).
 */
export async function refreshAutomations(automationId?: string): Promise<void> {
  if (!platform.platformConfigured()) return;

  if (automationId) {
    const [summary, runs, envMap] = await Promise.all([
      platform.fetchAutomation(automationId),
      platform.fetchRuns(automationId),
      repoIdByEnvName(),
    ]);
    const previous = store.getAutomationRaw(automationId);
    store.upsertAutomation(platform.summaryToRow(summary, envMap, previous));
    store.upsertRuns(runs.map((run) => platform.runSummaryToRow(run, store.getRun(run.id))));
    invalidate([...AUTOMATION_RESOURCES]);
    return;
  }

  if (refreshInFlight) return refreshInFlight;
  if (Date.now() - lastFullRefreshAt < FULL_REFRESH_MIN_INTERVAL_MS) return;
  refreshInFlight = (async () => {
    try {
      const [summaries, envMap] = await Promise.all([
        platform.fetchAutomations(),
        repoIdByEnvName(),
      ]);
      const locals = store.localColumnsById();
      // Read BEFORE the replace: an automation whose platform last-run moved
      // has a stale run ledger — the list derives last_run_status from it, so
      // a new timestamp over an old failed row would show "Failed just now".
      const prevLastRun = store.lastRunAtById();
      store.replaceAutomationsCache(
        summaries.map((summary) => platform.summaryToRow(summary, envMap, locals.get(summary.id)))
      );
      const changed = summaries.filter((summary) => {
        const prev = prevLastRun.get(summary.id);
        return prev !== undefined && summary.lastRunAt !== null && prev !== summary.lastRunAt;
      });
      await Promise.all(
        changed.map(async (summary) => {
          const runs = await platform.fetchRuns(summary.id);
          store.upsertRuns(runs.map((run) => platform.runSummaryToRow(run, store.getRun(run.id))));
        })
      );
      lastFullRefreshAt = Date.now();
      invalidate(changed.length > 0 ? [...AUTOMATION_RESOURCES] : ["automations"]);
    } finally {
      refreshInFlight = null;
    }
  })();
  return refreshInFlight;
}

/** Boot / credentials-arrived hook: best-effort background mirror. */
export function initAutomations(): void {
  if (!platform.platformConfigured()) {
    // Sign-out (or boot before credentials arrive): the cache must not keep
    // serving the previous identity's prompts and run history — list/view
    // stay live app-wide and the agent tool reads the same cache. Runs
    // cascade with their automations.
    store.replaceAutomationsCache([]);
    invalidate([...AUTOMATION_RESOURCES]);
    return;
  }
  void refreshAutomations().catch((err) => {
    console.warn("[Automations] initial platform sync failed:", err);
  });
}

// ─── CRUD ────────────────────────────────────────────────────

export interface AutomationInput {
  repository_id: string;
  name: string;
  prompt: string;
  cron: string;
  timezone?: string | null;
  session_policy?: string;
  model?: string | null;
}

interface ValidatedInput {
  repository_id: string;
  name: string;
  prompt: string;
  cron: string;
  timezone: string | null;
  session_policy: "fresh_session" | "same_session";
  model: string | null;
}

const NAME_MAX = 120;
const PROMPT_MAX = 32_768;

function validateInput(input: AutomationInput): ValidatedInput {
  const name = input.name?.trim();
  if (!name) throw new Error("Automation needs a name.");
  if (name.length > NAME_MAX) throw new Error(`Name is too long (max ${NAME_MAX} characters).`);
  const prompt = input.prompt?.trim();
  if (!prompt) throw new Error("Automation needs a prompt.");
  if (prompt.length > PROMPT_MAX) throw new Error("Prompt is too long.");
  const timezone = input.timezone?.trim() || null;
  validateSchedule(input.cron, timezone);
  return {
    repository_id: input.repository_id,
    name,
    prompt,
    cron: input.cron.trim(),
    timezone,
    session_policy: AutomationSessionPolicySchema.parse(input.session_policy ?? "fresh_session"),
    model: input.model?.trim() || null,
  };
}

export async function createAutomation(
  input: AutomationInput,
  createdBy: "user" | "agent"
): Promise<Automation> {
  platform.requirePlatform();
  const valid = validateInput(input);
  // Scheduling something that can never run is worse than refusing: without a
  // Claude turn credential every fire fails until auto-pause. (Call-time
  // import: the settings status lives beside the cloud driver, which imports
  // this module through the agent service graph.)
  const { getCloudSettingsStatus } = await import("../cloud-workspace-init.service");
  const status = await getCloudSettingsStatus();
  if (!status.hasClaudeTurnCredential) {
    throw new Error(
      "Deus Cloud can't run Claude yet — add your Claude subscription or an Anthropic API key under Settings → Cloud, then create the automation."
    );
  }
  const environment = await ensureRepoEnvironment(valid.repository_id);
  const id = await platform.createPlatformAutomation({
    displayName: valid.name,
    prompt: valid.prompt,
    cron: valid.cron,
    timezone: valid.timezone,
    environment,
    model: valid.model,
    sessionPolicy: valid.session_policy,
  });
  // Seed the row directly with its provenance — writing a "user"-labelled row
  // first and patching created_by after would broadcast the intermediate
  // state to every subscriber. A fresh automation has no runs to pull.
  const [summary, envMap] = await Promise.all([platform.fetchAutomation(id), repoIdByEnvName()]);
  store.upsertAutomation(
    platform.summaryToRow(summary, envMap, { created_by: createdBy, workspace_id: null })
  );
  invalidate([...AUTOMATION_RESOURCES]);
  const created = getAutomation(id);
  if (!created) throw new Error("Automation not found after creation");
  return created;
}

export async function updateAutomation(
  id: string,
  input: Partial<AutomationInput>
): Promise<Automation> {
  const existing = store.getAutomationRaw(id);
  if (!existing) throw new Error("Automation not found.");

  // The platform spec is ONE document (full replacement, not a merge target),
  // and the cache doesn't carry every field (mcpServers, delivery, overlap) —
  // so patch on top of the platform's CURRENT spec, never a rebuilt one.
  const summary = await platform.fetchAutomation(id);
  const spec = { ...summary.spec };

  const name = input.name?.trim() || (summary.description?.trim() ?? summary.name);
  if (input.prompt !== undefined) {
    const prompt = input.prompt.trim();
    if (!prompt) throw new Error("Automation needs a prompt.");
    spec.prompt = prompt;
  }
  if (input.cron !== undefined || input.timezone !== undefined) {
    const cron = input.cron?.trim() || existing.cron;
    if (!cron) throw new Error("Automation needs a schedule.");
    const timezone =
      input.timezone !== undefined ? input.timezone?.trim() || null : existing.timezone;
    validateSchedule(cron, timezone);
    spec.triggers = [
      ...spec.triggers.filter((t) => t.type !== "cron"),
      { type: "cron", cron, ...(timezone ? { timezone } : {}) },
    ];
  }
  if (input.session_policy !== undefined) {
    spec.sessionPolicy = AutomationSessionPolicySchema.parse(input.session_policy);
  }
  if (input.model !== undefined) {
    const model = input.model?.trim();
    if (model) spec.model = model;
    else delete spec.model;
  }
  if (input.repository_id !== undefined && input.repository_id !== existing.repository_id) {
    spec.environment = await ensureRepoEnvironment(input.repository_id);
    // The held sandbox belongs to the old repo — drop the adoption link.
    store.updateLocalColumns(id, { workspace_id: null });
  }

  await platform.updatePlatformAutomation(id, { description: name, spec });
  await refreshAutomations(id);
  const updated = getAutomation(id);
  if (!updated) throw new Error("Automation not found after update");
  return updated;
}

/** Pause/resume — the platform owns the forgive-on-resume fence semantics. */
export async function toggleAutomation(
  id: string,
  status: "active" | "paused"
): Promise<Automation> {
  if (!store.getAutomationRaw(id)) throw new Error("Automation not found.");
  if (status === "paused") await platform.pausePlatformAutomation(id);
  else await platform.resumePlatformAutomation(id);
  await refreshAutomations(id);
  const updated = getAutomation(id);
  if (!updated) throw new Error("Automation not found after toggle");
  return updated;
}

export async function deleteAutomation(id: string): Promise<void> {
  if (!store.getAutomationRaw(id)) throw new Error("Automation not found.");
  await platform.deletePlatformAutomation(id);
  store.deleteAutomationRow(id);
  invalidate([...AUTOMATION_RESOURCES]);
}

/** Manual "Run now" — a platform fire; works on paused automations by design. */
export async function runAutomationNow(id: string): Promise<string> {
  const automation = store.getAutomationRaw(id);
  if (!automation) throw new Error("Automation not found.");
  const { runId, status } = await platform.triggerPlatformAutomation(id, uuidv7());
  // Seed the ledger row immediately; the detail view's live-run refresh
  // converges it onto the platform truth as the run progresses.
  store.upsertRuns([
    {
      id: runId,
      automation_id: id,
      status,
      trigger: "manual",
      provider_session_id: null,
      session_id: null,
      workspace_id: null,
      scheduled_at: new Date().toISOString(),
      started_at: null,
      completed_at: null,
      stop_reason: null,
      error_message: null,
      cost: null,
      summary: null,
    },
  ]);
  invalidate([...AUTOMATION_RESOURCES]);
  return runId;
}

// ─── Run adoption (open a sandbox run in the app) ────────────

/**
 * Adopt a run's sandbox into deus rows so it opens like any cloud workspace:
 * find-or-create the workspace row (by the platform workspace id) and the
 * session row (by the platform session id), point current_session_id at it,
 * and attach the live session channel. Transcript history for runs that fired
 * while deus was closed is a known follow-up (SessionDetail.messages exists
 * platform-side); the live channel + run summary carry v1.
 */
export async function openAutomationRun(
  runId: string
): Promise<{ workspaceId: string; sessionId: string }> {
  const run = store.getRun(runId);
  if (!run) throw new Error("Run not found.");
  const automation = store.getAutomationRaw(run.automation_id);
  if (!automation) throw new Error("Automation not found.");

  // Already adopted — reuse the rows, but heal the transcript first: the run
  // may have finished (or continued) while deus was closed, and a PARTIAL
  // transcript is as stale as an empty one — a message-count gate would
  // freeze it forever. The insert path is idempotent, so backfill always.
  if (run.session_id && run.workspace_id && store.sessionExists(run.session_id)) {
    if (run.provider_session_id) {
      await backfillTranscript(run.session_id, run.provider_session_id);
    }
    return { workspaceId: run.workspace_id, sessionId: run.session_id };
  }

  if (!run.provider_session_id) {
    throw new Error("This run has no session to open (it was skipped or never started).");
  }
  if (!automation.repository_id) {
    throw new Error("This automation's repository isn't on this Mac.");
  }

  const detail = await platform.fetchSessionDetail(run.provider_session_id);
  if (!detail.workspaceId) throw new Error("The run's sandbox is gone.");

  const { workspaceId, sessionId } = store.adoptRunRows({
    runId,
    automationId: automation.id,
    repositoryId: automation.repository_id,
    automationName: automation.name,
    providerSessionId: run.provider_session_id,
    providerWorkspaceId: detail.workspaceId,
    newWorkspaceSlug: () => generateUniqueName(getDatabase()),
  });

  // Backfill the transcript from the platform's stored messages — the run
  // executed server-side, so the live channel never folded its events here.
  const inserted = store.backfillSessionTranscript(sessionId, detail.messages);
  if (inserted > 0) {
    console.log(
      `[Automations] backfilled ${inserted} message(s) for adopted run ${runId} → session ${sessionId}`
    );
  }
  invalidate(["workspaces", "sessions", "session", "messages", "stats", ...AUTOMATION_RESOURCES], {
    sessionIds: [sessionId],
  });

  // Attach the live session channel (call-time import: the driver sits in the
  // agent service graph, which imports this module through the tool dispatch).
  void import("../agent/cloud/driver")
    .then(({ ensureCloudSession }) => ensureCloudSession(sessionId))
    .catch((err) => {
      console.warn(`[Automations] session channel attach failed for run ${runId}:`, err);
    });

  return { workspaceId, sessionId };
}

/** Heal an adopted-but-empty transcript from the platform's stored messages. */
async function backfillTranscript(deusSessionId: string, providerSessionId: string): Promise<void> {
  try {
    const detail = await platform.fetchSessionDetail(providerSessionId);
    const inserted = store.backfillSessionTranscript(deusSessionId, detail.messages);
    if (inserted > 0) {
      invalidate(["sessions", "session", "messages"], { sessionIds: [deusSessionId] });
    }
  } catch (err) {
    console.warn(`[Automations] transcript backfill failed for ${deusSessionId}:`, err);
  }
}
