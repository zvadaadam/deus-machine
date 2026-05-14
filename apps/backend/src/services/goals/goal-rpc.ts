// backend/src/services/goals/goal-rpc.ts
// Backend-owned handler for native provider goal terminal-state notifications.

import { GoalUpdateRequestSchema } from "@shared/goals";
import { budgetLimitGoalFromProvider, completeGoal } from "./goal-store";
import { pushGoalEnded } from "./goal-events";
import { invalidate } from "../query-engine";

export async function handleGoalUpdate(params: unknown): Promise<unknown> {
  const request = GoalUpdateRequestSchema.parse(params);
  const options =
    request.spentTokens === undefined ? undefined : { spentTokens: request.spentTokens };
  const ended =
    request.status === "complete"
      ? completeGoal(request.sessionId, request.summary, options)
      : budgetLimitGoalFromProvider(request.sessionId, options);
  if (!ended) {
    return { ok: false, message: "No active goal for this session." };
  }

  pushGoalEnded(ended);
  invalidate(["goal"], { sessionIds: [request.sessionId] });
  return {
    ok: true,
    goal: ended,
    message:
      request.status === "complete" ? "Goal completion recorded." : "Goal budget limit recorded.",
    completionBudgetReport:
      ended.tokenBudget === null
        ? null
        : {
            tokenBudget: ended.tokenBudget,
            tokensUsed: ended.spentTokens,
            tokensRemaining: Math.max(0, ended.tokenBudget - ended.spentTokens),
          },
  };
}
