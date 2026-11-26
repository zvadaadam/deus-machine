// backend/src/services/agent/workspace-context.ts
// The instructions a local chat receives about Deus, its worktree and its project.

import * as path from "path";
import type { HubDevice } from "@shared/types/device-hub";
import { OPERATOR_GUIDANCE, quote } from "@zvada/agent-server/operator";
import { TELL_USER } from "@shared/agent-message";
import { DEUS_TOOLS_SERVER } from "@shared/mcp-servers";

/**
 * Derives the project (repo) name from a worktree path.
 * Worktrees live at `/path/to/repo/.deus/{workspace-name}`.
 * Returns the repo directory name, or falls back to the leaf directory.
 */
export function getProjectName(cwd: string): string {
  const marker = "/.deus/";
  const idx = cwd.indexOf(marker);
  if (idx === -1) return path.basename(cwd);
  return path.basename(cwd.substring(0, idx));
}

export type WorkspaceDevice = Pick<HubDevice, "platform" | "id">;

function deviceInstructions(device?: WorkspaceDevice | null) {
  if (!device) return "";
  const flag = device.platform === "ios" ? "--udid" : "--serial";
  return `This workspace's Device tab shows ${device.id}. Pass \`--platform ${device.platform} ${flag} ${device.id}\` to agent-device so the person sees what you do.\n`;
}

export type WorkspaceSetup =
  | { state: "running"; command?: string; log: string; statusFile: string }
  | { state: "failed"; reason: string; detail: string | null };

const shellArg = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";

function setupInstructions(setup?: WorkspaceSetup | null): string {
  if (!setup) return "";
  if (setup.state === "running") {
    const action = setup.command
      ? `Deus is running the workspace setup command\n${quote(setup.command)}`
      : "Deus is resolving the workspace setup recipe.";
    return `${action}\nOutput goes to ${shellArg(setup.log)}. Continue work that does not need the dependencies. Do not start another install while setup is running.\n\`cat ${shellArg(setup.statusFile)}\` prints running, completed, none (no script), or failed with an exit code when available (e.g. failed 1).\n`;
  }
  const output = setup.detail
    ? `The last lines the setup script printed were\n${quote(setup.detail)}\n`
    : "";
  return `Workspace setup failed.\n${quote(setup.reason)}\n${output}Deus runs setup with the project's environment and checks its required variables. Running it by hand skips that preparation and leaves this status unchanged.\nAfter a repair, ask the person to choose "Run again" on the workspace's start line.\n`;
}

/** How to drive a simulator: Deus ships agent-device (scripts/runtime/agent-clis.ts), whose own help carries the rest. */
const AGENT_DEVICE =
  "Drive iOS Simulators and Android emulators with the `agent-device` CLI. " +
  "Start with `agent-device open <app or bundle id> --foreground`, which prints a snapshot with `@refs`. " +
  'Act with `press|fill|longpress <@ref> --settle`, `scroll <direction> --settle` or `back --settle`, verify with `wait text "…"`, ' +
  "and end with `agent-device close` (`close --shutdown` if you booted it) so another workspace can use the device. " +
  "`agent-device help <topic>` has more (`dogfood` for exploratory QA, `debugging`, `react-native`).\n";

export const AGENT_MESSAGES = `
# Messages to the person

Until you finish, the person sees only what you send with the \`${TELL_USER}\` tool of the \`${DEUS_TOOLS_SERVER}\` server (call it by the name your tool list gives it). Text you write between tool calls is not shown to them while you work.

- On a job of more than a few steps, send one message before you start, saying what you will do, and one at each result they can use or finding that changes the plan.
- When they ask to hear a finding before you act on it, send it before you act.
- Put related results in one message. Send no progress notes ("now running the tests"), and nothing for a short answer.
- Your final reply is the closing message: write it once, as your normal reply, and do not send it with the tool as well.
`;

/**
 * Builds concise workspace context for any agent.
 * Includes project name, worktree path, and orchestrator info.
 */
export function buildWorkspaceContext(
  cwd?: string,
  device?: WorkspaceDevice | null,
  setup?: WorkspaceSetup | null
): string {
  if (!cwd) return "";

  const projectName = getProjectName(cwd);
  return (
    `You are working inside Deus, a desktop app that orchestrates multiple AI coding agents in parallel.\n` +
    `Project: **${projectName}**. ` +
    `Your working directory is a git worktree at \`${cwd}\` — the directory name is the workspace name, not the project name. ` +
    `You can only edit files within this worktree. Each workspace has a .context directory (gitignored) for cross-agent collaboration.\n` +
    setupInstructions(setup) +
    `A built-in browser is available for testing UI changes.\n` +
    AGENT_DEVICE +
    deviceInstructions(device) +
    // The session tools every chat here has (services/assistants: withSessionTools).
    `${OPERATOR_GUIDANCE}\n` +
    "You may use `rename` on your own chat and its workspace.\n" +
    "For this computer's workspaces, read a `deus://workspace?id=<workspace id>&session=<chat id>` link with `read_session`. Pass its `session` value as `session`.\n" +
    "Without `session`, pass the link's `id` value as `session` to read the workspace's current chat.\n" +
    `You can render live HTML+CSS previews inline in chat using the \`html-preview\` code fence — it renders in an isolated Shadow DOM instead of showing code. Use this naturally whenever showing is clearer than describing (design options, component variations, layout ideas).`
  );
}
