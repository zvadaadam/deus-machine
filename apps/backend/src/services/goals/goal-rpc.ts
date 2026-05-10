// backend/src/services/goals/goal-rpc.ts
// Backend-owned handler for model calls to update_goal.

import { GoalUpdateRequestSchema } from "@shared/goals";
import { completeGoal } from "./goal-store";
import { pushGoalEnded } from "./goal-events";
import { invalidate } from "../query-engine";

export async function handleGoalUpdate(params: unknown): Promise<unknown> {
  const request = GoalUpdateRequestSchema.parse(params);
  const ended = completeGoal(request.sessionId, request.summary);
  if (!ended) {
    return { ok: false, message: "No active goal for this session." };
  }

  pushGoalEnded(ended);
  invalidate(["goal"], { sessionIds: [request.sessionId] });
  return {
    ok: true,
    goal: ended,
    message: "Goal completion recorded.",
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
