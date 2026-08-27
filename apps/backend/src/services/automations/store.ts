// backend/src/services/automations/store.ts
// SQL for the automations cache. The agnt platform owns the truth; these
// tables exist so the WS query layer stays synchronous and the UI renders
// instantly. Sync logic lives in service.ts; this file owns rows.

import { uuidv7 } from "@shared/lib/uuid";
import { getDatabase } from "../../lib/database";
import type { AutomationRow, AutomationRunRow, AutomationWithDetailsRow } from "../../db/types";

// ─── automations ─────────────────────────────────────────────

export function getAutomationRaw(id: string): AutomationRow | undefined {
  return getDatabase().prepare("SELECT * FROM automations WHERE id = ?").get(id) as
    | AutomationRow
    | undefined;
}

const DETAILS_SELECT_SQL = `
  SELECT a.*, r.name AS repo_name,
         (SELECT lr.status FROM automation_runs lr
           WHERE lr.automation_id = a.id ORDER BY lr.id DESC LIMIT 1) AS last_run_status
    FROM automations a
    LEFT JOIN repositories r ON r.id = a.repository_id`;

export function listAutomationsWithDetails(): AutomationWithDetailsRow[] {
  return getDatabase()
    .prepare(`${DETAILS_SELECT_SQL} ORDER BY a.id DESC`)
    .all() as AutomationWithDetailsRow[];
}

export function getAutomationWithDetails(id: string): AutomationWithDetailsRow | undefined {
  return getDatabase().prepare(`${DETAILS_SELECT_SQL} WHERE a.id = ?`).get(id) as
    | AutomationWithDetailsRow
    | undefined;
}

const UPSERT_AUTOMATION_SQL = `
  INSERT INTO automations (
    id, name, prompt, cron, timezone, environment, repository_id, status,
    paused_reason, session_policy, model, next_run_at, last_run_at,
    consecutive_failures, created_by, workspace_id, synced_at, updated_at
  ) VALUES (
    @id, @name, @prompt, @cron, @timezone, @environment, @repository_id, @status,
    @paused_reason, @session_policy, @model, @next_run_at, @last_run_at,
    @consecutive_failures, @created_by, @workspace_id, @synced_at, @updated_at
  )
  ON CONFLICT(id) DO UPDATE SET
    name = excluded.name, prompt = excluded.prompt, cron = excluded.cron,
    timezone = excluded.timezone, environment = excluded.environment,
    repository_id = excluded.repository_id, status = excluded.status,
    paused_reason = excluded.paused_reason, session_policy = excluded.session_policy,
    model = excluded.model, next_run_at = excluded.next_run_at,
    last_run_at = excluded.last_run_at,
    consecutive_failures = excluded.consecutive_failures,
    synced_at = excluded.synced_at, updated_at = excluded.updated_at`;

export function upsertAutomation(row: Omit<AutomationRow, "synced_at">): void {
  getDatabase()
    .prepare(UPSERT_AUTOMATION_SQL)
    .run({ ...row, synced_at: new Date().toISOString() });
}

/**
 * Mirror the platform's full list: upsert every row, drop cache rows the
 * platform no longer has (deleted elsewhere — another device, the SDK).
 * The deus-local columns (created_by, adopted workspace_id) survive upserts
 * by exclusion from the UPDATE set above.
 */
export function replaceAutomationsCache(rows: Array<Omit<AutomationRow, "synced_at">>): void {
  const db = getDatabase();
  const replace = db.transaction(() => {
    const keep = rows.map((r) => r.id);
    if (keep.length === 0) {
      db.prepare("DELETE FROM automations").run();
    } else {
      db.prepare(`DELETE FROM automations WHERE id NOT IN (${keep.map(() => "?").join(", ")})`).run(
        ...keep
      );
    }
    const synced_at = new Date().toISOString();
    const upsert = db.prepare(UPSERT_AUTOMATION_SQL);
    for (const row of rows) upsert.run({ ...row, synced_at });
  });
  replace();
}

/** The deus-local columns the platform doesn't know about. */
export function updateLocalColumns(
  id: string,
  patch: { created_by?: string; workspace_id?: string | null }
): void {
  const sets: string[] = [];
  const values: unknown[] = [];
  if (patch.created_by !== undefined) {
    sets.push("created_by = ?");
    values.push(patch.created_by);
  }
  if (patch.workspace_id !== undefined) {
    sets.push("workspace_id = ?");
    values.push(patch.workspace_id);
  }
  if (sets.length === 0) return;
  getDatabase()
    .prepare(`UPDATE automations SET ${sets.join(", ")} WHERE id = ?`)
    .run(...values, id);
}

export function deleteAutomationRow(id: string): void {
  getDatabase().prepare("DELETE FROM automations WHERE id = ?").run(id);
}

/** Cached platform last-run stamp per automation, read before a cache
 *  replace — the refresh uses it to spot automations whose run ledger went
 *  stale while the detail view was closed. */
export function lastRunAtById(): Map<string, string | null> {
  const rows = getDatabase().prepare("SELECT id, last_run_at FROM automations").all() as Array<
    Pick<AutomationRow, "id" | "last_run_at">
  >;
  return new Map(rows.map((r) => [r.id, r.last_run_at]));
}

/** created_by / adopted-workspace map, read before a cache replace. */
export function localColumnsById(): Map<
  string,
  Pick<AutomationRow, "created_by" | "workspace_id">
> {
  const rows = getDatabase()
    .prepare("SELECT id, created_by, workspace_id FROM automations")
    .all() as Array<Pick<AutomationRow, "id" | "created_by" | "workspace_id">>;
  return new Map(
    rows.map((r) => [r.id, { created_by: r.created_by, workspace_id: r.workspace_id }])
  );
}

// ─── automation_runs ─────────────────────────────────────────

export function listRuns(automationId: string, limit = 50): AutomationRunRow[] {
  return getDatabase()
    .prepare(`SELECT * FROM automation_runs WHERE automation_id = ? ORDER BY id DESC LIMIT ?`)
    .all(automationId, limit) as AutomationRunRow[];
}

export function getRun(runId: string): AutomationRunRow | undefined {
  return getDatabase().prepare("SELECT * FROM automation_runs WHERE id = ?").get(runId) as
    | AutomationRunRow
    | undefined;
}

/** Upsert ledger rows; adopted deus ids survive (excluded from the UPDATE). */
export function upsertRuns(rows: AutomationRunRow[]): void {
  if (rows.length === 0) return;
  const db = getDatabase();
  const upsert = db.prepare(
    `INSERT INTO automation_runs (
       id, automation_id, status, trigger, provider_session_id, session_id,
       workspace_id, scheduled_at, started_at, completed_at, stop_reason,
       error_message, cost, summary
     ) VALUES (
       @id, @automation_id, @status, @trigger, @provider_session_id, @session_id,
       @workspace_id, @scheduled_at, @started_at, @completed_at, @stop_reason,
       @error_message, @cost, @summary
     )
     ON CONFLICT(id) DO UPDATE SET
       status = excluded.status, trigger = excluded.trigger,
       provider_session_id = excluded.provider_session_id,
       scheduled_at = excluded.scheduled_at, started_at = excluded.started_at,
       completed_at = excluded.completed_at, stop_reason = excluded.stop_reason,
       error_message = excluded.error_message, cost = excluded.cost,
       summary = excluded.summary`
  );
  const apply = db.transaction(() => {
    for (const row of rows) upsert.run(row);
  });
  apply();
}

// ─── Run adoption (find-or-create the deus rows for a platform run) ──

/** True when an adopted deus session row still exists. */
export function sessionExists(sessionId: string): boolean {
  return getDatabase().prepare("SELECT 1 FROM sessions WHERE id = ?").get(sessionId) !== undefined;
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
          `INSERT INTO workspaces (id, repository_id, slug, title, state, kind, provider_workspace_id)
           VALUES (?, ?, ?, ?, 'ready', 'cloud', ?)`
        ).run(
          workspaceId,
          input.repositoryId,
          input.newWorkspaceSlug(),
          input.automationName,
          input.providerWorkspaceId
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
      "UPDATE workspaces SET current_session_id = ?, updated_at = datetime('now') WHERE id = ?"
    ).run(session.id, workspaceId);
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

// ─── Transcript backfill (adopted runs) ──────────────────────

interface PlatformPartLike {
  id?: unknown;
  type?: unknown;
  toolCallId?: unknown;
  tool?: unknown;
  parentToolCallId?: unknown;
}

interface PlatformMessageLike {
  id?: unknown;
  turnId?: unknown;
  role?: unknown;
  messageIndex?: unknown;
  parentToolCallId?: unknown;
  parts?: unknown;
}

/**
 * Persist a platform session transcript into deus's messages/parts tables.
 * The platform stores the ENGINE vocabulary — each part row is the engine
 * Part verbatim, exactly what deus's own persistence writes — so this is a
 * row copy, not a translation. INSERT OR IGNORE keeps it idempotent against
 * rows the live channel already folded; the per-session seq trigger assigns
 * order from insertion order (messages sorted by messageIndex first).
 * Returns the number of message rows inserted.
 */
export function backfillSessionTranscript(
  deusSessionId: string,
  messages: Array<Record<string, unknown>>
): number {
  const db = getDatabase();
  const insertMessage = db.prepare(
    `INSERT OR IGNORE INTO messages (id, session_id, role, turn_id, parent_tool_call_id)
     VALUES (?, ?, ?, ?, ?)`
  );
  const insertPart = db.prepare(
    `INSERT OR IGNORE INTO parts (
       id, message_id, session_id, type, data, tool_call_id, tool_name, parent_tool_call_id
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  );

  const ordered = [...(messages as PlatformMessageLike[])].sort(
    (a, b) => (Number(a.messageIndex) || 0) - (Number(b.messageIndex) || 0)
  );

  let inserted = 0;
  const apply = db.transaction(() => {
    for (const message of ordered) {
      if (typeof message.id !== "string" || typeof message.role !== "string") continue;
      const result = insertMessage.run(
        message.id,
        deusSessionId,
        message.role,
        typeof message.turnId === "string" ? message.turnId : null,
        // Subagent messages carry their spawning tool call — dropping it
        // would surface them as unrelated top-level messages in the timeline.
        typeof message.parentToolCallId === "string" ? message.parentToolCallId : null
      );
      if (result.changes > 0) inserted++;
      const parts = Array.isArray(message.parts) ? (message.parts as PlatformPartLike[]) : [];
      for (const part of parts) {
        if (typeof part.id !== "string" || typeof part.type !== "string") continue;
        insertPart.run(
          part.id,
          message.id,
          deusSessionId,
          part.type,
          JSON.stringify(part),
          typeof part.toolCallId === "string" ? part.toolCallId : null,
          typeof part.tool === "string" ? part.tool : null,
          typeof part.parentToolCallId === "string" ? part.parentToolCallId : null
        );
      }
    }
  });
  apply();
  return inserted;
}
