// backend/src/services/goals/goal-store.ts
// SQLite-backed goal state. One row per session; starting a new goal replaces
// the previous row, while chat history remains the durable audit trail.

import { uuidv7 } from "@shared/lib/uuid";
import { goalContextFromGoal } from "@shared/goal-decision";
import type { ActiveGoal, EndedGoal, GoalContext, GoalEndReason, GoalStatus } from "@shared/goals";
import type { QueryOptions } from "@shared/protocol";
import { getDatabase } from "../../lib/database";

const TERMINAL_LINGER_SECONDS = 3;

export interface StoredGoal extends ActiveGoal {
  model: string;
  thinkingLevel?: QueryOptions["thinkingLevel"];
}

interface GoalRow {
  session_id: string;
  goal_id: string;
  objective: string;
  status: GoalStatus;
  token_budget: number | null;
  spent_tokens: number;
  model: string;
  thinking_level: QueryOptions["thinkingLevel"] | null;
  created_at: string;
  updated_at: string;
}

export function createGoal(params: {
  sessionId: string;
  objective: string;
  tokenBudget: number | null;
  model: string;
  thinkingLevel?: QueryOptions["thinkingLevel"];
  now?: number;
}): StoredGoal {
  const db = getDatabase();
  const goalId = uuidv7();
  const createdAt = params.now ? secondsToSqlDate(params.now) : null;

  db.prepare(
    `
      INSERT INTO goals (
        session_id, goal_id, objective, status, token_budget, spent_tokens,
        model, thinking_level, created_at, updated_at
      )
      VALUES (?, ?, ?, 'active', ?, 0, ?, ?, COALESCE(?, datetime('now')), COALESCE(?, datetime('now')))
      ON CONFLICT(session_id) DO UPDATE SET
        goal_id = excluded.goal_id,
        objective = excluded.objective,
        status = 'active',
        token_budget = excluded.token_budget,
        spent_tokens = 0,
        model = excluded.model,
        thinking_level = excluded.thinking_level,
        created_at = excluded.created_at,
        updated_at = excluded.updated_at
    `
  ).run(
    params.sessionId,
    goalId,
    params.objective,
    params.tokenBudget,
    params.model,
    params.thinkingLevel ?? null,
    createdAt,
    createdAt
  );

  const goal = getGoal(params.sessionId);
  if (!goal) throw new Error("Failed to create goal");
  return goal;
}

export function getGoal(sessionId: string): StoredGoal | undefined {
  const row = getDatabase().prepare("SELECT * FROM goals WHERE session_id = ?").get(sessionId) as
    | GoalRow
    | undefined;
  return row ? rowToGoal(row) : undefined;
}

export function getActiveGoal(sessionId: string): ActiveGoal | null {
  const goal = getGoal(sessionId);
  if (!goal) return null;
  if (isStaleTerminalGoal(goal)) return null;
  return toActiveGoal(goal);
}

export function getRunnableGoal(sessionId: string): StoredGoal | undefined {
  const goal = getGoal(sessionId);
  return goal?.status === "active" ? goal : undefined;
}

export function saveGoalProgress(sessionId: string, goal: ActiveGoal): StoredGoal | null {
  const existing = getGoal(sessionId);
  if (!existing || existing.status !== "active") return null;

  getDatabase()
    .prepare(
      `
        UPDATE goals
        SET spent_tokens = ?, status = ?, updated_at = datetime('now')
        WHERE session_id = ? AND status = 'active'
      `
    )
    .run(goal.spentTokens, goal.status, sessionId);

  return getGoal(sessionId) ?? null;
}

export function pauseAllActiveGoals(): number {
  const result = getDatabase()
    .prepare(
      "UPDATE goals SET status = 'paused', updated_at = datetime('now') WHERE status = 'active'"
    )
    .run();
  return result.changes;
}

export function resumeGoal(sessionId: string): StoredGoal | null {
  const result = getDatabase()
    .prepare(
      "UPDATE goals SET status = 'active', updated_at = datetime('now') WHERE session_id = ? AND status = 'paused'"
    )
    .run(sessionId);
  if (result.changes === 0) return null;
  return getGoal(sessionId) ?? null;
}

export function completeGoal(
  sessionId: string,
  summary?: string,
  options?: { spentTokens?: number }
): EndedGoal | null {
  return markTerminalGoal(sessionId, "complete", summary, options);
}

export function budgetLimitGoal(sessionId: string, goal: ActiveGoal): EndedGoal | null {
  return markTerminalGoal(sessionId, "budget_limited", undefined, {
    spentTokens: goal.spentTokens,
  });
}

export function budgetLimitGoalFromProvider(
  sessionId: string,
  options?: { spentTokens?: number }
): EndedGoal | null {
  return markTerminalGoal(sessionId, "budget_limited", undefined, options);
}

export function deleteGoal(
  sessionId: string,
  reason: GoalEndReason = "cancelled"
): EndedGoal | null {
  const goal = getGoal(sessionId);
  if (!goal) return null;
  getDatabase().prepare("DELETE FROM goals WHERE session_id = ?").run(sessionId);
  return { ...toActiveGoal(goal), reason };
}

export function goalContextForSession(sessionId: string): GoalContext | undefined {
  const goal = getRunnableGoal(sessionId);
  return goal ? goalContextFromGoal(goal) : undefined;
}

export function clearGoalsForTest(): void {
  getDatabase().prepare("DELETE FROM goals").run();
}

export function toActiveGoal(goal: StoredGoal): ActiveGoal {
  const createdAt = goal.createdAt;
  return {
    sessionId: goal.sessionId,
    goalId: goal.goalId,
    objective: goal.objective,
    status: goal.status,
    tokenBudget: goal.tokenBudget,
    spentTokens: goal.spentTokens,
    timeUsedSeconds: Math.max(0, nowSeconds() - createdAt),
    createdAt,
    updatedAt: goal.updatedAt,
  };
}

function markTerminalGoal(
  sessionId: string,
  reason: Extract<GoalEndReason, "complete" | "budget_limited">,
  summary?: string,
  options?: { spentTokens?: number }
): EndedGoal | null {
  const goal = getGoal(sessionId);
  if (!goal || goal.status === "complete" || goal.status === "budget_limited") return null;
  const spentTokens =
    typeof options?.spentTokens === "number" && Number.isFinite(options.spentTokens)
      ? Math.max(0, Math.floor(options.spentTokens))
      : null;

  getDatabase()
    .prepare(
      `
        UPDATE goals
        SET
          status = ?,
          spent_tokens = MAX(spent_tokens, COALESCE(?, spent_tokens)),
          updated_at = datetime('now')
        WHERE session_id = ?
      `
    )
    .run(reason, spentTokens, sessionId);

  const updated = getGoal(sessionId);
  return updated ? { ...toActiveGoal(updated), reason, ...(summary ? { summary } : {}) } : null;
}

function rowToGoal(row: GoalRow): StoredGoal {
  return {
    sessionId: row.session_id,
    goalId: row.goal_id,
    objective: row.objective,
    status: row.status,
    tokenBudget: row.token_budget,
    spentTokens: row.spent_tokens,
    timeUsedSeconds: 0,
    createdAt: sqlDateToSeconds(row.created_at),
    updatedAt: sqlDateToSeconds(row.updated_at),
    model: row.model,
    thinkingLevel: row.thinking_level ?? undefined,
  };
}

function isStaleTerminalGoal(goal: StoredGoal): boolean {
  if (goal.status !== "complete" && goal.status !== "budget_limited") return false;
  return nowSeconds() - goal.updatedAt > TERMINAL_LINGER_SECONDS;
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function secondsToSqlDate(seconds: number): string {
  return new Date(seconds * 1000).toISOString();
}

function sqlDateToSeconds(value: string): number {
  const normalized = value.includes("T") ? value : `${value.replace(" ", "T")}Z`;
  const ms = Date.parse(normalized);
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : nowSeconds();
}
