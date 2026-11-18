import { describe, expect, it } from "vitest";
import { PermissionModeSchema } from "@zvada/agent-server/protocol";
import { buildTurnStartParams } from "../../../src/services/agent/run-config";

const harnesses = ["claude-code", "codex-sdk", "codex-app-server"] as const;

describe.each(harnesses)("%s local permission policy", (harness) => {
  it.each([undefined, "native-session"])(
    "uses full access when the composer omits the mode (resume: %s)",
    (resume) => {
      const params = buildTurnStartParams("session", "turn", harness, "Update the app", {
        cwd: "/workspace",
        resume,
      });

      // Leaving this undefined starts Codex read-only with an approval broker
      // that the desktop does not render, so the first write parks the turn.
      expect(params.config.permissionMode).toBe("bypass_permissions");
      expect(params.config.resumeSessionId).toBe(resume);
    }
  );

  it.each(PermissionModeSchema.options)("preserves an explicit %s mode", (permissionMode) => {
    const params = buildTurnStartParams("session", "turn", harness, "Inspect the app", {
      cwd: "/workspace",
      permissionMode,
    });

    expect(params.config.permissionMode).toBe(permissionMode);
  });
});

describe.each(harnesses)("%s and the Simulator tab", (harness) => {
  it("names the tab's device to the agent, and nothing without one", () => {
    const simulator = { udid: "5E4E0C2F-7025-4AAE-86D4-75A9BCD7AF06" };
    const shown = buildTurnStartParams("session", "turn", harness, "Check it", {
      cwd: "/workspace",
      simulator,
    });
    expect(shown.config.systemPromptAppend).toContain(`--udid ${simulator.udid}`);
    // Only Claude has the recording tools, so only Claude is told how to record that device.
    expect(shown.config.systemPromptAppend?.includes(`destination "${simulator.udid}"`)).toBe(
      harness === "claude-code"
    );
    const none = buildTurnStartParams("session", "turn", harness, "Check it", {
      cwd: "/workspace",
    });
    expect(none.config.systemPromptAppend).not.toContain("--udid");
  });
});
