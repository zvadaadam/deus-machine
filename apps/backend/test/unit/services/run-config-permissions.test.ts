import { describe, expect, it } from "vitest";
import { PermissionModeSchema } from "@zvada/agent-server/protocol";
import { LOCAL_HARNESSES } from "@shared/harnesses";
import { buildTurnStartParams } from "../../../src/services/agent/run-config";

const workspace = { cwd: "/workspace", agentMessages: false };

it.each(LOCAL_HARNESSES)(
  "briefs %s on renaming its own chat and workspace and reading chat links",
  (harness) => {
    const { config } = buildTurnStartParams("chat", "turn", harness, "Read this chat", workspace);
    expect(config.systemPromptAppend).toContain(
      "Once the task is clear, use `rename` to give your chat and its workspace a short title (3–6 words) that names the outcome. Rename again only if the task changes."
    );
    expect(config.systemPromptAppend).toContain(
      "For this computer's workspaces, read a `deus://workspace?id=<workspace id>&session=<chat id>` link with `read_session`. Pass its `session` value as `session`.\nWithout `session`, pass the link's `id` value as `session` to read the workspace's current chat."
    );
  }
);

it("tells a chat in an already-named workspace to rename only the chat", () => {
  const { config } = buildTurnStartParams("chat-2", "turn", "claude-code", "Investigate logs", {
    ...workspace,
    workspaceHasTitle: true,
  });
  expect(config.systemPromptAppend).toContain(
    "Once the task is clear, use `rename` to give your chat a short title (3–6 words) that names the outcome, and rename it again only if the task changes. Leave the workspace title as it is unless asked."
  );
  expect(config.systemPromptAppend).not.toContain("give your chat and its workspace");
});

it("omits proactive rename guidance in Plan mode", () => {
  const { config } = buildTurnStartParams("chat", "turn", "claude-code", "Plan the rollout", {
    ...workspace,
    permissionMode: "plan",
  });
  expect(config.systemPromptAppend).not.toContain("use `rename`");
});

it.each([
  ["ios", "0123-4567", "--udid"],
  ["android", "emulator-5556", "--serial"],
] as const)("briefs the agent on the Device tab's %s selection", (platform, id, flag) => {
  const turn = buildTurnStartParams("chat", "turn", "codex-app-server", "Look at this", {
    ...workspace,
    device: { platform, id },
  });
  expect(turn.config.systemPromptAppend).toContain(
    `Device tab shows ${id}. Pass \`--platform ${platform} ${flag} ${id}\``
  );
});

describe.each(LOCAL_HARNESSES)("%s local permission policy", (harness) => {
  it.each([undefined, "native-session"])(
    "uses full access when the composer omits the mode (resume: %s)",
    (resume) => {
      const params = buildTurnStartParams("session", "turn", harness, "Update the app", {
        ...workspace,
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
      ...workspace,
      permissionMode,
    });

    expect(params.config.permissionMode).toBe(permissionMode);
  });
});

describe.each(LOCAL_HARNESSES)("%s and the Device tab", (harness) => {
  it("names the tab's device to the agent, and nothing without one", () => {
    const device = { platform: "ios" as const, id: "5E4E0C2F-7025-4AAE-86D4-75A9BCD7AF06" };
    const shown = buildTurnStartParams("session", "turn", harness, "Check it", {
      ...workspace,
      device,
    });
    expect(shown.config.systemPromptAppend).toContain(`--platform ios --udid ${device.id}`);
    const none = buildTurnStartParams("session", "turn", harness, "Check it", workspace);
    expect(none.config.systemPromptAppend).not.toContain("--udid");
  });
});

describe.each(LOCAL_HARNESSES)("%s and agent-device", (harness) => {
  it("briefs the agent on the bundled CLI and runs it in the workspace's session", () => {
    const params = buildTurnStartParams("chat-1", "turn", harness, "Open Settings", {
      ...workspace,
      agentDeviceSession: "workspace-1",
      env: { CODEX_HOME: "/homes/chat-1" },
    });
    expect(params.config.systemPromptAppend).toContain(
      "`agent-device open <app or bundle id> --foreground`"
    );
    // Every harness has the Deus tools, so every one is briefed on them.
    expect(params.config.systemPromptAppend).toContain("# Screen Recording");
    // Every chat of the workspace shares it, and a simulator recording joins it.
    expect(params.config.env).toEqual({
      AGENT_DEVICE_SESSION: "workspace-1",
      CODEX_HOME: "/homes/chat-1",
    });
  });
});
