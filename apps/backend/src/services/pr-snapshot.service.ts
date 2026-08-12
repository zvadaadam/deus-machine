/**
 * PR snapshot persistence — keeps the workspaces table's pr_* columns in sync
 * with live GitHub state so the sidebar can render PR lifecycle for every
 * workspace without one gh call per row.
 *
 * Refresh points:
 *   - GET /workspaces/:id/pr-status (frontend polls the open workspace)
 *   - session.idle (agent turn ended — catches PRs the agent just created)
 */
import { getDatabase } from "../lib/database";
import { getPrStatus, type PrStatusResponse } from "./gh.service";
import { getSessionById, getWorkspaceById } from "../db/queries";
import { computeWorkspacePath } from "../middleware/workspace-loader";
import { autoProgressStatus } from "./workspace-status.service";
import { invalidate } from "./query-engine";

interface PrSnapshotRow {
  pr_url: string | null;
  pr_number: number | null;
  pr_state: string | null;
  pr_is_draft: number;
  pr_review_status: string | null;
  pr_has_conflicts: number;
  pr_ci_status: string | null;
}

/**
 * Persist the PR lifecycle snapshot + auto-progress workflow status.
 * Writes (and invalidates the workspaces resource) only when something changed.
 */
export function applyPrStatusSideEffects(workspaceId: string, result: PrStatusResponse): void {
  // gh unavailable / network error — keep the last known snapshot.
  if (result.error) return;
  // Inconclusive "no PR" (missing worktree, detached HEAD, unparseable gh
  // output) must not wipe a previously persisted snapshot.
  if (!result.has_pr && !result.conclusive) return;

  const db = getDatabase();
  const current = db
    .prepare(
      `SELECT pr_url, pr_number, pr_state, pr_is_draft, pr_review_status, pr_has_conflicts, pr_ci_status
       FROM workspaces WHERE id = ?`
    )
    .get(workspaceId) as PrSnapshotRow | undefined;
  if (!current) return;

  const next: PrSnapshotRow = result.has_pr
    ? {
        pr_url: result.pr_url ?? current.pr_url,
        pr_number: result.pr_number ?? current.pr_number,
        pr_state: result.pr_state ?? null,
        pr_is_draft: result.is_draft ? 1 : 0,
        pr_review_status: result.review_status ?? null,
        pr_has_conflicts: result.has_conflicts ? 1 : 0,
        pr_ci_status: result.ci_status ?? null,
      }
    : {
        ...current,
        pr_state: null,
        pr_is_draft: 0,
        pr_review_status: null,
        pr_has_conflicts: 0,
        pr_ci_status: null,
      };

  let needsInvalidation = false;

  const changed = (Object.keys(next) as (keyof PrSnapshotRow)[]).some(
    (key) => next[key] !== current[key]
  );
  if (changed) {
    db.prepare(
      `UPDATE workspaces SET
         pr_url = ?, pr_number = ?, pr_state = ?, pr_is_draft = ?,
         pr_review_status = ?, pr_has_conflicts = ?, pr_ci_status = ?,
         pr_checked_at = datetime('now')
       WHERE id = ?`
    ).run(
      next.pr_url,
      next.pr_number,
      next.pr_state,
      next.pr_is_draft,
      next.pr_review_status,
      next.pr_has_conflicts,
      next.pr_ci_status,
      workspaceId
    );
    needsInvalidation = true;
  }

  // Workflow auto-derivation: PR exists → in-review, PR merged → done.
  if (result.has_pr && autoProgressStatus(workspaceId, "in-review")) needsInvalidation = true;
  if (result.merge_status === "merged" && autoProgressStatus(workspaceId, "done")) {
    needsInvalidation = true;
  }

  if (needsInvalidation) {
    invalidate(["workspaces", "stats"]);
  }
}

// Throttle state for the unattended turn-end path. `session.idle` fires once
// per turn per session, and the product runs many agents in parallel — without
// this every turn would spawn a git + gh subprocess chain (and a GitHub API
// call) even for workspaces that will never have a PR.
const REFRESH_COOLDOWN_MS = 60_000;
const inFlight = new Set<string>();
const lastRefreshAt = new Map<string, number>();

/** Turn-end hook: refresh the PR snapshot for the session's workspace. */
export async function refreshPrSnapshotForSession(sessionId: string): Promise<void> {
  try {
    const db = getDatabase();
    const session = getSessionById(db, sessionId);
    if (!session) return;

    const workspaceId = session.workspace_id;
    const last = lastRefreshAt.get(workspaceId);
    if (inFlight.has(workspaceId) || (last && Date.now() - last < REFRESH_COOLDOWN_MS)) return;

    const workspace = getWorkspaceById(db, workspaceId);
    if (!workspace || workspace.state === "archived") return;

    const workspacePath = computeWorkspacePath(workspace);
    if (!workspacePath) return;

    inFlight.add(workspaceId);
    lastRefreshAt.set(workspaceId, Date.now());
    try {
      const result = await getPrStatus(workspacePath);
      applyPrStatusSideEffects(workspace.id, result);
    } finally {
      inFlight.delete(workspaceId);
    }
  } catch (error) {
    // Best-effort background refresh — never let it break the event pipeline.
    console.error(`[PrSnapshot] Refresh failed for session ${sessionId}:`, error);
  }
}
