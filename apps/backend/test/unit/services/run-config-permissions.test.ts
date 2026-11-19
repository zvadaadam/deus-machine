import { describe, expect, it } from "vitest";
import { PermissionModeSchema } from "@zvada/agent-server/protocol";
import { buildTurnStartParams } from "../../../src/services/agent/run-config";

const harnesses = ["claude-code", "codex-app-server"] as const;

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
    const none = buildTurnStartParams("session", "turn", harness, "Check it", {
      cwd: "/workspace",
    });
    expect(none.config.systemPromptAppend).not.toContain("--udid");
  });
});

describe.each(harnesses)("%s and agent-device", (harness) => {
  it("briefs the agent on the bundled CLI and runs it in the workspace's session", () => {
    const params = buildTurnStartParams("chat-1", "turn", harness, "Open Settings", {
      cwd: "/workspace",
      agentDeviceSession: "workspace-1",
      env: { CODEX_HOME: "/homes/chat-1" },
    });
    expect(params.config.systemPromptAppend).toContain("`agent-device open <app or bundle id>");
    // Every harness has the Deus tools, so every one is briefed on them.
    expect(params.config.systemPromptAppend).toContain("# Screen Recording");
    // Every chat of the workspace shares it, and a simulator recording joins it.
    expect(params.config.env).toEqual({
      AGENT_DEVICE_SESSION: "workspace-1",
      CODEX_HOME: "/homes/chat-1",
    });
  });
});
