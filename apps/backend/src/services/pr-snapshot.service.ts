/**
 * PR snapshot persistence — keeps the workspaces table's pr_* columns in sync
 * with live GitHub state so the sidebar can render PR lifecycle for every
 * workspace without one gh call per row.
 *
 * Refresh points:
 *   - GET /workspaces/:id/pr-status (frontend polls the open workspace)
 *   - session.idle / session.error / session.cancelled (turn ended — the
 *     agent may have created or updated a PR before finishing or failing)
 *
 * Background refreshes are throttled per workspace (cooldown + coalesced
 * trailing refresh so a skipped event is deferred, never dropped) and bounded
 * globally so N agents finishing together can't spawn N gh chains at once.
 */
import { getDatabase } from "../lib/database";
import { getPrStatus, getPrStatusForRemoteBranch, type PrStatusResponse } from "./gh.service";
import { httpsOrigin } from "@shared/git-origin";
import { getRepositoryById } from "../db";
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
 *
 * pr_url/pr_number are deliberately preserved on a conclusive no-PR result:
 * workspaces created from the GitHub PR picker store them before the branch
 * exists, and they act as the PR-linkage breadcrumb either way.
 */
export function applyPrStatusSideEffects(workspaceId: string, result: PrStatusResponse): void {
  // gh unavailable / network error — keep the last known snapshot.
  if (result.error) return;
  // Inconclusive "no PR" (missing worktree, detached HEAD, unparseable gh
  // output, partially failed fork lookup) must not wipe a stored snapshot.
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

  // Workflow auto-derivation: OPEN PR → in-review, merged PR → done.
  // Closed-unmerged PRs must not progress the workflow.
  if (result.pr_state === "open" && autoProgressStatus(workspaceId, "in-review")) {
    needsInvalidation = true;
  }
  if (result.merge_status === "merged" && autoProgressStatus(workspaceId, "done")) {
    needsInvalidation = true;
  }

  if (needsInvalidation) {
    invalidate(["workspaces", "stats"]);
  }
}

// ── Refresh orchestration ────────────────────────────────────────────────

const REFRESH_COOLDOWN_MS = 60_000;
/** Wait before re-checking when a workspace is busy or capacity is full. */
const BUSY_RETRY_MS = 5_000;
/** Global bound: N agents finishing together must not spawn N gh chains. */
const MAX_CONCURRENT_REFRESHES = 3;

let activeRefreshes = 0;
const lastRefreshAt = new Map<string, number>();
const trailingTimers = new Map<string, ReturnType<typeof setTimeout>>();
/** Cloud workspaces have no local checkout — query gh by repo + branch name
 *  from the DB instead of a worktree. Local workspaces keep the path-based
 *  lookup (fork detection needs the remotes). */
async function lookupPrStatus(
  workspaceId: string,
  workspacePath: string
): Promise<PrStatusResponse> {
  const db = getDatabase();
  const workspace = getWorkspaceById(db, workspaceId);
  if (workspace?.kind === "cloud") {
    const repo = getRepositoryById(db, workspace.repository_id);
    if (!repo?.git_origin_url || !workspace.git_branch) {
      return { has_pr: false, conclusive: false, error: null };
    }
    return getPrStatusForRemoteBranch(httpsOrigin(repo.git_origin_url), workspace.git_branch);
  }
  return getPrStatus(workspacePath);
}

/** One gh lookup per workspace at a time — concurrent callers share it. */
const inFlightFetch = new Map<string, Promise<PrStatusResponse>>();

/**
 * Fetch + persist in one step, coalesced per workspace: concurrent callers
 * (route poll + terminal-turn refresh) share a single gh lookup, so ordering
 * races can't happen and every caller receives the result that was actually
 * persisted. Both the route and the background path go through here.
 */
export function fetchAndApplyPrStatus(
  workspaceId: string,
  workspacePath: string
): Promise<PrStatusResponse> {
  const existing = inFlightFetch.get(workspaceId);
  if (existing) return existing;

  const fetch = (async () => {
    const result = await lookupPrStatus(workspaceId, workspacePath);
    lastRefreshAt.set(workspaceId, Date.now());
    applyPrStatusSideEffects(workspaceId, result);
    return result;
  })();

  inFlightFetch.set(
    workspaceId,
    fetch.finally(() => inFlightFetch.delete(workspaceId))
  );
  return inFlightFetch.get(workspaceId)!;
}

/** Terminal-turn hook: refresh the PR snapshot for the session's workspace. */
export function refreshPrSnapshotForSession(sessionId: string): void {
  try {
    const session = getSessionById(getDatabase(), sessionId);
    if (!session) return;
    scheduleWorkspaceRefresh(session.workspace_id);
  } catch (error) {
    // Best-effort background refresh — never let it break the event pipeline.
    console.error(`[PrSnapshot] Refresh scheduling failed for session ${sessionId}:`, error);
  }
}

/**
 * Schedule a background refresh. Inside the cooldown (or while busy) the
 * refresh is deferred via a coalesced trailing timer — repeated events
 * collapse into one pending refresh, and none are silently dropped.
 */
function scheduleWorkspaceRefresh(workspaceId: string): void {
  if (trailingTimers.has(workspaceId)) return;

  const last = lastRefreshAt.get(workspaceId) ?? 0;
  const cooldownWait = Math.max(0, last + REFRESH_COOLDOWN_MS - Date.now());
  const busy = inFlightFetch.has(workspaceId) || activeRefreshes >= MAX_CONCURRENT_REFRESHES;
  const wait = Math.max(cooldownWait, busy ? BUSY_RETRY_MS : 0);

  if (wait > 0) {
    const timer = setTimeout(() => {
      trailingTimers.delete(workspaceId);
      scheduleWorkspaceRefresh(workspaceId);
    }, wait);
    timer.unref?.();
    trailingTimers.set(workspaceId, timer);
    return;
  }

  void runWorkspaceRefresh(workspaceId);
}

async function runWorkspaceRefresh(workspaceId: string): Promise<void> {
  const workspace = getWorkspaceById(getDatabase(), workspaceId);
  if (!workspace || workspace.state === "archived") return;

  const workspacePath = computeWorkspacePath(workspace);
  if (!workspacePath && workspace.kind !== "cloud") return;

  activeRefreshes++;
  try {
    await fetchAndApplyPrStatus(workspaceId, workspacePath);
  } catch (error) {
    console.error(`[PrSnapshot] Refresh failed for workspace ${workspaceId}:`, error);
  } finally {
    activeRefreshes--;
  }
}
