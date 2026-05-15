// agent-server/agents/codex-server/codex-server-goals.ts
// Thin bridge between Deus's persisted goal mirror and Codex app-server's
// native thread goal API.

import { EventBroadcaster } from "../../event-broadcaster";
import type { QueryOptions } from "../registry";
import type { CodexServerSessionState } from "./codex-server-session";
import type { CodexThreadGoal } from "./codex-server-types";

export function nativeGoalOwnsTurn(options: QueryOptions): boolean {
  return (
    !!options.goalContext && (options.goalAction === "start" || options.goalAction === "continue")
  );
}

export function isTerminalGoalStatus(status: CodexThreadGoal["status"] | undefined): boolean {
  return status === "paused" || status === "budgetLimited" || status === "complete";
}

export async function clearNativeGoal(session: CodexServerSessionState): Promise<void> {
  if (!session.appServer || !session.threadId) return;

  try {
    await session.appServer.request("thread/goal/clear", { threadId: session.threadId });
    session.nativeGoalKnown = false;
  } catch (error) {
    console.warn("[codex-server] Failed to clear Codex app-server goal:", error);
  }
}

export async function ensureNativeGoal(
  session: CodexServerSessionState,
  options: QueryOptions
): Promise<CodexThreadGoal | null> {
  if (!options.goalContext || !session.appServer || !session.threadId) return null;

  const shouldSetGoal =
    options.goalAction === "start" || options.goalAction === "continue" || !session.nativeGoalKnown;

  if (!shouldSetGoal) {
    return null;
  }

  if (options.goalAction !== "start" && options.goalAction !== "continue") {
    const current = await session.appServer.request("thread/goal/get", {
      threadId: session.threadId,
    });
    session.nativeGoalKnown = true;
    if (current.goal) return current.goal;
  }

  const response = await session.appServer.request("thread/goal/set", {
    threadId: session.threadId,
    objective: options.goalContext.objective,
    status: "active",
    tokenBudget: options.goalContext.tokenBudget,
  });
  session.nativeGoalKnown = true;
  return response.goal;
}

export async function syncNativeGoalUpdate(
  sessionId: string,
  goal: CodexThreadGoal
): Promise<void> {
  try {
    if (goal.status === "paused" || goal.status === "complete" || goal.status === "budgetLimited") {
      await EventBroadcaster.requestUpdateGoal({
        sessionId,
        status:
          goal.status === "paused"
            ? "paused"
            : goal.status === "complete"
              ? "complete"
              : "budget_limited",
        ...(goal.status === "complete"
          ? { summary: "Codex marked the native goal complete." }
          : {}),
        spentTokens: goal.tokensUsed,
      });
    }
  } catch (error) {
    console.warn("[codex-server] Failed to sync native goal update:", error);
  }
}
