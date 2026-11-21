// backend/src/services/automations/service.ts
// Automations orchestration — cloud-only. The agnt platform schedules,
// executes, settles and auto-pauses; this service is the deus half: validate
// early for instant UX errors, call the platform, mirror the result into the
// local cache, invalidate the WS subscriptions. One service, two callers:
// the operations in api/automations.ts and the agent's deus/automation/* tool
// both land here.

import { Cron } from "croner";
import {
  AUTOMATION_HARNESS,
  cloudModelChoiceProblem,
  readCloudThinkingLevel,
  type CloudThinkingLevel,
} from "@shared/cloud-models";
import { uuidv7 } from "@shared/lib/uuid";
import { AutomationSessionPolicySchema } from "@shared/enums";
import type { Automation, AutomationRun } from "@shared/types";
import { httpsOrigin } from "@shared/git-origin";
import { getDatabase } from "../../lib/database";
import { ConflictError, NotFoundError, ValidationError } from "../../lib/errors";
import { getRepositoryById } from "../../db";
import { sessionEvents } from "@shared/api/sessions";
import { invalidate } from "../query-engine";
import { resetSubscribers } from "../streams";
import { environmentNameForRepo, getCloudEnvironmentInfo } from "../cloud-environment.service";
import { generateUniqueName } from "../workspace.service";
import type { RepositoryRow } from "../../db/types";
import * as platform from "./platform";
import * as store from "./store";
import { adoptRunRows, reviveAdoptedWorkspace } from "../workspace-lifecycle";
import { getProviderAccounts } from "../provider-accounts.service";
import { defaultProviderAccount } from "@shared/types/provider-account";
import {
  cloudOrgKeyIds,
  defaultCloudOrgId,
  getCloudConnectionIdentity,
} from "../agent/cloud/config";
import { getCloudModelLists } from "../agent/cloud/models";

/** Platform parity: next-fire gaps must be at least 5 minutes apart. */
export const MIN_FIRE_INTERVAL_MS = 5 * 60 * 1000;

const AUTOMATION_RESOURCES = ["automations", "automationRuns"] as const;

function assertCurrentAccount(identity: string): void {
  if (getCloudConnectionIdentity() !== identity) {
    throw new ConflictError("Your Deus account changed. Refresh automations and try again.");
  }
}

// ─── Schedule preflight (instant UX errors; the platform re-validates) ───

export function validateSchedule(cron: string, timezone: string | null): void {
  let fires: Date[];
  try {
    // croner validates the timezone lazily (first date conversion), so the
    // sampling has to sit inside the try for a bad IANA name to surface here.
    fires = new Cron(cron, { timezone: timezone ?? undefined, paused: true }).nextRuns(25);
  } catch (err) {
    throw new ValidationError(
      `Invalid schedule: ${err instanceof Error ? err.message : "unparseable cron expression"}`
    );
  }
  if (fires.length === 0) throw new ValidationError("Invalid schedule: it never fires.");
  for (let i = 1; i < fires.length; i++) {
    if (fires[i].getTime() - fires[i - 1].getTime() < MIN_FIRE_INTERVAL_MS) {
      throw new ValidationError("Schedules must be at least 5 minutes apart.");
    }
  }
}

// ─── Cache reads (the WS query layer is synchronous) ─────────

export function listAutomations(): Automation[] {
  return store.listAutomationsWithDetails();
}

export function getAutomation(id: string): Automation | null {
  return store.getAutomationWithDetails(id) ?? null;
}

export function listAutomationRuns(automationId: string): AutomationRun[] {
  return store.listRuns(automationId);
}

// ─── Repo ↔ environment link ─────────────────────────────────

function repoWithOrigin(repositoryId: string): RepositoryRow & { git_origin_url: string } {
  const repo = getRepositoryById(getDatabase(), repositoryId);
  if (!repo) throw new NotFoundError("Repository not found.");
  if (!repo.git_origin_url) {
    throw new ValidationError(
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

/** The repo's derived environment in the automation's organization, created platform-side when missing. */
async function ensureRepoEnvironment(
  repositoryId: string,
  identity: string,
  orgId: string | null
): Promise<string> {
  const repo = repoWithOrigin(repositoryId);
  const origin = httpsOrigin(repo.git_origin_url);
  const info = await getCloudEnvironmentInfo(origin, orgId);
  assertCurrentAccount(identity);
  if (info.lookupFailed) {
    throw new Error("Deus Cloud is unreachable right now — try again in a moment.");
  }
  await platform.ensurePlatformEnvironment(info.name, origin, info.configured, orgId);
  return info.name;
}

/** The organization an automation was listed under; a row from before that was kept is the default's. */
function orgOfAutomation(id: string): string | null {
  return store.getAutomationRaw(id)?.organization_id ?? defaultCloudOrgId();
}

// ─── Sync (platform → cache) ─────────────────────────────────

/** Per organization: the full refresh in flight and when the last one finished. */
const refreshInFlight = new Map<string | null, Promise<void>>();
let cacheIdentity: string | null = null;
const lastFullRefreshAt = new Map<string | null, number>();
/** Per organization, bumped by every scoped write in it (create/update/toggle/
 *  delete/refresh(id)) — a full refresh of that organization whose platform
 *  snapshot predates it must not replace the cache with stale rows (or
 *  resurrect a just-deleted one). Another organization's write says nothing
 *  about this one's list. */
const lastScopedWriteAt = new Map<string | null, number>();
const FULL_REFRESH_MIN_INTERVAL_MS = 5_000;

export function markScopedWrite(orgId: string | null): void {
  lastScopedWriteAt.set(orgId, Date.now());
}

/**
 * Mirror the platform into the cache. With `automationId`, one automation +
 * its run ledger, in the organization it was listed under; without, one
 * organization's full list (the default one unless named; throttled +
 * single-flight per organization — the view fires this on mount and focus).
 * A full list replaces only that organization's rows.
 */
export async function refreshAutomations(
  automationId?: string,
  organizationId?: string | null
): Promise<void> {
  if (!platform.platformConfigured()) return;
  const identity = getCloudConnectionIdentity();
  if (cacheIdentity !== identity) {
    cacheIdentity = identity;
    refreshInFlight.clear();
    lastFullRefreshAt.clear();
    lastScopedWriteAt.clear();
    store.replaceAutomationsCache([]);
    invalidate([...AUTOMATION_RESOURCES]);
  }

  if (automationId) {
    const orgId =
      store.getAutomationRaw(automationId)?.organization_id ??
      organizationId ??
      defaultCloudOrgId();
    const [summary, runs, envMap] = await Promise.all([
      platform.fetchAutomation(automationId, orgId),
      platform.fetchRuns(automationId, orgId),
      repoIdByEnvName(),
    ]);
    if (getCloudConnectionIdentity() !== identity) return;
    const previous = store.getAutomationRaw(automationId);
    store.upsertAutomation(platform.summaryToRow(summary, envMap, previous, orgId));
    store.upsertRuns(runs.map((run) => platform.runSummaryToRow(run, store.getRun(run.id))));
    markScopedWrite(orgId);
    invalidate([...AUTOMATION_RESOURCES]);
    return;
  }

  const orgId = organizationId ?? defaultCloudOrgId();
  const inFlight = refreshInFlight.get(orgId);
  if (inFlight) return inFlight;
  if (Date.now() - (lastFullRefreshAt.get(orgId) ?? 0) < FULL_REFRESH_MIN_INTERVAL_MS) return;
  const refresh = (async () => {
    const snapshotStartedAt = Date.now();
    const [summaries, envMap] = await Promise.all([
      platform.fetchAutomations(orgId),
      repoIdByEnvName(),
    ]);
    if (getCloudConnectionIdentity() !== identity) return;
    // A scoped write landed while this list was in flight — its snapshot
    // is already stale; dropping it beats restoring an old name/status or
    // resurrecting a deleted row. The next mount/focus refresh converges.
    if ((lastScopedWriteAt.get(orgId) ?? 0) > snapshotStartedAt) return;
    const locals = store.localColumnsById();
    // Read BEFORE the replace: an automation whose platform last-run moved
    // has a stale run ledger — the list derives last_run_status from it, so
    // a new timestamp over an old failed row would show "Failed just now".
    const prevLastRun = store.lastRunAtById();
    store.replaceAutomationsCache(
      summaries.map((summary) =>
        platform.summaryToRow(summary, envMap, locals.get(summary.id), orgId)
      ),
      { organizationId: orgId }
    );
    const changed = summaries.filter((summary) => {
      const prev = prevLastRun.get(summary.id);
      return prev !== undefined && summary.lastRunAt !== null && prev !== summary.lastRunAt;
    });
    await Promise.all(
      changed.map(async (summary) => {
        const runs = await platform.fetchRuns(summary.id, orgId);
        if (getCloudConnectionIdentity() !== identity) return;
        store.upsertRuns(runs.map((run) => platform.runSummaryToRow(run, store.getRun(run.id))));
      })
    );
    if (getCloudConnectionIdentity() !== identity) return;
    lastFullRefreshAt.set(orgId, Date.now());
    invalidate(changed.length > 0 ? [...AUTOMATION_RESOURCES] : ["automations"]);
  })();
  refreshInFlight.set(orgId, refresh);
  try {
    await refresh;
  } finally {
    if (refreshInFlight.get(orgId) === refresh) refreshInFlight.delete(orgId);
  }
}

/** Boot / credentials-arrived hook: best-effort background mirror, per organization. */
export function initAutomations(): void {
  if (!platform.platformConfigured()) {
    // Sign-out (or boot before credentials arrive): the cache must not keep
    // serving the previous identity's prompts and run history — list/view
    // stay live app-wide and the agent tool reads the same cache. Runs
    // cascade with their automations.
    cacheIdentity = null;
    refreshInFlight.clear();
    lastFullRefreshAt.clear();
    store.replaceAutomationsCache([]);
    invalidate([...AUTOMATION_RESOURCES]);
    return;
  }
  void refreshEveryOrganization();
}

/**
 * A full refresh of every organization this backend holds a key for (with only a
 * developer key, the default one). Each is its own refresh: one that fails keeps
 * its rows, is logged and stops nothing else. Settles when all have.
 */
export async function refreshEveryOrganization(): Promise<void> {
  const keyed = cloudOrgKeyIds();
  await Promise.all(
    (keyed.length > 0 ? keyed : [null]).map((orgId) =>
      refreshAutomations(undefined, orgId).catch((err) => {
        console.warn(`[Automations] platform sync failed${orgId ? ` for ${orgId}` : ""}:`, err);
      })
    )
  );
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
  thinking_level?: string | null;
  /** A new automation's organization; the default one when omitted. Never changed by an update. */
  organization_id?: string | null;
}

interface ValidatedInput {
  repository_id: string;
  name: string;
  prompt: string;
  cron: string;
  timezone: string | null;
  session_policy: "fresh_session" | "same_session";
  model: string;
  thinking_level: CloudThinkingLevel;
}

const NAME_MAX = 120;
const PROMPT_MAX = 32_768;

// AGNT runs no automation that leaves out its model or thinking level, and deus chooses
// neither for the user: whoever creates or edits the automation names both. Runs only
// ever execute in Deus Cloud, so the level is read in the platform's vocabulary.
function requireModel(value: string | null | undefined): string {
  const model = value?.trim();
  if (!model) throw new ValidationError("Choose the Claude model its runs use.");
  return model;
}

function requireThinkingLevel(value: string | null | undefined): CloudThinkingLevel {
  const level = readCloudThinkingLevel(value);
  if (!level) throw new ValidationError("Choose the thinking level its runs use.");
  return level;
}

/**
 * Refuse a model or level Deus Cloud would not run as named: an unattended run
 * should fail here, where someone is looking, not at 3 a.m. in the run ledger.
 * Checked against the platform's list (listModels(), cached briefly); a list
 * that cannot be read leaves the platform to judge, as it does anyway.
 */
async function assertCloudRunsChoice(
  model: string,
  thinkingLevel: CloudThinkingLevel,
  requireListed: boolean
): Promise<void> {
  const lists = await getCloudModelLists().catch((err: unknown) => {
    console.warn("[Automations] model list unavailable, leaving the check to the platform:", err);
    return null;
  });
  if (!lists) return;
  const problem = cloudModelChoiceProblem(lists, {
    harness: AUTOMATION_HARNESS,
    model,
    thinkingLevel,
    requireListed,
  });
  if (problem) throw new ValidationError(problem);
}

function validateInput(input: AutomationInput): ValidatedInput {
  const name = input.name?.trim();
  if (!name) throw new ValidationError("Automation needs a name.");
  if (name.length > NAME_MAX)
    throw new ValidationError(`Name is too long (max ${NAME_MAX} characters).`);
  const prompt = input.prompt?.trim();
  if (!prompt) throw new ValidationError("Automation needs a prompt.");
  if (prompt.length > PROMPT_MAX) throw new ValidationError("Prompt is too long.");
  const timezone = input.timezone?.trim() || null;
  validateSchedule(input.cron, timezone);
  return {
    repository_id: input.repository_id,
    name,
    prompt,
    cron: input.cron.trim(),
    timezone,
    session_policy: AutomationSessionPolicySchema.parse(input.session_policy ?? "fresh_session"),
    model: requireModel(input.model),
    thinking_level: requireThinkingLevel(input.thinking_level),
  };
}

export async function createAutomation(
  input: AutomationInput,
  createdBy: "user" | "agent"
): Promise<Automation> {
  const orgId = input.organization_id ?? defaultCloudOrgId();
  platform.requireAutomationPlatform(orgId);
  const identity = getCloudConnectionIdentity();
  const valid = validateInput(input);
  await assertCloudRunsChoice(valid.model, valid.thinking_level, true);
  // Automations currently run Claude. A different provider or an unselected
  // account cannot make that scheduled turn runnable.
  const accounts = await getProviderAccounts();
  if (defaultProviderAccount(accounts, "claude")?.status !== "connected") {
    throw new ConflictError(
      "Choose a connected Claude account under Settings → AI Providers before creating an automation."
    );
  }
  const environment = await ensureRepoEnvironment(valid.repository_id, identity, orgId);
  assertCurrentAccount(identity);
  const id = await platform.createPlatformAutomation(
    {
      displayName: valid.name,
      prompt: valid.prompt,
      cron: valid.cron,
      timezone: valid.timezone,
      environment,
      model: valid.model,
      thinkingLevel: valid.thinking_level,
      sessionPolicy: valid.session_policy,
    },
    orgId
  );
  assertCurrentAccount(identity);
  // Seed the row directly with its provenance — writing a "user"-labelled row
  // first and patching created_by after would broadcast the intermediate
  // state to every subscriber. A fresh automation has no runs to pull.
  try {
    const [summary, envMap] = await Promise.all([
      platform.fetchAutomation(id, orgId),
      repoIdByEnvName(),
    ]);
    assertCurrentAccount(identity);
    store.upsertAutomation(
      platform.summaryToRow(summary, envMap, { created_by: createdBy, workspace_id: null }, orgId)
    );
  } catch (err) {
    assertCurrentAccount(identity);
    // The platform ACCEPTED the create — a transient follow-up read must not
    // report failure (the caller would retry and duplicate). Seed the cache
    // from the validated input; the next refresh reconciles the details.
    console.warn(`[Automations] post-create reconcile failed for ${id}, seeding from input:`, err);
    store.upsertAutomation({
      id,
      name: valid.name,
      prompt: valid.prompt,
      cron: valid.cron,
      timezone: valid.timezone,
      environment,
      repository_id: valid.repository_id,
      status: "active",
      paused_reason: null,
      session_policy: valid.session_policy,
      model: valid.model,
      thinking_level: valid.thinking_level,
      next_run_at: null,
      last_run_at: null,
      consecutive_failures: 0,
      created_by: createdBy,
      workspace_id: null,
      organization_id: orgId,
      updated_at: new Date().toISOString(),
    });
  }
  markScopedWrite(orgId);
  invalidate([...AUTOMATION_RESOURCES]);
  const created = getAutomation(id);
  if (!created) throw new Error("Automation not found after creation");
  return created;
}

export async function updateAutomation(
  id: string,
  input: Partial<AutomationInput>
): Promise<Automation> {
  const identity = getCloudConnectionIdentity();
  const existing = store.getAutomationRaw(id);
  if (!existing) throw new NotFoundError("Automation not found.");
  const orgId = existing.organization_id ?? defaultCloudOrgId();

  // The platform spec is ONE document (full replacement, not a merge target),
  // and the cache doesn't carry every field (mcpServers, delivery, overlap) —
  // so patch on top of the platform's CURRENT spec, never a rebuilt one.
  const summary = await platform.fetchAutomation(id, orgId);
  assertCurrentAccount(identity);
  const spec = { ...summary.spec };

  const name = input.name?.trim() || (summary.description?.trim() ?? summary.name);
  if (input.prompt !== undefined) {
    const prompt = input.prompt.trim();
    if (!prompt) throw new ValidationError("Automation needs a prompt.");
    spec.prompt = prompt;
  }
  if (input.cron !== undefined || input.timezone !== undefined) {
    const cron = input.cron?.trim() || existing.cron;
    if (!cron) throw new ValidationError("Automation needs a schedule.");
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
  const model = input.model !== undefined ? requireModel(input.model) : spec.model;
  const thinkingLevel =
    input.thinking_level !== undefined
      ? requireThinkingLevel(input.thinking_level)
      : spec.thinkingLevel;
  // One saved before AGNT required them must have both chosen before it saves again.
  if (!model || !thinkingLevel) {
    throw new ValidationError("Choose the model and thinking level its runs use.");
  }
  // Only a choice made now is checked: an untouched spec stays as the platform holds it.
  if (input.model !== undefined || input.thinking_level !== undefined) {
    await assertCloudRunsChoice(model, thinkingLevel, input.model !== undefined);
  }
  const retargeted =
    input.repository_id !== undefined && input.repository_id !== existing.repository_id;
  if (retargeted) {
    spec.environment = await ensureRepoEnvironment(input.repository_id as string, identity, orgId);
  }

  assertCurrentAccount(identity);
  await platform.updatePlatformAutomation(
    id,
    { description: name, spec: { ...spec, model, thinkingLevel } },
    orgId
  );
  assertCurrentAccount(identity);
  // Only AFTER the platform accepted the retarget: the held sandbox belongs
  // to the old repo, but a failed update must not strip the provenance link.
  if (retargeted) store.updateLocalColumns(id, { workspace_id: null });
  await refreshAutomations(id);
  assertCurrentAccount(identity);
  const updated = getAutomation(id);
  if (!updated) throw new Error("Automation not found after update");
  return updated;
}

/** Pause/resume — the platform owns the forgive-on-resume fence semantics. */
export async function toggleAutomation(
  id: string,
  status: "active" | "paused"
): Promise<Automation> {
  const identity = getCloudConnectionIdentity();
  if (!store.getAutomationRaw(id)) throw new NotFoundError("Automation not found.");
  const orgId = orgOfAutomation(id);
  if (status === "paused") await platform.pausePlatformAutomation(id, orgId);
  else await platform.resumePlatformAutomation(id, orgId);
  assertCurrentAccount(identity);
  await refreshAutomations(id);
  assertCurrentAccount(identity);
  const updated = getAutomation(id);
  if (!updated) throw new Error("Automation not found after toggle");
  return updated;
}

export async function deleteAutomation(id: string): Promise<void> {
  const identity = getCloudConnectionIdentity();
  if (!store.getAutomationRaw(id)) throw new NotFoundError("Automation not found.");
  const orgId = orgOfAutomation(id);
  await platform.deletePlatformAutomation(id, orgId);
  assertCurrentAccount(identity);
  store.deleteAutomationRow(id);
  markScopedWrite(orgId);
  invalidate([...AUTOMATION_RESOURCES]);
}

/** Manual "Run now" — a platform fire; works on paused automations by design. */
export async function runAutomationNow(id: string): Promise<string> {
  const identity = getCloudConnectionIdentity();
  const automation = store.getAutomationRaw(id);
  if (!automation) throw new NotFoundError("Automation not found.");
  const { runId, status } = await platform.triggerPlatformAutomation(
    id,
    uuidv7(),
    automation.organization_id ?? defaultCloudOrgId()
  );
  assertCurrentAccount(identity);
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
 * backfill the transcript, and attach the live session channel.
 */
export async function openAutomationRun(
  runId: string
): Promise<{ workspaceId: string; sessionId: string }> {
  const identity = getCloudConnectionIdentity();
  const run = store.getRun(runId);
  if (!run) throw new NotFoundError("Run not found.");
  const automation = store.getAutomationRaw(run.automation_id);
  if (!automation) throw new NotFoundError("Automation not found.");
  // The run's sandbox is in the automation's organization.
  const orgId = automation.organization_id ?? defaultCloudOrgId();

  // Already adopted — reuse the rows, but heal the transcript first: the run
  // may have finished (or continued) while deus was closed, and a PARTIAL
  // transcript is as stale as an empty one — a message-count gate would
  // freeze it forever. The insert path is idempotent, so backfill always.
  if (run.session_id && run.workspace_id && store.sessionExists(run.session_id)) {
    if (run.provider_session_id) {
      await backfillTranscript(run.session_id, run.provider_session_id, identity, orgId);
    }
    assertCurrentAccount(identity);
    // The user may have archived the adopted workspace since — an archived
    // row is invisible to the workspace queries, so opening the run would
    // select an id the frontend cannot resolve. Resurface it, like the
    // adoption path does.
    reviveAdoptedWorkspace(run.workspace_id, run.session_id);
    return { workspaceId: run.workspace_id, sessionId: run.session_id };
  }

  if (!run.provider_session_id) {
    throw new ConflictError("This run has no session to open (it was skipped or never started).");
  }
  if (!automation.repository_id) {
    throw new NotFoundError("This automation's repository isn't on this Mac.");
  }

  const detail = await platform.fetchSessionDetail(run.provider_session_id, orgId);
  assertCurrentAccount(identity);
  if (!detail.workspaceId) throw new NotFoundError("The run's sandbox is gone.");

  const { workspaceId, sessionId } = adoptRunRows({
    runId,
    automationId: automation.id,
    repositoryId: automation.repository_id,
    automationName: automation.name,
    providerSessionId: run.provider_session_id,
    providerWorkspaceId: detail.workspaceId,
    organizationId: orgId,
    newWorkspaceSlug: () => generateUniqueName(getDatabase()),
  });

  // Backfill the transcript from the platform's stored messages — the run
  // executed server-side, so the live channel never folded its events here.
  const inserted = store.backfillSessionTranscript(sessionId, detail.messages);
  if (inserted > 0) {
    console.log(
      `[Automations] backfilled ${inserted} message(s) for adopted run ${runId} → session ${sessionId}`
    );
    // Rows no event of the chat announced: whoever has its transcript open reads it again.
    resetSubscribers(sessionEvents, { sessionId });
  }
  invalidate(["workspaces", "sessions", "session", ...AUTOMATION_RESOURCES], {
    sessionIds: [sessionId],
  });

  // Attach the live session channel (call-time import: the driver sits in the
  // agent service graph, which imports this module through the tool dispatch).
  void import("../agent/cloud/driver")
    .then(({ ensureCloudSession }) => {
      assertCurrentAccount(identity);
      return ensureCloudSession(sessionId);
    })
    .catch((err) => {
      console.warn(`[Automations] session channel attach failed for run ${runId}:`, err);
    });

  return { workspaceId, sessionId };
}

/** Heal an adopted-but-empty transcript from the platform's stored messages. */
async function backfillTranscript(
  deusSessionId: string,
  providerSessionId: string,
  identity: string,
  orgId: string | null
): Promise<void> {
  try {
    const detail = await platform.fetchSessionDetail(providerSessionId, orgId);
    if (getCloudConnectionIdentity() !== identity) return;
    const inserted = store.backfillSessionTranscript(deusSessionId, detail.messages);
    if (inserted > 0) {
      invalidate(["sessions", "session"], { sessionIds: [deusSessionId] });
      // Rows no event of the chat announced: whoever has its transcript open reads it again.
      resetSubscribers(sessionEvents, { sessionId: deusSessionId });
    }
  } catch (err) {
    console.warn(`[Automations] transcript backfill failed for ${deusSessionId}:`, err);
  }
}
