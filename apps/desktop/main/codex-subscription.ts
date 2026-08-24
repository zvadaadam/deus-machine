// Codex (ChatGPT plan) subscription connect. The mint is the user running
// `codex login --device-auth` in their own terminal (device-code approval
// on their ChatGPT account) — the CLI writes ~/.codex/auth.json. We IMPORT
// that file: validate it's chatgpt-mode with live tokens, store it in the
// safeStorage vault, and sync the platform copy (an unlinked turn-credential
// secret). Cloud turns consume it when Codex cloud support lands — the
// status is honest about that.

import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { ipcMain } from "electron";
import { extendCliPath, resolveCliExecutable } from "../../../shared/lib/cli-path";
import { getCloudCredentialsStatus } from "./cloud-credentials";
import {
  connectAgentCredential,
  disconnectAgentCredential,
  type AgentCredentialSpec,
} from "./agent-credential";

import type { CodexSubscriptionResult } from "../../../shared/types";

const AUTH_JSON_PATH = () => join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), "auth.json");

const CODEX_CREDENTIAL: AgentCredentialSpec = {
  vaultName: "codexAuthJson",
  secretName: "CODEX_AUTH_JSON",
  deleteFailedMessage:
    "Couldn't remove the Codex login from the Deus platform — its refresh token would stay valid. Check your connection and try again.",
  signedOutMessage:
    "This login was copied to Deus Cloud and can only be removed while signed in. Sign in and disconnect again.",
};

async function statusResult(error?: string): Promise<CodexSubscriptionResult> {
  const status = await getCloudCredentialsStatus().catch(() => null);
  return {
    success: !error,
    hasCodexSubscription: status?.hasCodexSubscription ?? false,
    ...(error ? { error } : {}),
  };
}

/**
 * One-click sign-in: spawn the bundled codex CLI's browser login and import
 * the credential it writes. Plain `codex login` runs a local OAuth callback
 * and opens the browser itself — no ChatGPT security-settings toggle, no
 * device codes, no terminal. The CLI owns the entire OAuth exchange and
 * writes ~/.codex/auth.json; we only read the result, exactly like the
 * import path. Single-flight: a second click while the browser is open
 * reports the wait instead of racing a second login server.
 */
let codexLoginInFlight: Promise<CodexSubscriptionResult> | null = null;

export function startCodexLogin(): Promise<CodexSubscriptionResult> {
  if (codexLoginInFlight) return codexLoginInFlight;
  codexLoginInFlight = runCodexLogin().finally(() => {
    codexLoginInFlight = null;
  });
  return codexLoginInFlight;
}

async function runCodexLogin(): Promise<CodexSubscriptionResult> {
  const codex = resolveCliExecutable("codex");
  const exit = await new Promise<{ code: number | null; error?: string }>((resolve) => {
    const child = spawn(codex, ["login"], {
      env: { ...process.env, PATH: extendCliPath(process.env.PATH) },
      stdio: "ignore",
    });
    // The browser round-trip is the slow part; five minutes is generous and
    // guarantees the button never wedges on an abandoned login.
    const timer = setTimeout(() => {
      child.kill();
      resolve({ code: null, error: "Sign-in timed out — try again." });
    }, 5 * 60_000);
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ code: null, error: `Could not run codex: ${err.message}` });
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolve({ code });
    });
  });
  if (exit.error) return statusResult(exit.error);
  if (exit.code !== 0) {
    return statusResult("Codex sign-in did not complete — the browser flow was cancelled.");
  }
  // The CLI wrote auth.json; the import path validates, stores, and syncs.
  return importCodexAuth();
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
  // Canonical platform copy — an unlinked turn credential (per-sandbox
  // seeding consumes it when Codex cloud support lands).
  await connectAgentCredential(CODEX_CREDENTIAL, raw);
  return statusResult();
}

export async function disconnectCodexSubscription(): Promise<CodexSubscriptionResult> {
  return statusResult((await disconnectAgentCredential(CODEX_CREDENTIAL)) ?? undefined);
}

export function registerCodexSubscriptionHandlers(): void {
  ipcMain.handle("deus_cloud:codex_sub_status", () => statusResult());
  ipcMain.handle("deus_cloud:codex_sub_import", () => importCodexAuth());
  ipcMain.handle("deus_cloud:codex_sub_login", () => startCodexLogin());
  ipcMain.handle("deus_cloud:codex_sub_disconnect", () => disconnectCodexSubscription());
}
