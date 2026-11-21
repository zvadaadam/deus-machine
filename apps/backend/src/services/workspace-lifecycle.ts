/** Owns changes to a workspace's lifecycle, including deletion of a failed start. */
import path from "node:path";
import type { Origin } from "@zvada/agent-server/protocol";
import type { ParsedInputOf } from "@shared/api/op";
import type * as api from "@shared/api/workspaces";
import type { InitFetchIssue, SetupStatus } from "@shared/enums";
import { httpsOrigin } from "@shared/git-origin";
import { uuidv7 } from "@shared/lib/uuid";
import { getRepositoryById, getWorkspaceRaw } from "../db";
import { getDatabase } from "../lib/database";
import { ConflictError, NotFoundError, ValidationError } from "../lib/errors";
import { computeWorkspacePath } from "../middleware/workspace-loader";
import { cloudAccount, requireCloudOrg } from "./agent/cloud/config";
import { parkCloudSimulator } from "./agent/cloud/simulator";
import {
  markWorkspaceTokenRefreshed,
  pauseCloudWorkspace,
  provisionCloudWorkspace,
  wakeCloudWorkspaceWithFeedback,
} from "./cloud-workspace-init.service";
import { prepareLocalEnvironment, stopWorkspaceSetup } from "./project-environment.service";
import { invalidate } from "./query-engine";
import { SETUP_INTERRUPTED, writeSetupStatusFile } from "./setup-status";
import {
  initializeWorkspace,
  pickWorkspaceName,
  removeWorktree,
  OWNS_WORKTREE,
  type InitContext,
  type Stage,
} from "./workspace-init.service";
import { generateUniqueName } from "./workspace.service";
import { autoProgressStatus } from "./workspace-status.service";

type Database = ReturnType<typeof getDatabase>;
type CreateWorkspaceInput = ParsedInputOf<typeof api.createWorkspace>;

export async function createWorkspace(
  input: CreateWorkspaceInput
): Promise<{ workspaceId: string }> {
  // Cloud: the row now, the sandbox in the background. Progress arrives as
  // workspace.state events through the cloud driver.
  if (input.location === "cloud") {
    if (!getRepositoryById(getDatabase(), input.repository_id))
      throw new NotFoundError("Repository not found");
    // Signed out is a state the person can fix, not a server fault.
    if (!cloudAccount()) {
      throw new ValidationError(
        "Sign in to Deus Cloud to create cloud workspaces (Settings → Cloud)."
      );
    }
    return createCloudWorkspace({
      repositoryId: input.repository_id,
      sourceBranch: input.source_branch,
      organizationId: input.organization_id,
    });
  }

  const { workspaceId } = await createLocalWorkspace(input);
  return { workspaceId };
}

/**
 * Reserve the first chat before starting the checkout in the background.
 * The operator's admission check counts setups immediately before the insert.
 */
export async function createLocalWorkspace(
  input: Omit<CreateWorkspaceInput, "location" | "organization_id">,
  options: { startedBy?: Origin; admit?: () => void } = {}
): Promise<{ workspaceId: string; firstSessionId: string }> {
  const db = getDatabase();
  const repo = getRepositoryById(db, input.repository_id);
  if (!repo) throw new NotFoundError("Repository not found");
  const rootPath = repo.root_path;
  if (!rootPath) {
    throw new ConflictError(
      `${repo.name} is not on this computer, so it can only run in the cloud. Turn on Cloud, or open its folder on this Mac first.`
    );
  }
  const sourceBranch = input.source_branch || repo.git_default_branch || "main";
  const workspaceId = uuidv7();
  const firstSessionId = uuidv7();
  const { slug, branchName } = await pickWorkspaceName(rootPath);

  options.admit?.();
  db.prepare(
    `INSERT INTO workspaces (
       id, repository_id, slug, title, git_branch, git_source_branch,
       git_target_branch, pr_url, pr_number, state, first_session_id, started_by, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'initializing', ?, ?, datetime('now'))`
  ).run(
    workspaceId,
    input.repository_id,
    slug,
    input.pr_title || null,
    branchName,
    sourceBranch,
    input.target_branch || repo.git_default_branch || "main",
    input.pr_url || null,
    input.pr_number || null,
    firstSessionId,
    options.startedBy && options.startedBy.kind !== "person"
      ? JSON.stringify(options.startedBy)
      : null
  );

  // Not awaited, and it never rejects: the pipeline records its own failure.
  void initializeWorkspace({
    workspaceId,
    repoRootPath: rootPath,
    workspacePath: path.join(rootPath, ".deus", slug),
    branchName,
    sourceBranch,
    repoOriginUrl: repo.git_origin_url,
  });

  // Clients see the row in `initializing` at once.
  invalidate(["workspaces"]);
  return { workspaceId, firstSessionId };
}

export function advanceLocalStage(workspaceId: string, stage: Stage): void {
  try {
    getDatabase()
      .prepare("UPDATE workspaces SET init_stage = ? WHERE id = ?")
      .run(stage, workspaceId);
  } catch (err) {
    // The stage is progress, not state: a locked database must not stop the work.
    console.warn(`[WORKSPACE] Could not record stage "${stage}" for ${workspaceId}:`, err);
  }
  invalidate(["workspaces"]);
}

export function recordFetchOutcome(workspaceId: string, issue: InitFetchIssue | null): void {
  getDatabase()
    .prepare("UPDATE workspaces SET init_fetch_issue = ? WHERE id = ?")
    .run(issue, workspaceId);
}

/**
 * The first chat, under the id minted with the workspace, started by whoever
 * started it; only while the workspace is still starting, in the same
 * transaction. Setup is marked running before a ready observer can send.
 */
export function finishLocalStart(ctx: InitContext): void {
  const { workspaceId } = ctx;
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
  if (opened) {
    void prepareLocalEnvironment(workspaceId, ctx.workspacePath, ctx.repoOriginUrl).catch((err) =>
      console.warn(`[WORKSPACE] Setup for ${workspaceId} failed:`, err)
    );
  }
  invalidate(["workspaces", "sessions"]);
}

export function failStart(
  workspaceId: string,
  stage: string,
  failure: { message: string; detail: string | null }
): void {
  getDatabase()
    .prepare(
      `UPDATE workspaces
       SET state = 'error', init_stage = ?, error_message = ?, error_detail = ?
       WHERE id = ?`
    )
    .run(stage, failure.message, failure.detail, workspaceId);
  invalidate(["workspaces"]);
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

/** Start a failed local workspace again, on the same row. */
export function retryWorkspaceInit(workspaceId: string): void {
  const db = getDatabase();
  const row = db.prepare(`${START_ROW} WHERE w.id = ?`).get(workspaceId) as StartRow | undefined;
  if (!row || !row.root_path || !row.slug || !row.git_branch)
    throw new NotFoundError("Workspace not found");
  // The claim: two clicks, or two devices, start it once.
  const claimed = db
    .prepare(
      `UPDATE workspaces
       SET state = 'initializing', init_stage = NULL,
           error_message = NULL, error_detail = NULL, init_fetch_issue = NULL
       WHERE id = ? AND state = 'error' AND kind = 'worktree'`
    )
    .run(workspaceId);
  if (claimed.changes === 0) throw new ConflictError("This workspace is not waiting for a retry.");
  if (row.setup_status !== "none") setSetupStatus(workspaceId, "none");
  invalidate(["workspaces"]);
  void initializeWorkspace({
    workspaceId,
    repoRootPath: row.root_path,
    workspacePath: computeWorkspacePath(row),
    branchName: row.git_branch,
    sourceBranch:
      row.git_source_branch ?? row.git_target_branch ?? row.git_default_branch ?? "main",
    repoOriginUrl: row.git_origin_url,
  });
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
  const used = db
    .prepare("SELECT 1 FROM sessions WHERE workspace_id = ? AND message_count > 0 LIMIT 1")
    .get(workspaceId);
  if (used) throw new ConflictError("This workspace has chats. Archive it instead.");
  // Its sessions go with it (ON DELETE CASCADE). The failed attempt already
  // removed its folder and branch.
  db.prepare("DELETE FROM workspaces WHERE id = ? AND state = 'error'").run(workspaceId);
  invalidate(["workspaces", "sessions"]);
}

/**
 * At startup: nothing is starting a workspace yet, so a row that says one is
 * being started was abandoned by the process before this one. Fail it, with
 * the folder and branch it may have half made, so it can be retried or deleted
 * instead of spinning forever. A setup script died with that process as well.
 *
 * A cloud workspace with a session is left alone: its computer is provisioned
 * by the platform, which reports through the session's channel.
 */
export function failInterruptedWorkspaces(): number {
  const db = getDatabase();
  const interrupted = db
    .prepare("SELECT id FROM workspaces WHERE setup_status = 'running'")
    .all() as { id: string }[];
  for (const row of interrupted) {
    setSetupStatus(row.id, "failed", { message: SETUP_INTERRUPTED });
  }
  const rows = db.prepare(`${START_ROW} WHERE w.state = 'initializing'`).all() as StartRow[];
  let failed = 0;
  for (const row of rows) {
    const cloud = row.kind === "cloud";
    if (cloud && row.current_session_id) continue;
    failStart(row.id, row.init_stage ?? "fetch", {
      message: cloud
        ? "Deus closed before the cloud computer was ready."
        : "Deus closed before this workspace was ready.",
      detail: null,
    });
    failed++;
    if (!cloud && row.root_path && row.git_branch && OWNS_WORKTREE.has(row.init_stage ?? "")) {
      void removeWorktree(row.root_path, computeWorkspacePath(row), row.git_branch).catch((err) =>
        console.warn(`[WORKSPACE] Could not remove what ${row.id} left behind:`, err)
      );
    }
  }
  return failed;
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
  writeSetupStatusFile(workspaceId, status, failure?.exitCode);
  invalidate(["workspaces"]);
}

const WORKSPACE_RESOURCES = ["workspaces", "sessions", "session"] as const;

interface CreateCloudWorkspaceParams {
  repositoryId: string;
  /** Branch the sandbox checks out; defaults to the repo's default branch. */
  sourceBranch?: string;
  /** The organization it runs in; the default organization when omitted. */
  organizationId?: string | null;
}

/**
 * Create a cloud workspace: row now, sandbox in the background.
 * Throws synchronously for everything the user must fix (no config, repo
 * without a remote); background failures land on the row as state='error'.
 */
export function createCloudWorkspace(params: CreateCloudWorkspaceParams): {
  workspaceId: string;
  slug: string;
} {
  if (!cloudAccount()) {
    throw new ValidationError(
      "Cloud workspaces are not configured — set DEUS_CLOUD_AGNT_API_KEY (and DEUS_CLOUD_AGNT_URL for a non-production backend)."
    );
  }
  const org = requireCloudOrg(params.organizationId);

  const db = getDatabase();
  const repo = getRepositoryById(db, params.repositoryId);
  if (!repo) throw new NotFoundError(`Repository not found: ${params.repositoryId}`);
  if (!repo.git_origin_url) {
    throw new ValidationError(
      "Cloud workspaces need a git remote: this repository has no origin URL for the sandbox to clone."
    );
  }

  const workspaceId = uuidv7();
  const slug = generateUniqueName(db);
  const sourceBranch = params.sourceBranch || repo.git_default_branch || "main";
  // The sandbox works on its OWN branch off the source (parity with local
  // worktrees): PRs need head ≠ base, and the turn-end wip snapshots hang off
  // this branch's history.
  const workBranch = slug;

  db.prepare(
    `INSERT INTO workspaces (
       id, repository_id, slug, kind, git_branch, git_target_branch,
       organization_id, state, init_stage, updated_at
     ) VALUES (?, ?, ?, 'cloud', ?, ?, ?, 'initializing', 'creating cloud workspace', datetime('now'))`
  ).run(workspaceId, params.repositoryId, slug, workBranch, sourceBranch, org.orgId);
  invalidate([...WORKSPACE_RESOURCES], {});

  void provisionCloudWorkspace(
    workspaceId,
    httpsOrigin(repo.git_origin_url),
    { source: sourceBranch, work: workBranch },
    org
  );

  return { workspaceId, slug };
}

/**
 * Provision a failed cloud workspace again, on the same row. Only while no
 * computer exists for it: everything that fails before the platform is asked
 * for one (GitHub access, project settings, the request itself) is safe to
 * repeat. Once a computer exists, waking it is the way back.
 */
export function retryCloudWorkspace(workspaceId: string): void {
  if (!cloudAccount())
    throw new ValidationError("Sign in to Deus Cloud to try this workspace again.");
  const db = getDatabase();
  const workspace = db
    .prepare(
      "SELECT repository_id, git_branch, git_target_branch, organization_id FROM workspaces WHERE id = ? AND kind = 'cloud'"
    )
    .get(workspaceId) as
    | {
        repository_id: string;
        git_branch: string | null;
        git_target_branch: string | null;
        organization_id: string | null;
      }
    | undefined;
  const repo = workspace && getRepositoryById(db, workspace.repository_id);
  if (!workspace?.git_branch || !repo?.git_origin_url)
    throw new NotFoundError("Workspace not found");
  const org = requireCloudOrg(workspace.organization_id);
  // The claim: two clicks, or two devices, provision it once.
  const claimed = db
    .prepare(
      `UPDATE workspaces
       SET state = 'initializing', init_stage = 'creating cloud workspace',
           error_message = NULL, error_detail = NULL
       WHERE id = ? AND state = 'error' AND provider_workspace_id IS NULL`
    )
    .run(workspaceId);
  if (claimed.changes === 0) throw new ConflictError("This workspace is not waiting for a retry.");
  invalidate([...WORKSPACE_RESOURCES], {});
  void provisionCloudWorkspace(
    workspaceId,
    httpsOrigin(repo.git_origin_url),
    {
      source: workspace.git_target_branch || repo.git_default_branch || "main",
      work: workspace.git_branch,
    },
    org
  );
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
  hasRepositoryAuth: boolean
): void {
  db.prepare(
    "UPDATE workspaces SET provider_workspace_id = ?, init_stage = 'creating cloud session', last_inline_mint_at = ? WHERE id = ?"
  ).run(providerId, mintedAt, workspaceId);
  if (hasRepositoryAuth) markWorkspaceTokenRefreshed(providerId);
  invalidate([...WORKSPACE_RESOURCES], {});
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
  data: { status?: string; step?: string }
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
  // The hosted device attaches to the SANDBOX: agnt parks every device when
  // the sandbox parks (stopped/paused/error) and settles a `stopped` status —
  // but that settle rides the session socket, which is often exactly what is
  // down when the sandbox dies. Park the cached device here too, so no client
  // keeps a stream URL for a device the platform already billed off.
  if (status === "stopped" || status === "paused" || status === "error") {
    parkCloudSimulator(workspaceId);
  }
  invalidate(["workspaces"], {});
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

/**
 * Every caller archives the same way. Cloud archive preserves its recovery
 * data. `check`, when given, runs in the queue right before the update, with
 * no await between, and may refuse it (the operator's host re-reads its
 * archive eligibility there).
 */
async function performArchive(workspaceId: string, check?: () => void): Promise<void> {
  const db = getDatabase();
  const workspace = getWorkspaceRaw(db, workspaceId);
  if (!workspace) throw new NotFoundError("Workspace not found");
  if (workspace.kind === "cloud" && workspace.provider_workspace_id) {
    // Confirm suspension before advertising the workspace as closed.
    await pauseCloudWorkspace({
      ...workspace,
      provider_workspace_id: workspace.provider_workspace_id,
    });
  }

  check?.();
  db.prepare("UPDATE workspaces SET state = 'archived' WHERE id = ?").run(workspaceId);
  const stopped = stopWorkspaceSetup(workspaceId);
  autoProgressStatus(workspaceId, "done", { force: true });
  await stopped;
}

// Archive, unarchive and explicit wake share one queue: a delayed Resume
// must finish before a later Pause can advertise the workspace as archived.
const changes = new Map<string, Promise<unknown>>();

function changeWorkspaceState<T>(workspaceId: string, change: () => Promise<T>): Promise<T> {
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

export function archiveWorkspace(workspaceId: string, check?: () => void): Promise<void> {
  return changeWorkspaceState(workspaceId, () => performArchive(workspaceId, check));
}

export function wakeWorkspace(workspaceId: string) {
  return changeWorkspaceState(workspaceId, async () => {
    const workspace = getWorkspaceRaw(getDatabase(), workspaceId);
    if (!workspace) throw new NotFoundError("Workspace not found");
    if (workspace.kind !== "cloud" || !workspace.provider_workspace_id) {
      throw new ValidationError("Not a cloud workspace");
    }
    if (workspace.state === "archived") {
      throw new ValidationError("Workspace is archived — unarchive it first");
    }
    return wakeCloudWorkspaceWithFeedback({
      ...workspace,
      provider_workspace_id: workspace.provider_workspace_id,
    });
  });
}

export function unarchiveWorkspace(workspaceId: string): Promise<void> {
  return changeWorkspaceState(workspaceId, async () => {
    const db = getDatabase();
    const workspace = getWorkspaceRaw(db, workspaceId);
    if (!workspace) throw new NotFoundError("Workspace not found");
    if (workspace.state !== "archived") return;
    if (workspace.kind === "cloud" && workspace.provider_workspace_id) {
      // Open the projection before waking: a running/provisioning event may
      // arrive before Resume returns, and the driver ignores archived rows.
      db.prepare("UPDATE workspaces SET state = 'ready' WHERE id = ?").run(workspaceId);
      try {
        const result = await wakeCloudWorkspaceWithFeedback({
          ...workspace,
          provider_workspace_id: workspace.provider_workspace_id,
        });
        // A failed status refresh can still leave the computer serving.
        if (!result.ok && result.status !== "running") {
          throw new Error("Could not wake the cloud machine. Try again.");
        }
      } catch (err) {
        rollbackCloudRestore(db, workspaceId);
        throw err;
      }
    } else {
      // With no chat it was archived before it finished starting.
      db.prepare(
        "UPDATE workspaces SET state = CASE WHEN current_session_id IS NULL THEN 'error' ELSE 'ready' END WHERE id = ?"
      ).run(workspaceId);
    }
    if (getWorkspaceRaw(db, workspaceId)?.status === "done") {
      autoProgressStatus(workspaceId, "in-progress", { force: true });
    }
  });
}

function rollbackCloudRestore(db: Database, workspaceId: string): void {
  db.prepare("UPDATE workspaces SET state = 'archived' WHERE id = ?").run(workspaceId);
  invalidate(["workspaces"], {});
}

/** Resurface an archived adopted workspace and repoint its current session.
 *  Only a revival invalidates the workspace list. */
export function reviveAdoptedWorkspace(workspaceId: string, sessionId: string): void {
  const db = getDatabase();
  const revived = db
    .prepare(
      "UPDATE workspaces SET state = 'ready', updated_at = datetime('now') WHERE id = ? AND state = 'archived'"
    )
    .run(workspaceId);
  db.prepare(
    "UPDATE workspaces SET current_session_id = ?, updated_at = datetime('now') WHERE id = ? AND current_session_id IS NOT ?"
  ).run(sessionId, workspaceId, sessionId);
  if (revived.changes > 0) invalidate(["workspaces"]);
}

/**
 * Find-or-create the deus workspace/session rows for a run's platform ids —
 * ONE transaction, so a mid-sequence failure can never leave a workspace
 * whose current_session_id points at a session that never landed (the same
 * atomicity the cloud-workspace-init pair keeps). The session owns its
 * workspace: same_session runs reuse one session across fires, and adopting
 * it into a different workspace would orphan it from that workspace's scoped
 * queries — an archived owner is resurfaced instead.
 */
export function adoptRunRows(input: {
  runId: string;
  automationId: string;
  repositoryId: string;
  automationName: string;
  providerSessionId: string;
  providerWorkspaceId: string;
  /** The automation's organization: the run's workspace is in it. */
  organizationId: string | null;
  newWorkspaceSlug: () => string;
}): { workspaceId: string; sessionId: string } {
  const db = getDatabase();
  const adopt = db.transaction(() => {
    let session = db
      .prepare("SELECT id, workspace_id FROM sessions WHERE provider_session_id = ?")
      .get(input.providerSessionId) as { id: string; workspace_id: string } | undefined;

    let workspaceId: string;
    if (session) {
      workspaceId = session.workspace_id;
      db.prepare(
        "UPDATE workspaces SET state = 'ready', updated_at = datetime('now') WHERE id = ? AND state = 'archived'"
      ).run(workspaceId);
    } else {
      const found = db
        .prepare(
          "SELECT id FROM workspaces WHERE provider_workspace_id = ? AND state != 'archived'"
        )
        .get(input.providerWorkspaceId) as { id: string } | undefined;
      if (found) {
        workspaceId = found.id;
      } else {
        workspaceId = uuidv7();
        db.prepare(
          `INSERT INTO workspaces (id, repository_id, slug, title, state, kind, provider_workspace_id, organization_id)
           VALUES (?, ?, ?, ?, 'ready', 'cloud', ?, ?)`
        ).run(
          workspaceId,
          input.repositoryId,
          input.newWorkspaceSlug(),
          input.automationName,
          input.providerWorkspaceId,
          input.organizationId
        );
      }
      const sessionId = uuidv7();
      db.prepare(
        `INSERT INTO sessions (id, workspace_id, agent_harness, provider_session_id, status)
         VALUES (?, ?, 'claude-code', ?, 'idle')`
      ).run(sessionId, workspaceId, input.providerSessionId);
      session = { id: sessionId, workspace_id: workspaceId };
    }

    db.prepare(
      "UPDATE workspaces SET current_session_id = ?, organization_id = COALESCE(organization_id, ?), updated_at = datetime('now') WHERE id = ?"
    ).run(session.id, input.organizationId, workspaceId);
    db.prepare("UPDATE automation_runs SET session_id = ?, workspace_id = ? WHERE id = ?").run(
      session.id,
      workspaceId,
      input.runId
    );
    db.prepare("UPDATE automations SET workspace_id = ? WHERE id = ?").run(
      workspaceId,
      input.automationId
    );
    return { workspaceId, sessionId: session.id };
  });
  return adopt();
}

/** The integration CLI prepares a ready workspace on its own database. */
export function prepareWorkspaceFixture(db: Database) {
  return db.prepare(
    `INSERT OR IGNORE INTO workspaces (id, repository_id, slug, state) VALUES (?, ?, 'cli-test', 'ready')`
  );
}
