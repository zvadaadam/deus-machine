import { describe, expect, it } from "vitest";
import { goalContextFromGoal, tokenCountForUsage } from "@shared/goal-decision";
import type { ActiveGoal } from "@shared/goals";

const baseGoal: ActiveGoal = {
  sessionId: "sess-1",
  goalId: "goal-1",
  objective: "Refactor auth",
  status: "active",
  tokenBudget: 1_000,
  spentTokens: 100,
  timeUsedSeconds: 0,
  createdAt: 10,
  updatedAt: 10,
};

describe("goal-decision", () => {
  it("counts all token usage buckets used by agent events", () => {
    expect(
      tokenCountForUsage({
        input: 100,
        output: 50,
        reasoning: 25,
        cacheRead: 10,
        cacheCreation: { total: 5 },
      })
    ).toBe(190);
  });

  it("builds the provider-neutral goal context used by Codex app-server", () => {
    expect(goalContextFromGoal(baseGoal)).toEqual({
      objective: "Refactor auth",
      tokenBudget: 1_000,
      spentTokens: 100,
      startedAt: 10,
    });
  });
});
