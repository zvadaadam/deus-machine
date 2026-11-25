/**
 * Row transitions run synchronously and publish their writes.
 * A transition that leaves publication to its caller names the sequence that caller finishes.
 * Only changeWorkspaceState, runWorkspaceAttempt and repoRemoval run caller-supplied code.
 */
import { isDeepStrictEqual } from "node:util";
import type { RepoRemovalConfirmation } from "@shared/api/repos";
import { sessionEvents } from "@shared/api/sessions";
import { ACTIVE_TURN_STATUSES, type InitFetchIssue, type SetupStatus } from "@shared/enums";
import { CLOUD_PROJECT_REMOVAL_REASON } from "@shared/types/repository";
import { uuidv7 } from "@shared/lib/uuid";
import { getWorkspaceRaw, START_RECOVERABLE, type WorkspaceRow } from "../db";
import { getDatabase } from "../lib/database";
import { ConflictError, NotFoundError } from "../lib/errors";
import { invalidate } from "./query-engine";
import { writeSetupStatusFile } from "./setup-status";
import { resetSubscribers } from "./streams";

export type Stage = "fetch" | "worktree" | "session";

interface StartBranches {
  id: string;
  repository_id: string;
  slug: string;
  git_branch: string;
  git_target_branch: string;
}

type LocalStart = StartBranches &
  Pick<WorkspaceRow, "title" | "pr_url" | "pr_number"> & {
    git_source_branch: string;
    first_session_id: string;
    started_by: string | null;
  };

/** createLocalWorkspace publishes after starting the checkout. */
export function insertLocalWorkspace(row: LocalStart): void {
  const db = getDatabase();
  db.prepare(
    `INSERT INTO workspaces (
       id, repository_id, slug, title, git_branch, git_source_branch,
       git_target_branch, pr_url, pr_number, state, first_session_id, started_by, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'initializing', ?, ?, datetime('now'))`
  ).run(
    row.id,
    row.repository_id,
    row.slug,
    row.title,
    row.git_branch,
    row.git_source_branch,
    row.git_target_branch,
    row.pr_url,
    row.pr_number,
    row.first_session_id,
    row.started_by
  );
}

const attempts = new Map<string, { controller: AbortController; done: Promise<void> }>();

export async function runWorkspaceAttempt(
  workspaceId: string,
  start: (signal: AbortSignal) => Promise<void>
): Promise<void> {
  const existing = attempts.get(workspaceId);
  if (existing) return existing.done;
  const controller = new AbortController();
  const done = Promise.withResolvers<void>();
  attempts.set(workspaceId, { controller, done: done.promise });
  try {
    await start(controller.signal);
  } finally {
    if (attempts.get(workspaceId)?.controller === controller) attempts.delete(workspaceId);
    done.resolve();
  }
}

export function workspaceAttemptDone(id: string) {
  return attempts.get(id)?.done;
}

export function retireWorkspaceAttempt(id: string) {
  const attempt = attempts.get(id);
  if (!attempt) return;
  attempts.delete(id);
  attempt.controller.abort();
  return attempt.done;
}

function ownsAttempt(id: string, token: AbortSignal): boolean {
  return attempts.get(id)?.controller.signal === token && !token.aborted;
}

export function advanceLocalStage(workspaceId: string, stage: Stage, token: AbortSignal): void {
  if (!ownsAttempt(workspaceId, token)) return;
  try {
    const update = getDatabase()
      .prepare("UPDATE workspaces SET init_stage = ? WHERE id = ? AND state = 'initializing'")
      .run(stage, workspaceId);
    if (!update.changes) return;
  } catch (err) {
    // The stage is progress, not state: a locked database must not stop the work.
    console.warn(`[WORKSPACE] Could not record stage "${stage}" for ${workspaceId}:`, err);
    return;
  }
  invalidate(["workspaces"]);
}

/** The next stage (worktree), or a start failure, publishes the recorded fetch outcome. */
export function recordFetchOutcome(
  workspaceId: string,
  issue: InitFetchIssue | null,
  token: AbortSignal
): void {
  if (!ownsAttempt(workspaceId, token)) return;
  getDatabase()
    .prepare("UPDATE workspaces SET init_fetch_issue = ? WHERE id = ? AND state = 'initializing'")
    .run(issue, workspaceId);
}

/** The checkout publishes after starting setup so the first turn sees its status. */
export function finishLocalStart(workspaceId: string, token: AbortSignal): boolean {
  if (!ownsAttempt(workspaceId, token)) return false;
  const db = getDatabase();
  return db.transaction(() => {
    const row = db
      .prepare(
        "SELECT first_session_id, started_by FROM workspaces WHERE id = ? AND state = 'initializing'"
      )
      .get(workspaceId) as
      | { first_session_id: string | null; started_by: string | null }
      | undefined;
    if (!row) return false;
    const sessionId = row.first_session_id ?? uuidv7();
    db.prepare(
      "INSERT INTO sessions (id, workspace_id, status, started_by, updated_at) VALUES (?, ?, 'idle', ?, datetime('now'))"
    ).run(sessionId, workspaceId, row.started_by);
    db.prepare(
      "UPDATE workspaces SET state = 'ready', init_stage = 'done', current_session_id = ?, first_session_id = ? WHERE id = ?"
    ).run(sessionId, sessionId, workspaceId);
    return true;
  })();
}

type StartFailure = { message: string; detail: string | null };
export function failStart(
  workspaceId: string,
  stage: string,
  failure: StartFailure,
  token: AbortSignal
): boolean {
  return ownsAttempt(workspaceId, token) && writeStartFailure(workspaceId, stage, failure);
}

/** A previous process has no live token. Recovery never takes a start still owned by this one. */
export function failInterruptedStart(
  workspaceId: string,
  stage: string,
  failure: StartFailure
): boolean {
  return !attempts.has(workspaceId) && writeStartFailure(workspaceId, stage, failure);
}

function writeStartFailure(workspaceId: string, stage: string, failure: StartFailure): boolean {
  const update = getDatabase()
    .prepare(
      `UPDATE workspaces
       SET state = 'error', init_stage = ?, error_message = ?, error_detail = ?
       WHERE id = ? AND state = 'initializing'`
    )
    .run(stage, failure.message, failure.detail, workspaceId);
  if (!update.changes) return false;
  invalidate(["workspaces"]);
  return true;
}

interface StartRow {
  id: string;
  kind: string;
  state: string;
  slug: string | null;
  git_branch: string | null;
  git_source_branch: string | null;
  git_target_branch: string | null;
  init_stage: string | null;
  setup_status: string;
  provider_workspace_id: string | null;
  current_session_id: string | null;
  root_path: string | null;
  git_default_branch: string | null;
  git_origin_url: string | null;
}

const START_ROW = `
  SELECT w.id, w.kind, w.state, w.slug, w.git_branch, w.git_source_branch, w.git_target_branch,
         w.init_stage, w.setup_status, w.provider_workspace_id, w.current_session_id,
         r.root_path, r.git_default_branch, r.git_origin_url
  FROM workspaces w LEFT JOIN repositories r ON r.id = w.repository_id`;

function hasLocalStartInputs(
  row: StartRow | undefined
): row is StartRow & { root_path: string; slug: string; git_branch: string } {
  return !!(row?.root_path && row.slug && row.git_branch);
}

const NOT_WAITING_FOR_RETRY = "This workspace is not waiting for a retry.";

export function claimLocalRetry(workspaceId: string) {
  if (attempts.has(workspaceId)) throw new ConflictError(NOT_WAITING_FOR_RETRY);
  const db = getDatabase();
  const row = db.prepare(`${START_ROW} WHERE w.id = ?`).get(workspaceId) as StartRow | undefined;
  if (!hasLocalStartInputs(row)) throw new NotFoundError("Workspace not found");
  const claimed = db
    .prepare(
      `UPDATE workspaces
       SET state = 'initializing', init_stage = NULL,
           error_message = NULL, error_detail = NULL, init_fetch_issue = NULL
       WHERE id = ? AND kind = 'worktree' AND ${START_RECOVERABLE("workspaces")}`
    )
    .run(workspaceId);
  if (claimed.changes === 0) throw new ConflictError(NOT_WAITING_FOR_RETRY);
  if (row.setup_status !== "none") setSetupStatus(workspaceId, "none");
  invalidate(["workspaces"]);
  return row;
}

/**
 * Delete a workspace that never started. One that has been used is archived
 * instead: deleting it would take its chats with it. A cloud workspace whose
 * computer exists is the platform's to remove, so it is archived too.
 */
export function deleteFailedWorkspace(workspaceId: string): void {
  const db = getDatabase();
  const row = db.prepare(`${START_ROW} WHERE w.id = ?`).get(workspaceId) as StartRow | undefined;
  if (!row) throw new NotFoundError("Workspace not found");
  if (row.state !== "error")
    throw new ConflictError("Only a workspace that failed to start can be deleted.");
  if (row.provider_workspace_id)
    throw new ConflictError("This workspace has a cloud computer. Archive it instead.");
  const deleted = db
    .prepare(`DELETE FROM workspaces WHERE id = ? AND ${START_RECOVERABLE("workspaces")}`)
    .run(workspaceId);
  if (!deleted.changes) throw new ConflictError("This workspace has chats. Archive it instead.");
  cloudReports.delete(workspaceId);
  invalidate(["workspaces", "sessions"]);
}

type HoldingTurn = (sessionId: string) => { turnId: string } | undefined;

export function repoRemoval(repoId: string, holdingTurn: HoldingTurn) {
  const db = getDatabase();
  const row = db
    .prepare<
      [string],
      {
        rootPath: string | null;
        archivedWorkspaces: number;
        remaining: number;
        cloud: number;
        automations: number;
      }
    >(
      `SELECT r.root_path AS rootPath,
              COUNT(w.id) FILTER (WHERE w.state = 'archived') AS archivedWorkspaces,
              COUNT(w.id) FILTER (WHERE w.state != 'archived') AS remaining,
              COUNT(w.id) FILTER (WHERE w.kind = 'cloud') AS cloud,
              (SELECT COUNT(*) FROM automations WHERE repository_id = r.id) AS automations
         FROM repositories r LEFT JOIN workspaces w ON w.repository_id = r.id
        WHERE r.id = ? GROUP BY r.id`
    )
    .get(repoId);
  if (!row) throw new NotFoundError("Project not found.");
  const { rootPath, archivedWorkspaces, remaining, cloud, automations } = row;
  if (cloud) throw new ConflictError(CLOUD_PROJECT_REMOVAL_REASON);
  if (remaining) {
    throw new ConflictError(
      remaining === 1
        ? "Archive the remaining workspace first."
        : `Archive the remaining ${remaining} workspaces first.`
    );
  }
  const chats = db
    .prepare<[string], { id: string; status: string }>(
      `SELECT s.id, s.status FROM sessions s JOIN workspaces w ON w.id = s.workspace_id
        WHERE w.repository_id = ?`
    )
    .all(repoId);
  if (chats.some(({ id, status }) => ACTIVE_TURN_STATUSES.includes(status) || holdingTurn(id))) {
    throw new ConflictError(
      "A chat in an archived workspace is still working. Restore the workspace and stop it, or wait for it to finish."
    );
  }
  return {
    confirmation: { rootPath, counts: { archivedWorkspaces, chats: chats.length, automations } },
    chats,
  };
}

function unlinkAndDeleteProject(repoId: string): void {
  const db = getDatabase();
  // Platform runs keep their history. Their local adoption points at rows the cascade removes.
  db.prepare(
    `WITH removed_workspaces AS (SELECT id FROM workspaces WHERE repository_id = ?)
     UPDATE automation_runs SET workspace_id = NULL, session_id = NULL
      WHERE workspace_id IN removed_workspaces
         OR session_id IN (SELECT id FROM sessions WHERE workspace_id IN removed_workspaces)`
  ).run(repoId);
  db.prepare("UPDATE automations SET repository_id = NULL WHERE repository_id = ?").run(repoId);
  db.prepare("DELETE FROM repositories WHERE id = ?").run(repoId);
}

export function removeRepo(
  repoId: string,
  confirmed: RepoRemovalConfirmation,
  holdingTurn: HoldingTurn
): void {
  const removedChats = getDatabase()
    .transaction(() => {
      const { confirmation, chats } = repoRemoval(repoId, holdingTurn);
      if (!isDeepStrictEqual(confirmed, confirmation)) {
        throw new ConflictError(
          "This project changed. Review what will be removed and confirm again."
        );
      }
      unlinkAndDeleteProject(repoId);
      return chats;
    })
    .immediate();
  for (const { id } of removedChats) resetSubscribers(sessionEvents, { sessionId: id });
  invalidate([...WORKSPACE_RESOURCES, "repos", "automations", "automationRuns"]);
}

export function deleteEmptyUnnamedProjects(): void {
  const db = getDatabase();
  const removed = db
    .transaction(() => {
      const projects = db
        .prepare<[], { id: string }>(
          `SELECT id FROM repositories WHERE name = ''
            AND NOT EXISTS (SELECT 1 FROM workspaces WHERE repository_id = repositories.id)`
        )
        .all();
      for (const { id } of projects) unlinkAndDeleteProject(id);
      return projects.length;
    })
    .immediate();
  if (removed) invalidate(["workspaces", "repos", "automations"]);
}

export function runningSetups() {
  return getDatabase()
    .prepare("SELECT id FROM workspaces WHERE setup_status = 'running'")
    .all() as { id: string }[];
}

export function interruptedStarts() {
  const rows = getDatabase()
    .prepare(`${START_ROW} WHERE w.state = 'initializing'`)
    .all() as StartRow[];
  // The platform continues provisioning a cloud workspace which already has a chat.
  return rows.filter(
    (row) => !attempts.has(row.id) && (row.kind !== "cloud" || !row.current_session_id)
  );
}

/** The row is the app's status; the file lets a turn already running check it with cat. */
export function setSetupStatus(
  workspaceId: string,
  status: SetupStatus,
  failure?: { message: string; detail?: string | null; exitCode?: number | null }
): void {
  const update = getDatabase()
    .prepare(
      "UPDATE workspaces SET setup_status = ?, error_message = ?, error_detail = ? WHERE id = ?"
    )
    .run(status, failure?.message ?? null, failure?.detail ?? null, workspaceId);
  if (!update.changes) return;
  try {
    writeSetupStatusFile(workspaceId, status, failure?.exitCode);
  } finally {
    invalidate(["workspaces"]);
  }
}

const WORKSPACE_RESOURCES = ["workspaces", "sessions", "session"] as const;

export function insertCloudWorkspace(
  row: StartBranches & { organization_id: string | null }
): void {
  const db = getDatabase();
  db.prepare(
    `INSERT INTO workspaces (
       id, repository_id, slug, kind, git_branch, git_target_branch,
       organization_id, state, init_stage, updated_at
     ) VALUES (?, ?, ?, 'cloud', ?, ?, ?, 'initializing', 'creating cloud workspace', datetime('now'))`
  ).run(
    row.id,
    row.repository_id,
    row.slug,
    row.git_branch,
    row.git_target_branch,
    row.organization_id
  );
  invalidate([...WORKSPACE_RESOURCES], {});
}

export function claimCloudRetry(workspaceId: string): void {
  if (attempts.has(workspaceId)) throw new ConflictError(NOT_WAITING_FOR_RETRY);
  const claimed = getDatabase()
    .prepare(
      `UPDATE workspaces
       SET state = 'initializing', init_stage = 'creating cloud workspace',
           error_message = NULL, error_detail = NULL
       WHERE id = ? AND ${START_RECOVERABLE("workspaces")}`
    )
    .run(workspaceId);
  if (claimed.changes === 0) throw new ConflictError(NOT_WAITING_FOR_RETRY);
  invalidate([...WORKSPACE_RESOURCES], {});
}

export function failCloudStart(id: string, failure: StartFailure, token: AbortSignal): void {
  if (!ownsAttempt(id, token)) return;
  const updated = getDatabase()
    .prepare(
      "UPDATE workspaces SET state = 'error', error_message = ?, error_detail = ? WHERE id = ? AND state = 'initializing'"
    )
    .run(failure.message, failure.detail, id);
  if (updated.changes) invalidate([...WORKSPACE_RESOURCES], {});
}

/** Cloud provisioning publishes after recording the token refresh for the computer. */
export function attachCloudComputer(id: string, providerId: string, token: AbortSignal): boolean {
  if (!ownsAttempt(id, token)) return false;
  const attached = getDatabase()
    .prepare(
      "UPDATE workspaces SET provider_workspace_id = ?, init_stage = 'creating cloud session' WHERE id = ? AND state = 'initializing'"
    )
    .run(providerId, id);
  return attached.changes > 0;
}

export function attachCloudChat(
  id: string,
  providerSessionId: string,
  token: AbortSignal
): string | null {
  if (!ownsAttempt(id, token)) return null;
  const sessionId = uuidv7();
  const db = getDatabase();
  const attached = db.transaction(() => {
    const updated = db
      .prepare(
        "UPDATE workspaces SET current_session_id = ?, init_stage = 'provisioning sandbox' WHERE id = ? AND state = 'initializing'"
      )
      .run(sessionId, id);
    if (!updated.changes) return false;
    db.prepare(
      "INSERT INTO sessions (id, workspace_id, provider_session_id, status, updated_at) VALUES (?, ?, ?, 'idle', datetime('now'))"
    ).run(sessionId, id, providerSessionId);
    return true;
  })();
  if (!attached) return null;
  invalidate([...WORKSPACE_RESOURCES], {});
  return sessionId;
}

function cloudWorkspaceChat(id: string) {
  return getDatabase()
    .prepare(
      `SELECT w.state, s.id AS chat FROM workspaces w LEFT JOIN sessions s
    ON s.id = w.current_session_id AND s.workspace_id = w.id WHERE w.id = ?`
    )
    .get(id) as { state: string; chat: string | null } | undefined;
}

export function selectedWorkspaceChat(id: string) {
  return cloudWorkspaceChat(id)?.chat;
}

export function claimCloudChatRepair(id: string, token: AbortSignal): boolean {
  if (!ownsAttempt(id, token)) return false;
  const repairing = getDatabase()
    .prepare(
      "UPDATE workspaces SET state = 'initializing', init_stage = 'creating cloud session', error_message = NULL, error_detail = NULL WHERE id = ? AND state != 'archived'"
    )
    .run(id);
  if (!repairing.changes) return false;
  invalidate([...WORKSPACE_RESOURCES], {});
  return true;
}

type CloudReport = { status?: string; step?: string; errorMessage?: string; reason?: string };
function projectCloudStatus(
  data: CloudReport,
  row: { archived: boolean; hasChat: boolean }
): Pick<WorkspaceRow, "state" | "init_stage" | "error_message" | "error_detail"> | undefined {
  if (row.archived || !row.hasChat) return;
  switch (data.status) {
    case "running":
      return { state: "ready", init_stage: null, error_message: null, error_detail: null };
    case "provisioning":
      return {
        state: "initializing",
        init_stage: typeof data.step === "string" ? data.step : "provisioning",
        error_message: null,
        error_detail: null,
      };
    case "paused":
    case "stopped":
    case "resuming":
      return { state: "ready", init_stage: data.status, error_message: null, error_detail: null };
    case "error": {
      const message = [data.errorMessage, data.reason, data.step].find(
        (s) => typeof s === "string" && s.trim()
      );
      return {
        state: "error",
        init_stage: null,
        error_message: message ?? "The cloud computer reported an error.",
        error_detail: null,
      };
    }
  }
}

type CloudOutcome = { ok: boolean; status: string; error?: string };
const cloudReports = new Map<
  string,
  { count: number; lastWrite?: { number: number; outcome: CloudOutcome } }
>();

export function watchCloudReports(id: string) {
  const since = cloudReports.get(id)?.count ?? 0;
  return (): { outcome?: CloudOutcome } | undefined => {
    const latest = cloudReports.get(id);
    if (!latest || latest.count <= since) return;
    return latest.lastWrite && latest.lastWrite.number > since
      ? { outcome: latest.lastWrite.outcome }
      : {};
  };
}

/** The driver parks a sleeping computer's simulator before publishing. */
export function applyCloudStatus(workspaceId: string, data: CloudReport): void {
  const row = cloudWorkspaceChat(workspaceId);
  if (!row) return;
  const fields = projectCloudStatus(data, {
    archived: row.state === "archived",
    hasChat: !!row.chat,
  });
  const previous = cloudReports.get(workspaceId);
  const count = (previous?.count ?? 0) + 1;
  let lastWrite = previous?.lastWrite;
  if (fields && data.status) {
    getDatabase()
      .prepare(
        "UPDATE workspaces SET state = ?, init_stage = ?, error_message = ?, error_detail = ? WHERE id = ?"
      )
      .run(fields.state, fields.init_stage, fields.error_message, fields.error_detail, workspaceId);
    lastWrite = {
      number: count,
      outcome: {
        ok: ["running", "provisioning", "resuming"].includes(data.status),
        status: data.status,
        error: fields.error_message ?? undefined,
      },
    };
  }
  cloudReports.set(workspaceId, { count, lastWrite });
}

export function setCloudWakeStage(workspaceId: string, stage: string | null): void {
  getDatabase()
    .prepare("UPDATE workspaces SET init_stage = ? WHERE id = ?")
    .run(stage, workspaceId);
  invalidate(["workspaces"], {});
}

export function rollbackSendWake(workspaceId: string, asleepStage: "paused" | "stopped"): boolean {
  const update = getDatabase()
    .prepare("UPDATE workspaces SET init_stage = ? WHERE id = ? AND init_stage = 'resuming'")
    .run(asleepStage, workspaceId);
  if (!update.changes) return false;
  invalidate(["workspaces"], {});
  return true;
}

// State changes for each workspace run in the order they are requested.
const changes = new Map<string, Promise<unknown>>();

export function changeWorkspaceState<T>(workspaceId: string, change: () => Promise<T>): Promise<T> {
  const previous = changes.get(workspaceId) ?? Promise.resolve();
  const next = previous.catch(() => {}).then(change);
  changes.set(workspaceId, next);
  void next
    .finally(() => {
      if (changes.get(workspaceId) === next) changes.delete(workspaceId);
    })
    .catch(() => {});
  return next;
}

export const CLOUD_STILL_STARTING =
  "This cloud workspace is still starting. Archive it once it is ready.";

/** archiveWorkspace publishes after the confirmed pause, archive, local effects and checkout cleanup. */
export function markArchived(
  workspace: Pick<WorkspaceRow, "id" | "kind" | "provider_workspace_id">,
  archivedBy: string | null
) {
  const { id, kind, provider_workspace_id } = workspace;
  if (kind === "cloud" && attempts.has(id) && !provider_workspace_id)
    throw new ConflictError(CLOUD_STILL_STARTING);
  const write = getDatabase()
    .prepare(
      "UPDATE workspaces SET state = 'archived', archived_at = datetime('now'), archived_by = ? WHERE id = ? AND state != 'archived'"
    )
    .run(archivedBy, id);
  return write.changes > 0;
}

/** unarchiveWorkspace publishes after the workflow update. A failed wake publishes through rollbackCloudRestore. */
export function markRestored(workspaceId: string) {
  const db = getDatabase();
  const row = getWorkspaceRaw(db, workspaceId);
  if (!row) throw new NotFoundError("Workspace not found");
  if (row.state !== "archived") return;
  if (row.kind === "cloud" && row.provider_workspace_id) {
    // Open the row before waking so the driver can apply an early platform report.
    db.prepare("UPDATE workspaces SET state = ? WHERE id = ?").run(
      selectedWorkspaceChat(workspaceId) ? "ready" : "initializing",
      workspaceId
    );
  } else {
    db.prepare(
      "UPDATE workspaces SET state = CASE WHEN current_session_id IS NULL THEN 'error' ELSE 'ready' END WHERE id = ?"
    ).run(workspaceId);
  }
  return row;
}

export function rollbackCloudRestore(workspaceId: string): void {
  getDatabase().prepare("UPDATE workspaces SET state = 'archived' WHERE id = ?").run(workspaceId);
  invalidate(["workspaces"], {});
}

/** Resurface an archived adopted workspace and repoint its current session.
 *  Both membership and selection belong to the workspace list. */
export function reviveAdoptedWorkspace(workspaceId: string, sessionId: string): void {
  const revived = markAdoptedWorkspaceReady(workspaceId);
  const selected = getDatabase()
    .prepare(
      "UPDATE workspaces SET current_session_id = ?, updated_at = datetime('now') WHERE id = ? AND current_session_id IS NOT ?"
    )
    .run(sessionId, workspaceId, sessionId);
  if (revived || selected.changes) invalidate(["workspaces"]);
}

/** reviveAdoptedWorkspace publishes after selecting the chat. */
function markAdoptedWorkspaceReady(workspaceId: string): boolean {
  return (
    getDatabase()
      .prepare(
        "UPDATE workspaces SET state = 'ready', updated_at = datetime('now') WHERE id = ? AND state = 'archived'"
      )
      .run(workspaceId).changes > 0
  );
}

/** openAutomationRun publishes after the adoption transaction commits and the transcript is backfilled. */
export function insertAdoptedWorkspace(
  row: Pick<
    WorkspaceRow,
    "id" | "repository_id" | "slug" | "title" | "provider_workspace_id" | "organization_id"
  >
): void {
  const db = getDatabase();
  db.prepare(
    `INSERT INTO workspaces (id, repository_id, slug, title, state, kind, provider_workspace_id, organization_id)
     VALUES (?, ?, ?, ?, 'ready', 'cloud', ?, ?)`
  ).run(
    row.id,
    row.repository_id,
    row.slug,
    row.title,
    row.provider_workspace_id,
    row.organization_id
  );
}

/** openAutomationRun publishes the chat pointer with the rest of the adoption after transcript backfill. */
export function attachAdoptedSession(
  workspaceId: string,
  sessionId: string,
  organizationId: string | null
): void {
  getDatabase()
    .prepare(
      "UPDATE workspaces SET current_session_id = ?, organization_id = COALESCE(organization_id, ?), updated_at = datetime('now') WHERE id = ?"
    )
    .run(sessionId, organizationId, workspaceId);
}

/** The integration CLI seeds its private database without publishing a live read. */
export function insertWorkspaceFixture(id: string, repositoryId: string): void {
  getDatabase()
    .prepare(
      `INSERT OR IGNORE INTO workspaces (id, repository_id, slug, state) VALUES (?, ?, 'cli-test', 'ready')`
    )
    .run(id, repositoryId);
}
