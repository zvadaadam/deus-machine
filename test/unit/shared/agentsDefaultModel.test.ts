import { describe, it, expect } from "vitest";
import {
  getDefaultModelForHarness,
  getModelForSession,
  getAgentHarnessForModel,
  DEFAULT_MODEL,
} from "@/shared/agents";
import type { SessionTurn } from "@shared/types/session";

describe("getDefaultModelForHarness (the composer seed for a reopened session)", () => {
  it("round-trips through the harness the send path derives from the model", () => {
    for (const harness of ["claude-code", "codex-app-server"] as const) {
      const model = getDefaultModelForHarness(harness);
      expect(model.startsWith(`${harness}:`)).toBe(true);
      expect(getAgentHarnessForModel(model)).toBe(harness);
    }
    // `codex-sdk` is a retired picker spelling: the catalog migrates its value
    // to the codex-app-server engine, which is what a cloud send must carry.
    expect(getAgentHarnessForModel(getDefaultModelForHarness("codex-sdk"))).toBe(
      "codex-app-server"
    );
  });

  it("agrees with the global default for the default harness", () => {
    expect(getDefaultModelForHarness("claude-code")).toBe(DEFAULT_MODEL);
  });
});

describe("reopened conversation model", () => {
  const turn = (startedAt: number, model: string): SessionTurn => ({
    turnId: String(startedAt),
    startedAt,
    execution: { harness: "codex-app-server", model },
  });

  it("uses the latest recorded choice even when history arrives out of order", () => {
    expect(
      getModelForSession("codex-app-server", [turn(2, "gpt-5.6-sol"), turn(1, "gpt-6-astra")])
    ).toBe("codex-app-server:gpt-5.6-sol");
  });

  it("uses the session harness default when no usable selection was recorded", () => {
    for (const turns of [[], [turn(1, "retired-model")]]) {
      expect(getModelForSession("codex-app-server", turns)).toBe(
        getDefaultModelForHarness("codex-app-server")
      );
    }
    expect(getModelForSession("claude-code", [turn(1, "gpt-5.6-sol")])).toBe(DEFAULT_MODEL);
  });
});
