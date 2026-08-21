// Codex (ChatGPT plan) subscription connect. The mint is the user running
// `codex login --device-auth` in their own terminal (device-code approval
// on their ChatGPT account) — the CLI writes ~/.codex/auth.json. We IMPORT
// that file: validate it's chatgpt-mode with live tokens, store it in the
// safeStorage vault, and sync the platform copy (an unlinked turn-credential
// secret). Cloud turns consume it when Codex cloud support lands — the
// status is honest about that.

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { ipcMain } from "electron";
import { deleteCloudCredential, setCloudCredential } from "./cloud-credentials";
import { getCloudCredentialsStatus } from "./cloud-credentials";
import { pushCloudCredentialsToBackend, syncAgentSecretToPlatform } from "./deus-cloud-provision";

export interface CodexSubscriptionResult {
  success: boolean;
  hasCodexSubscription: boolean;
  accountEmail?: string;
  error?: string;
}

const AUTH_JSON_PATH = () => join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), "auth.json");

async function statusResult(error?: string): Promise<CodexSubscriptionResult> {
  const status = await getCloudCredentialsStatus().catch(() => null);
  return {
    success: !error,
    hasCodexSubscription: status?.hasCodexSubscription ?? false,
    ...(error ? { error } : {}),
  };
}

/** Import ~/.codex/auth.json after the user ran the device-auth login. */
export async function importCodexAuth(): Promise<CodexSubscriptionResult> {
  let raw: string;
  try {
    raw = await readFile(AUTH_JSON_PATH(), "utf8");
  } catch {
    return statusResult(
      "No ~/.codex/auth.json found — run `codex login --device-auth` in a terminal first."
    );
  }
  let parsed: {
    auth_mode?: string;
    tokens?: { access_token?: string; refresh_token?: string };
    OPENAI_API_KEY?: string | null;
  };
  try {
    parsed = JSON.parse(raw);
  } catch {
    return statusResult("~/.codex/auth.json is not valid JSON — sign in again with the CLI.");
  }
  const chatgptMode = parsed.auth_mode === "chatgpt" && Boolean(parsed.tokens?.access_token);
  if (!chatgptMode) {
    return statusResult(
      "That auth.json isn't a ChatGPT-plan login (device-auth) — run `codex login --device-auth`."
    );
  }
  await setCloudCredential("codexAuthJson", raw);
  // Canonical platform copy — an unlinked turn credential (per-sandbox
  // seeding consumes it when Codex cloud support lands).
  await syncAgentSecretToPlatform("CODEX_AUTH_JSON", raw);
  await pushCloudCredentialsToBackend();
  return statusResult();
}

export async function disconnectCodexSubscription(): Promise<CodexSubscriptionResult> {
  await deleteCloudCredential("codexAuthJson");
  await syncAgentSecretToPlatform("CODEX_AUTH_JSON", null);
  await pushCloudCredentialsToBackend();
  return statusResult();
}

export function registerCodexSubscriptionHandlers(): void {
  ipcMain.handle("deus_cloud:codex_sub_status", () => statusResult());
  ipcMain.handle("deus_cloud:codex_sub_import", () => importCodexAuth());
  ipcMain.handle("deus_cloud:codex_sub_disconnect", () => disconnectCodexSubscription());
}
