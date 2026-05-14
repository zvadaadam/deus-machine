// shared/goal-decision.ts
// Small provider-neutral helpers for mirroring native goal state in Deus UI.

import type { ActiveGoal, GoalContext } from "./goals";
import type { TokenUsage } from "./messages";

export function tokenCountForUsage(tokens: TokenUsage | undefined): number {
  if (!tokens) return 0;
  return (
    tokens.input +
    tokens.output +
    (tokens.reasoning ?? 0) +
    (tokens.cacheRead ?? 0) +
    (tokens.cacheCreation?.total ?? 0)
  );
}

export function goalContextFromGoal(goal: ActiveGoal): GoalContext {
  return {
    objective: goal.objective,
    tokenBudget: goal.tokenBudget,
    spentTokens: goal.spentTokens,
    startedAt: goal.createdAt,
  };
}
