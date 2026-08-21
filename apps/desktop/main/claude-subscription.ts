// Agent subscription connect: turn a personal plan (Claude Pro/Max today,
// more agents later) into a cloud-agent credential. The sanctioned shape is
// the USER running the mint command in their own terminal — we open the
// terminal WITH the command for them and they paste the result; the app
// never runs the OAuth flow itself. Tokens live in the safeStorage vault
// and reach the backend via the runtime credentials push — never the
// renderer, never the sandbox env (the sidecar proxy holds them
// turn-scoped). Setup commands are keyed by agent id here in MAIN — the
// renderer can only name an agent, never supply a command to execute.

import { spawn } from "child_process";
import { ipcMain } from "electron";
import {
  deleteCloudCredential,
  getCloudCredentialsStatus,
  setCloudCredential,
} from "./cloud-credentials";
import { pushCloudCredentialsToBackend, syncClaudeTokenToPlatform } from "./deus-cloud-provision";

import type { ClaudeSubscriptionResult } from "../../../shared/types";

/** `claude setup-token` prints a one-year OAuth bearer with this prefix. */
const OAUTH_TOKEN_RE = /sk-ant-oat[a-zA-Z0-9_-]+/;

/**
 * Mint commands per agent — the ONLY commands the terminal opener will run.
 * The renderer sends an agent id; an unknown id is a hard no-op. Growing
 * this table (plus a card entry in Settings) is the whole cost of a new
 * agent subscription.
 */
const AGENT_SETUP_COMMANDS: Record<string, string> = {
  "claude-code": "claude setup-token",
};

/** Open the user's terminal with the agent's mint command typed in and run. */
export async function openAgentSetupTerminal(
  agentId: string
): Promise<{ ok: boolean; error?: string }> {
  const command = AGENT_SETUP_COMMANDS[agentId];
  if (!command) return { ok: false, error: `No setup command for agent "${agentId}"` };
  return new Promise((resolve) => {
    const child = spawn("osascript", [
      "-e",
      'tell application "Terminal" to activate',
      "-e",
      `tell application "Terminal" to do script "${command}"`,
    ]);
    child.on("error", () => resolve({ ok: false, error: "Could not open Terminal" }));
    child.on("exit", (code) =>
      resolve(code === 0 ? { ok: true } : { ok: false, error: "Could not open Terminal" })
    );
  });
}

async function statusResult(error?: string): Promise<ClaudeSubscriptionResult> {
  const status = await getCloudCredentialsStatus().catch(() => null);
  return {
    success: !error,
    hasClaudeSubscription: status?.hasClaudeSubscription ?? false,
    ...(error ? { error } : {}),
  };
}

async function storeToken(token: string): Promise<ClaudeSubscriptionResult> {
  await setCloudCredential("claudeOauthToken", token);
  // Local vault = cache; the platform secret is canonical (phone/Mac-off).
  await syncClaudeTokenToPlatform(token);
  await pushCloudCredentialsToBackend();
  return statusResult();
}

/** Paste fallback — accepts a token the user minted themselves. */
export async function saveClaudeSubscriptionToken(
  rawToken: string
): Promise<ClaudeSubscriptionResult> {
  const token = rawToken.trim();
  if (!OAUTH_TOKEN_RE.test(token)) {
    return statusResult(
      "That doesn't look like a Claude subscription token (expected sk-ant-oat…). Run `claude setup-token` and paste its output."
    );
  }
  return storeToken(token.match(OAUTH_TOKEN_RE)![0]);
}

export async function disconnectClaudeSubscription(): Promise<ClaudeSubscriptionResult> {
  await deleteCloudCredential("claudeOauthToken");
  await syncClaudeTokenToPlatform(null);
  await pushCloudCredentialsToBackend();
  return statusResult();
}

export function registerClaudeSubscriptionHandlers(): void {
  ipcMain.handle("deus_cloud:claude_sub_status", () => statusResult());
  ipcMain.handle("deus_cloud:agent_setup_terminal", (_event, agentId: unknown) =>
    openAgentSetupTerminal(String(agentId ?? ""))
  );
  ipcMain.handle("deus_cloud:claude_sub_save_token", (_event, token: unknown) =>
    saveClaudeSubscriptionToken(String(token ?? ""))
  );
  ipcMain.handle("deus_cloud:claude_sub_disconnect", () => disconnectClaudeSubscription());
}
