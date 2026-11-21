/** Workspace row transitions, their live reads and the per-workspace queue. */
import type { InitFetchIssue, SetupStatus } from "@shared/enums";
import { uuidv7 } from "@shared/lib/uuid";
import { getWorkspaceRaw, type WorkspaceRow } from "../db";
import { getDatabase } from "../lib/database";
import { ConflictError, NotFoundError } from "../lib/errors";
import { invalidate } from "./query-engine";
import { writeSetupStatusFile } from "./setup-status";

type Database = ReturnType<typeof getDatabase>;
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

export function insertLocalWorkspace(
  db: Database,
  row: LocalStart,
  beforePublish: () => void
): void {
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
  try {
    beforePublish();
  } finally {
    invalidate(["workspaces"]);
  }
}

type Cleanup = () => Promise<void>;
const attempts = new Map<string, { controller: AbortController; settle: Cleanup }>();

/** A failed checkout hands its cleanup to the queue. Archive can abort and settle
 * the same work from inside that queue without waiting on a task queued behind it. */
export async function runLocalAttempt(
  workspaceId: string,
  checkout: (signal: AbortSignal) => Promise<Cleanup | void>
): Promise<void> {
  if (attempts.has(workspaceId)) return;
  const controller = new AbortController();
  const stopped = Promise.withResolvers<Cleanup | void>();
  let settling: Promise<void> | undefined;
  const settle = () => (settling ??= stopped.promise.then((cleanup) => cleanup?.()));
  attempts.set(workspaceId, { controller, settle });
  try {
    const cleanup = await checkout(controller.signal);
    stopped.resolve(cleanup);
    if (cleanup) {
      if (controller.signal.aborted) await settle();
      else await changeWorkspaceState(workspaceId, settle);
    }
  } finally {
    stopped.resolve(); // Also release an archive if checkout threw before returning its cleanup.
    if (attempts.get(workspaceId)?.controller === controller) attempts.delete(workspaceId);
  }
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

/**
 * The first chat, under the id minted with the workspace, started by whoever
 * started it; only while the workspace is still starting, in the same
 * transaction. Setup is marked running before a ready observer can send.
 */
export function finishLocalStart(
  workspaceId: string,
  beforePublish: () => void,
  token: AbortSignal
): void {
  if (!ownsAttempt(workspaceId, token)) return;
  const db = getDatabase();
  const opened = db.transaction(() => {
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
  if (!opened) return;
  attempts.delete(workspaceId); // The checkout now belongs to the chat.
  try {
    beforePublish();
  } finally {
    invalidate(["workspaces", "sessions"]);
  }
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
): void {
  if (!attempts.has(workspaceId)) writeStartFailure(workspaceId, stage, failure);
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
  attempts.delete(workspaceId);
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

const FAILED_TO_START = `state = 'error' AND current_session_id IS NULL AND provider_workspace_id IS NULL
  AND NOT EXISTS (SELECT 1 FROM sessions WHERE workspace_id = workspaces.id)`;

export function claimLocalRetry(workspaceId: string) {
  const db = getDatabase();
  const row = db.prepare(`${START_ROW} WHERE w.id = ?`).get(workspaceId) as StartRow | undefined;
  if (!hasLocalStartInputs(row)) throw new NotFoundError("Workspace not found");
  // The claim: two clicks, or two devices, start it once.
  const claimed = db
    .prepare(
      `UPDATE workspaces
       SET state = 'initializing', init_stage = NULL,
           error_message = NULL, error_detail = NULL, init_fetch_issue = NULL
       WHERE id = ? AND kind = 'worktree' AND ${FAILED_TO_START}`
    )
    .run(workspaceId);
  if (claimed.changes === 0) throw new ConflictError("This workspace is not waiting for a retry.");
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
    .prepare(`DELETE FROM workspaces WHERE id = ? AND ${FAILED_TO_START}`)
    .run(workspaceId);
  if (!deleted.changes) throw new ConflictError("This workspace has chats. Archive it instead.");
  invalidate(["workspaces", "sessions"]);
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

type SetupFailure = { message: string; detail?: string | null; exitCode?: number | null };

export function finishSetupRun(
  workspaceId: string,
  status: "completed" | "failed" | "none",
  current: () => boolean,
  failure?: SetupFailure
): void {
  if (current()) setSetupStatus(workspaceId, status, failure);
}

/** The row is the app's status; the file lets a turn already running check it with cat. */
export function setSetupStatus(
  workspaceId: string,
  status: SetupStatus,
  failure?: SetupFailure
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
  db: Database,
  row: StartBranches & { organization_id: string | null }
): void {
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

export function claimCloudRetry(db: Database, workspaceId: string): void {
  // The claim: two clicks, or two devices, provision it once.
  const claimed = db
    .prepare(
      `UPDATE workspaces
       SET state = 'initializing', init_stage = 'creating cloud workspace',
           error_message = NULL, error_detail = NULL
       WHERE id = ? AND ${FAILED_TO_START}`
    )
    .run(workspaceId);
  if (claimed.changes === 0) throw new ConflictError("This workspace is not waiting for a retry.");
  invalidate([...WORKSPACE_RESOURCES], {});
}

export function failCloudStart(db: Database, workspaceId: string, message: string): void {
  // Keep the failed stage as diagnostic context alongside the specific error.
  db.prepare("UPDATE workspaces SET state = 'error', error_message = ? WHERE id = ?").run(
    message,
    workspaceId
  );
  invalidate([...WORKSPACE_RESOURCES], {});
}

export function attachCloudComputer(
  db: Database,
  workspaceId: string,
  providerId: string,
  mintedAt: number | null,
  beforePublish: () => void
): void {
  db.prepare(
    "UPDATE workspaces SET provider_workspace_id = ?, init_stage = 'creating cloud session', last_inline_mint_at = ? WHERE id = ?"
  ).run(providerId, mintedAt, workspaceId);
  try {
    beforePublish();
  } finally {
    invalidate([...WORKSPACE_RESOURCES], {});
  }
}

export function attachCloudChat(
  db: Database,
  workspaceId: string,
  providerSessionId: string
): string {
  const sessionId = uuidv7();
  db.transaction(() => {
    db.prepare(
      "INSERT INTO sessions (id, workspace_id, provider_session_id, status, updated_at) VALUES (?, ?, ?, 'idle', datetime('now'))"
    ).run(sessionId, workspaceId, providerSessionId);
    db.prepare(
      "UPDATE workspaces SET current_session_id = ?, init_stage = 'provisioning sandbox' WHERE id = ?"
    ).run(sessionId, workspaceId);
  })();
  invalidate([...WORKSPACE_RESOURCES], {});
  return sessionId;
}

export function applyCloudStatus(
  workspaceId: string,
  data: { status?: string; step?: string },
  { beforePublish }: { beforePublish: () => void }
): void {
  const db = getDatabase();
  const status = data.status ?? "";
  if (status === "running") {
    db.prepare(
      "UPDATE workspaces SET state = 'ready', init_stage = NULL, error_message = NULL WHERE id = ? AND state != 'archived'"
    ).run(workspaceId);
  } else if (status === "provisioning") {
    db.prepare(
      "UPDATE workspaces SET state = 'initializing', init_stage = ? WHERE id = ? AND state != 'archived'"
    ).run(data.step ?? "provisioning", workspaceId);
  } else if (status === "error") {
    db.prepare(
      "UPDATE workspaces SET state = 'error', error_message = ? WHERE id = ? AND state != 'archived'"
    ).run(data.step ?? "cloud workspace error", workspaceId);
  } else {
    // paused/stopped/resuming — surface as the init stage without leaving 'ready'.
    db.prepare("UPDATE workspaces SET init_stage = ? WHERE id = ? AND state != 'archived'").run(
      status || null,
      workspaceId
    );
  }
  try {
    beforePublish();
  } finally {
    invalidate(["workspaces"], {});
  }
}

export function setCloudWakeStage(db: Database, workspaceId: string, stage: string | null): void {
  db.prepare("UPDATE workspaces SET init_stage = ? WHERE id = ?").run(stage, workspaceId);
  invalidate(["workspaces"], {});
}

export function beginSendWake(workspaceId: string): void {
  getDatabase()
    .prepare("UPDATE workspaces SET init_stage = 'resuming' WHERE id = ?")
    .run(workspaceId);
  invalidate(["workspaces"], {});
}

export function rollbackSendWake(workspaceId: string, asleepStage: "paused" | "stopped"): void {
  getDatabase()
    .prepare("UPDATE workspaces SET init_stage = ? WHERE id = ? AND init_stage = 'resuming'")
    .run(asleepStage, workspaceId);
  invalidate(["workspaces"], {});
}

// Archive, unarchive and explicit wake share one queue: a delayed Resume
// must finish before a later Pause can advertise the workspace as archived.
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

/** The API and assistants' host publish after archiveWorkspace finishes the pause, write, workflow update, setup stop and checkout cleanup. */
export function markArchived(db: Database, workspaceId: string, check?: () => void) {
  check?.();
  db.prepare("UPDATE workspaces SET state = 'archived' WHERE id = ?").run(workspaceId);
  const attempt = attempts.get(workspaceId);
  attempt?.controller.abort();
  return attempt?.settle();
}

/** The updateWorkspace API publishes after unarchiveWorkspace finishes wake and the workflow update. */
export function markRestored(db: Database, workspaceId: string) {
  const row = getWorkspaceRaw(db, workspaceId);
  if (!row) throw new NotFoundError("Workspace not found");
  if (row.state !== "archived") return;
  if (row.kind === "cloud" && row.provider_workspace_id) {
    // Open the row before waking so the driver can apply an early platform report.
    db.prepare("UPDATE workspaces SET state = 'ready' WHERE id = ?").run(workspaceId);
  } else {
    db.prepare(
      "UPDATE workspaces SET state = CASE WHEN current_session_id IS NULL THEN 'error' ELSE 'ready' END WHERE id = ?"
    ).run(workspaceId);
  }
  return row;
}

export function rollbackCloudRestore(db: Database, workspaceId: string): void {
  db.prepare("UPDATE workspaces SET state = 'archived' WHERE id = ?").run(workspaceId);
  invalidate(["workspaces"], {});
}

/** Resurface an archived adopted workspace and repoint its current session.
 *  Only a revival invalidates the workspace list. */
export function reviveAdoptedWorkspace(workspaceId: string, sessionId: string): void {
  const db = getDatabase();
  const revived = markAdoptedWorkspaceReady(db, workspaceId);
  db.prepare(
    "UPDATE workspaces SET current_session_id = ?, updated_at = datetime('now') WHERE id = ? AND current_session_id IS NOT ?"
  ).run(sessionId, workspaceId, sessionId);
  if (revived) invalidate(["workspaces"]);
}

/** reviveAdoptedWorkspace publishes after selecting the chat, or openAutomationRun after commit and backfill. */
export function markAdoptedWorkspaceReady(db: Database, workspaceId: string): boolean {
  return (
    db
      .prepare(
        "UPDATE workspaces SET state = 'ready', updated_at = datetime('now') WHERE id = ? AND state = 'archived'"
      )
      .run(workspaceId).changes > 0
  );
}

/** openAutomationRun publishes after the adoption transaction commits and the transcript is backfilled. */
export function insertAdoptedWorkspace(
  db: Database,
  row: Pick<
    WorkspaceRow,
    "id" | "repository_id" | "slug" | "title" | "provider_workspace_id" | "organization_id"
  >
): void {
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
  db: Database,
  workspaceId: string,
  sessionId: string,
  organizationId: string | null
): void {
  db.prepare(
    "UPDATE workspaces SET current_session_id = ?, organization_id = COALESCE(organization_id, ?), updated_at = datetime('now') WHERE id = ?"
  ).run(sessionId, organizationId, workspaceId);
}

/** The integration CLI seeds its private database without publishing a live read. */
export function prepareWorkspaceFixture(db: Database) {
  return db.prepare(
    `INSERT OR IGNORE INTO workspaces (id, repository_id, slug, state) VALUES (?, ?, 'cli-test', 'ready')`
  );
}
