// Claude subscription connect: turn the user's Claude Pro/Max plan into a
// cloud-agent credential. The sanctioned shape is the USER minting a
// one-year token via `claude setup-token` on their own machine — we assist
// by running the CLI for them (browser opens, they approve on claude.ai,
// we capture the printed token); paste stays as the fallback. The token
// lives in the safeStorage vault and reaches the backend via the runtime
// credentials push — never the renderer, never the sandbox env (the
// sidecar proxy holds it turn-scoped).

import { execFile } from "child_process";
import { ipcMain } from "electron";
import { promisify } from "util";
import { checkCliTool, getCliLookupEnv } from "./cli-tools";
import {
  deleteCloudCredential,
  getCloudCredentialsStatus,
  setCloudCredential,
} from "./cloud-credentials";
import { pushCloudCredentialsToBackend, syncClaudeTokenToPlatform } from "./deus-cloud-provision";

import type { ClaudeSubscriptionResult } from "../../../shared/types";

const execFileAsync = promisify(execFile);

/** `claude setup-token` prints a one-year OAuth bearer with this prefix. */
const OAUTH_TOKEN_RE = /sk-ant-oat[a-zA-Z0-9_-]+/;

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

/**
 * Assisted mint: run `claude setup-token` locally. The CLI opens the
 * browser for approval on claude.ai and prints the token when done. If the
 * CLI needs an interactive terminal (version-dependent), we surface a clear
 * error and the UI falls back to the paste flow.
 */
export async function connectClaudeSubscriptionAssisted(): Promise<ClaudeSubscriptionResult> {
  const claude = await checkCliTool("claude");
  if (!claude.installed || !claude.path) {
    return statusResult("Claude CLI not found — use the paste option instead.");
  }

  try {
    const { stdout, stderr } = await execFileAsync(claude.path, ["setup-token"], {
      env: getCliLookupEnv(),
      timeout: 10 * 60 * 1000,
      maxBuffer: 1024 * 1024,
    });
    const match = `${stdout}\n${stderr}`.match(OAUTH_TOKEN_RE);
    if (!match) {
      return statusResult(
        "setup-token finished without printing a token — run `claude setup-token` in a terminal and paste the result."
      );
    }
    return storeToken(match[0]);
  } catch (error) {
    const killed =
      typeof error === "object" && error != null && "killed" in error && error.killed === true;
    return statusResult(
      killed
        ? "Sign-in timed out — approve the request in your browser and try again."
        : "Couldn't run setup-token here — run `claude setup-token` in a terminal and paste the result."
    );
  }
}

export async function disconnectClaudeSubscription(): Promise<ClaudeSubscriptionResult> {
  await deleteCloudCredential("claudeOauthToken");
  await syncClaudeTokenToPlatform(null);
  await pushCloudCredentialsToBackend();
  return statusResult();
}

export function registerClaudeSubscriptionHandlers(): void {
  ipcMain.handle("deus_cloud:claude_sub_status", () => statusResult());
  ipcMain.handle("deus_cloud:claude_sub_connect", () => connectClaudeSubscriptionAssisted());
  ipcMain.handle("deus_cloud:claude_sub_save_token", (_event, token: unknown) =>
    saveClaudeSubscriptionToken(String(token ?? ""))
  );
  ipcMain.handle("deus_cloud:claude_sub_disconnect", () => disconnectClaudeSubscription());
}
