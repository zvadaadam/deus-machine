import { describe, expect, it } from "vitest";
import { lookupAgentLogo } from "@/assets/agents/lookup";

describe("lookupAgentLogo", () => {
  const logos = {
    claude: "claude-logo",
    "codex-server": "codex-logo",
  };

  it("matches harness names case-insensitively", () => {
    expect(lookupAgentLogo(logos, "Claude")).toBe("claude-logo");
    expect(lookupAgentLogo(logos, "CODEX-SERVER")).toBe("codex-logo");
  });

  it("returns undefined for missing or unknown harness values", () => {
    expect(lookupAgentLogo(logos, undefined)).toBeUndefined();
    expect(lookupAgentLogo(logos, null)).toBeUndefined();
    expect(lookupAgentLogo(logos, "unknown")).toBeUndefined();
  });
});
