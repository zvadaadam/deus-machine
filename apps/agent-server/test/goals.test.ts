import { describe, expect, it } from "vitest";
import { buildGoalSystemPrompt } from "../goals/prompt";
import { createUpdateGoalDynamicToolSpec } from "../goals/tool";

describe("agent-server goals", () => {
  it("builds a model-visible goal prompt with remaining budget", () => {
    const prompt = buildGoalSystemPrompt({
      objective: "Refactor auth",
      tokenBudget: 1_000,
      spentTokens: 250,
      startedAt: 1,
    });

    expect(prompt).toContain("Refactor auth");
    expect(prompt).toContain("Tokens remaining: 750");
    expect(prompt).toContain("update_goal");
  });

  it("limits the dynamic update_goal tool status to complete", () => {
    const spec = createUpdateGoalDynamicToolSpec();
    expect(spec.name).toBe("update_goal");
    expect(spec.inputSchema).toMatchObject({
      required: ["status"],
      properties: {
        status: {
          enum: ["complete"],
        },
      },
    });
  });
});
