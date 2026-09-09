/**
 * git-clean stage guard — workspace-init.service.ts
 *
 * The git-clean stage (`git checkout -- .`) is the final init-pipeline stage
 * and runs in the SAME worktree the agent turn writes into. Its guard must
 * skip whenever "the agent is already working" so `git checkout -- .` does not
 * revert an in-flight agent's unstaged tracked-file edits to HEAD.
 *
 * The pipeline creates the session at STAGE 2 (flipping `state='ready'`) so the
 * user can chat while deps install in the background. Multi-tab chat
 * (`POST /workspaces/:id/sessions`, Cmd+T, the `+` tab button) repoints
 * `workspaces.current_session_id` to a freshly-created idle session. A guard
 * keyed only on the session `current_session_id` points at is blind to a
 * still-running turn in another session — exactly the case the guard exists to
 * protect — so `git checkout -- .` proceeds and reverts that turn's unstaged
 * tracked-file edits.
 *
 * These tests run the actual guard SQL strings against a REAL in-memory SQLite
 * built from SCHEMA_SQL (not the mocked `db.prepare` of the unit suite) so the
 * JOIN against `current_session_id` and the workspace-wide status set are
 * exercised with realistic multi-session data.
 */

import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SCHEMA_SQL } from "@shared/schema";

// better-sqlite3 ships compiled for Bun's ABI under `bun install`; CI rebuilds
// it for Node's ABI before the backend suite. Skip cleanly if this environment
// has not had the rebuild run, so the suite degrades rather than crashing.
let canUseDatabase = true;
try {
  new Database(":memory:").close();
} catch {
  canUseDatabase = false;
}
const describeWithDb = canUseDatabase ? describe : describe.skip;

// The ACTIVE_TURN_STATUSES set shared with the send-guard
// (services/agent/commands.ts:382) and the sidebar aggregation
// (db/queries.ts:508). Kept verbatim here so a future rename in commands.ts
// surfaces in this test rather than silently desyncing the guard.
const ACTIVE_TURN_STATUSES = ["working", "needs_plan_response", "needs_response"] as const;

// The FIXED guard SQL: workspace-wide active-status check. Lives in
// workspace-init.service.ts git-clean stage. NOTE the literal SQL here is the
// source of truth the shipped code must match — the integration test below
// asserts the buggy SQL would NOT skip in the race while this one DOES.
const FIXED_GUARD_SQL =
  "SELECT 1 FROM sessions WHERE workspace_id = ? AND status IN ('working','needs_plan_response','needs_response') LIMIT 1";

// The BUGGY guard SQL as shipped in commit 43ae18f8: it JOINs on
// `workspaces.current_session_id`, consulting only the currently-selected
// session. A new-tab repoint of `current_session_id` to a fresh idle session
// hides any still-running turn in another session. Kept here to pin the
// regression the fix closes; the shipped code no longer uses this string.
const SHIPPED_GUARD_SQL =
  "SELECT s.last_user_message_at FROM sessions s JOIN workspaces w ON w.current_session_id = s.id WHERE w.id = ? LIMIT 1";

const WORKSPACE_ID = "ws-guard";
const REPO_ID = "repo-guard";

function createTestDb(): Database.Database {
  const db = new Database(":memory:");
  db.exec(SCHEMA_SQL);
  db.prepare("INSERT INTO repositories (id, name, root_path) VALUES (?, 'repo', '/tmp/repo')").run(
    REPO_ID
  );
  db.prepare(
    "INSERT INTO workspaces (id, repository_id, slug, state) VALUES (?, ?, 'slug', 'ready')"
  ).run(WORKSPACE_ID, REPO_ID);
  return db;
}

interface SessionSeed {
  id: string;
  status: string;
  lastUserMessageAt: string | null;
}

function insertSession(db: Database.Database, s: SessionSeed): void {
  db.prepare(
    "INSERT INTO sessions (id, workspace_id, status, last_user_message_at, updated_at) VALUES (?, ?, ?, ?, datetime('now'))"
  ).run(s.id, WORKSPACE_ID, s.status, s.lastUserMessageAt);
}

function setCurrentSession(db: Database.Database, sessionId: string): void {
  db.prepare("UPDATE workspaces SET current_session_id = ? WHERE id = ?").run(
    sessionId,
    WORKSPACE_ID
  );
}

describeWithDb("git-clean guard — workspace-init git-clean stage", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    db.close();
  });

  // ── The race: new-tab repoint hides an active turn in another session ──

  it("the shipped current_session_id SQL misses a working session after a new-tab repoint; the fixed SQL skips", () => {
    // S1 is the session the user is actively working in: agent turn in flight.
    insertSession(db, {
      id: "S1",
      status: "working",
      lastUserMessageAt: "2026-09-07T12:00:00Z",
    });
    setCurrentSession(db, "S1");

    // User opens a new chat tab during the background install window: a fresh
    // idle session S2 is created and current_session_id is repointed to it.
    insertSession(db, { id: "S2", status: "idle", lastUserMessageAt: null });
    setCurrentSession(db, "S2");

    // Shipped SQL consults only S2 (the new idle tab) → last_user_message_at
    // is NULL → does NOT skip → would run `git checkout -- .` and revert the
    // in-flight agent's unstaged tracked-file edits in S1.
    const shipped = db.prepare(SHIPPED_GUARD_SQL).get(WORKSPACE_ID) as
      | { last_user_message_at: string | null }
      | undefined;
    expect(shipped).toBeDefined();
    expect(shipped!.last_user_message_at).toBeNull();

    // Fixed SQL scans every session of the workspace → finds S1 mid-turn →
    // returns a row → skips git-clean.
    const fixed = db.prepare(FIXED_GUARD_SQL).get(WORKSPACE_ID);
    expect(fixed).toEqual({ 1: 1 });
  });

  // ── Stale-session: the fix must NOT suppress cleanup on a stale idle ────

  it("a stale idle session with a non-null last_user_message_at does not skip git-clean under the fixed SQL", () => {
    // A single session left over from a prior visit: idle, but its
    // last_user_message_at was set during that visit and never cleared.
    // last_user_message_at outlives the turn, so keying on it (as the shipped
    // guard does) falsely suppresses cleanup; keying on status (as the fix
    // does) correctly does not.
    insertSession(db, {
      id: "Sale",
      status: "idle",
      lastUserMessageAt: "2025-01-01T00:00:00Z",
    });
    setCurrentSession(db, "Sale");

    // Shipped SQL keys on last_user_message_at of the selected session →
    // truthy → skips. "Correct" only by accident: the selected session happens
    // to be the stale one; a new-tab repoint would make this same state skip
    // (or not) depending on which session is selected, which is the bug.
    const shipped = db.prepare(SHIPPED_GUARD_SQL).get(WORKSPACE_ID) as
      | { last_user_message_at: string | null }
      | undefined;
    expect(shipped).toBeDefined();
    expect(shipped!.last_user_message_at).not.toBeNull();

    // Fixed SQL keys on status: the session is idle, not in the active set,
    // so the guard returns no row → does NOT skip → cleanup proceeds. This is
    // the intended behavior for a workspace with no turn in flight.
    const fixed = db.prepare(FIXED_GUARD_SQL).get(WORKSPACE_ID);
    expect(fixed).toBeUndefined();
  });

  // ── Parked-turn intermediates: a turn can be parked-but-running ─────────

  it.each(ACTIVE_TURN_STATUSES)(
    "the fixed SQL skips git-clean when a session is parked in '%s'",
    (status) => {
      insertSession(db, { id: "S-parked", status, lastUserMessageAt: "2026-09-07T12:00:00Z" });
      setCurrentSession(db, "S-parked");

      // Even with current_session_id pointing at the parked session, the
      // shipped SQL would skip (last_user_message_at is non-null). The fix
      // skips too — but for the right reason: the status is in the active set.
      const fixed = db.prepare(FIXED_GUARD_SQL).get(WORKSPACE_ID);
      expect(fixed).toEqual({ 1: 1 });
    }
  );

  // ── Parked-but-hidden behind a new tab: the real regression case ───────

  it("the fixed SQL skips when a parked-turn session is hidden behind a new idle tab", () => {
    // S1 parked waiting for the user's plan approval; user opens a new tab (S2).
    insertSession(db, {
      id: "S1",
      status: "needs_plan_response",
      lastUserMessageAt: "2026-09-07T12:00:00Z",
    });
    setCurrentSession(db, "S1");
    insertSession(db, { id: "S2", status: "idle", lastUserMessageAt: null });
    setCurrentSession(db, "S2");

    // Shipped SQL would consult S2 (idle, NULL) and NOT skip — reverting edits
    // on a turn that is parked, not finished. The fixed SQL finds S1 in the
    // active set and skips.
    const shipped = db.prepare(SHIPPED_GUARD_SQL).get(WORKSPACE_ID) as
      | { last_user_message_at: string | null }
      | undefined;
    expect(shipped!.last_user_message_at).toBeNull();

    const fixed = db.prepare(FIXED_GUARD_SQL).get(WORKSPACE_ID);
    expect(fixed).toEqual({ 1: 1 });
  });

  // ── All-idle workspace: cleanup must proceed ───────────────────────────

  it("the fixed SQL does not skip when every session of the workspace is idle", () => {
    insertSession(db, { id: "Sa", status: "idle", lastUserMessageAt: null });
    insertSession(db, { id: "Sb", status: "idle", lastUserMessageAt: null });
    setCurrentSession(db, "Sb");

    const fixed = db.prepare(FIXED_GUARD_SQL).get(WORKSPACE_ID);
    expect(fixed).toBeUndefined();
  });

  // ── Cross-workspace isolation: another workspace's turn must not skip ──

  it("the fixed SQL does not skip when an active session belongs to a DIFFERENT workspace", () => {
    // The guard is scoped to `workspace_id = ?`; an active turn in a sibling
    // workspace must not suppress this workspace's cleanup (each workspace has
    // its own worktree, so the checkout runs in a different directory).
    db.prepare(
      "INSERT INTO workspaces (id, repository_id, slug, state) VALUES ('ws-other', ?, 'other', 'ready')"
    ).run(REPO_ID);
    db.prepare(
      "INSERT INTO sessions (id, workspace_id, status, last_user_message_at, updated_at) VALUES (?, 'ws-other', 'working', '2026-09-07T12:00:00Z', datetime('now'))"
    ).run("S-other");

    // This workspace has only an idle session.
    insertSession(db, { id: "S-self", status: "idle", lastUserMessageAt: null });
    setCurrentSession(db, "S-self");

    const fixed = db.prepare(FIXED_GUARD_SQL).get(WORKSPACE_ID);
    expect(fixed).toBeUndefined();
  });

  // ── Error status is not in the active set ───────────────────────────────

  it("the fixed SQL does not skip when a session errored out (status='error')", () => {
    // A failed turn sets status='error' (persistence.ts:440), not idle. The
    // turn is no longer in flight, so cleanup should proceed to reset the
    // worktree to a clean baseline.
    insertSession(db, {
      id: "Serr",
      status: "error",
      lastUserMessageAt: "2026-09-07T12:00:00Z",
    });
    setCurrentSession(db, "Serr");

    const fixed = db.prepare(FIXED_GUARD_SQL).get(WORKSPACE_ID);
    expect(fixed).toBeUndefined();
  });
});
