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
  getCloudCredential,
  getCloudCredentialMeta,
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
  codex: "codex login --device-auth",
};

/** Open the user's terminal with the agent's mint command typed in and run. */
export async function openAgentSetupTerminal(
  agentId: string
): Promise<{ ok: boolean; error?: string }> {
  const command = AGENT_SETUP_COMMANDS[agentId];
  if (!command) return { ok: false, error: `No setup command for agent "${agentId}"` };
  // osascript is macOS-only; Linux packages are a shipped target. The command
  // is displayed with a Copy button either way, so degrade to telling the user
  // exactly what to run rather than a bare "Could not open Terminal".
  if (process.platform !== "darwin") {
    return { ok: false, error: `Open a terminal and run: ${command}` };
  }
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
  const synced = await syncClaudeTokenToPlatform(token);
  if (synced) {
    // Stamp the owning org: the catch-up path uses it to refuse uploading
    // this token into a second account's org.
    const orgId = (await getCloudCredentialMeta("agntApiKey").catch(() => null))?.orgId ?? null;
    await setCloudCredential("claudeOauthToken", token, {
      syncedToPlatform: true,
      ...(orgId ? { syncedOrgId: orgId } : {}),
    });
  }
  await pushCloudCredentialsToBackend();
  return statusResult();
}

/**
 * Prove the token actually authenticates before we ever call it connected:
 * a minimal real request in the exact shape the sandbox proxy sends
 * (Bearer + the OAuth beta capability). 401 = rejected. Non-auth failures
 * (rate limit, overload, offline) do NOT block saving — auth is checked
 * first upstream, so any non-401 response means the token authenticated.
 */
async function validateClaudeToken(token: string): Promise<string | null> {
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "anthropic-beta": "oauth-2025-04-20",
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 1,
        messages: [{ role: "user", content: "ping" }],
      }),
    });
    if (res.status === 401 || res.status === 403) {
      return "Anthropic rejected this token — run `claude setup-token` again and paste the fresh one.";
    }
    return null;
  } catch {
    return null; // offline — don't block; the first turn surfaces real issues
  }
}

/** Paste flow — accepts a token the user minted themselves, verified live. */
export async function saveClaudeSubscriptionToken(
  rawToken: string
): Promise<ClaudeSubscriptionResult> {
  const token = rawToken.trim().match(OAUTH_TOKEN_RE)?.[0];
  if (!token) {
    return statusResult(
      "That doesn't look like a Claude subscription token (expected sk-ant-oat…). Run `claude setup-token` and paste its output."
    );
  }
  const invalid = await validateClaudeToken(token);
  if (invalid) return statusResult(invalid);
  return storeToken(token);
}

export async function disconnectClaudeSubscription(): Promise<ClaudeSubscriptionResult> {
  // The PLATFORM copy is what cloud/phone turns bill against, so it must die
  // first: dropping the local token while the DELETE fails would report
  // "disconnected" whilst the token keeps working server-side, with no local
  // copy left to retry from. No device key = never synced = nothing to delete.
  const hasDeviceKey = Boolean(await getCloudCredential("agntApiKey").catch(() => null));
  if (hasDeviceKey) {
    if (!(await syncClaudeTokenToPlatform(null))) {
      return statusResult(
        "Couldn't remove the token from the Deus platform — it would keep running cloud turns. Check your connection and try again."
      );
    }
  } else if (
    (await getCloudCredentialMeta("claudeOauthToken").catch(() => null))?.syncedToPlatform
  ) {
    // Signed out AFTER syncing: the platform copy outlives this device and
    // there is no key left to delete it with. Saying "disconnected" here
    // would be a lie about a token that still runs (and bills) cloud turns.
    return statusResult(
      "This token was copied to Deus Cloud and can only be removed while signed in. Sign in and disconnect again."
    );
  }
  await deleteCloudCredential("claudeOauthToken");
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
