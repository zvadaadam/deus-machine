import { describe, expect, it } from "vitest";
import { decideAfterTurn, tokenCountForUsage } from "@shared/goal-decision";
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
  allowQuestions: true,
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

  it("continues when the token budget remains", () => {
    const decision = decideAfterTurn(baseGoal, {
      now: 20,
      tokens: { input: 200, output: 100 },
    });

    expect(decision.kind).toBe("continue");
    expect(decision.goal.spentTokens).toBe(400);
    expect(decision.goal.timeUsedSeconds).toBe(10);
    expect(decision.prompt).toContain("Continue working toward the active thread goal");
  });

  it("finalizes when the token budget is reached", () => {
    const decision = decideAfterTurn(baseGoal, {
      now: 20,
      tokens: { input: 800, output: 100 },
    });

    expect(decision.kind).toBe("finalize");
    if (decision.kind === "finalize") {
      expect(decision.reason).toBe("budget_limited");
      expect(decision.goal.spentTokens).toBe(1_000);
      expect(decision.prompt).toContain("has reached its token budget");
    }
  });
});
