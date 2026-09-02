import { describe, it, expect } from "vitest";
import { getDefaultModelForHarness, getAgentHarnessForModel, DEFAULT_MODEL } from "@/shared/agents";

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
