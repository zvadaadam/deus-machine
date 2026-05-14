// packages/pencil/src/lib/auth.ts
//
// Auth state surface. Three sources, in priority order:
//   1. PENCIL_CLI_KEY env var (lets CI / shell setups override anything)
//   2. ~/.deus/pencil/cli-key (Deus-managed, set via the iframe paste form)
//   3. ~/.pencil/session-cli.json (the CLI's own `pencil login` output)

import * as fs from "node:fs";
import { dirname } from "node:path";
import { DEUS_CLI_KEY_FILE, DEUS_EDITOR_SESSION_FILE, PENCIL_SESSION_FILE } from "./config.ts";
import type { AuthState, ResolvedKey } from "./types.ts";

// ---- Editor web-session ---------------------------------------------------
//
// The Pencil editor (the iframe) maintains its own web session for cloud
// features (AI image gen, library browsing, design-kit fetch). When the
// user signs in via Pencil's email-OTP card, the editor pushes
// `notify("set-session", {email, token})` to us. We persist that here so
// the next iframe launch can return it from get-session and skip the
// sign-in card entirely.

export interface EditorSession {
  email: string;
  token: string;
  /** When we received it. Useful for invalidation; the cloud may also revoke. */
  savedAt: string;
}

export function readEditorSession(): EditorSession | null {
  try {
    const raw = fs.readFileSync(DEUS_EDITOR_SESSION_FILE, "utf8");
    const data = JSON.parse(raw) as Partial<EditorSession>;
    if (typeof data.email === "string" && typeof data.token === "string") {
      return {
        email: data.email,
        token: data.token,
        savedAt: typeof data.savedAt === "string" ? data.savedAt : new Date(0).toISOString(),
      };
    }
  } catch {
    /* missing or malformed */
  }
  return null;
}

export function writeEditorSession(session: { email: string; token: string }): void {
  fs.mkdirSync(dirname(DEUS_EDITOR_SESSION_FILE), { recursive: true });
  fs.writeFileSync(
    DEUS_EDITOR_SESSION_FILE,
    JSON.stringify({ ...session, savedAt: new Date().toISOString() }, null, 2),
    { mode: 0o600 }
  );
  fs.chmodSync(DEUS_EDITOR_SESSION_FILE, 0o600);
}

export function clearEditorSession(): void {
  try {
    if (fs.existsSync(DEUS_EDITOR_SESSION_FILE)) fs.unlinkSync(DEUS_EDITOR_SESSION_FILE);
  } catch {
    /* best effort */
  }
}

/** Read the Deus-managed CLI key, trim trailing whitespace (paste hygiene). */
export function readDeusCliKeyFile(): string | null {
  try {
    const contents = fs.readFileSync(DEUS_CLI_KEY_FILE, "utf8").trim();
    return contents.length > 0 ? contents : null;
  } catch {
    return null;
  }
}

/** Pick whichever key source has a value, env taking precedence. */
export function resolveCliKey(): ResolvedKey | null {
  const fromEnv = process.env.PENCIL_CLI_KEY;
  if (fromEnv && fromEnv.length > 0) return { key: fromEnv, source: "env" };
  const fromFile = readDeusCliKeyFile();
  if (fromFile) return { key: fromFile, source: "file" };
  return null;
}

/** Full snapshot for `/auth-status` and the iframe sign-in panel. Never
 *  echoes the key value. */
export function authState(): AuthState {
  const resolved = resolveCliKey();
  const sessionExists = fs.existsSync(PENCIL_SESSION_FILE);
  let sessionValid = false;
  let sessionEmail: string | null = null;
  if (sessionExists) {
    try {
      const raw = fs.readFileSync(PENCIL_SESSION_FILE, "utf8");
      const data = JSON.parse(raw) as { token?: string; email?: string };
      sessionValid = Boolean(data.token);
      sessionEmail = typeof data.email === "string" ? data.email : null;
    } catch {
      /* malformed → not valid */
    }
  }
  return {
    authed: Boolean(resolved) || sessionValid,
    cliKeySet: Boolean(resolved),
    cliKeySource: resolved?.source ?? null,
    sessionFile: PENCIL_SESSION_FILE,
    sessionExists,
    sessionValid,
    sessionEmail,
    deusCliKeyFile: DEUS_CLI_KEY_FILE,
  };
}

export function isAuthenticated(): boolean {
  return authState().authed;
}

/** Format check only — doesn't talk to the API. Use cli.verifyCliKey() to
 *  actually round-trip the key against api.pencil.dev. */
export function validateCliKey(key: unknown): key is string {
  if (typeof key !== "string") return false;
  const trimmed = key.trim();
  return trimmed.startsWith("pencil_cli_") && trimmed.length > "pencil_cli_".length;
}

/** Persist a user-supplied key with strict perms. Throws on FS error so
 *  the route handler can surface the message. */
export function persistKey(key: string): void {
  fs.mkdirSync(dirname(DEUS_CLI_KEY_FILE), { recursive: true });
  fs.writeFileSync(DEUS_CLI_KEY_FILE, key.trim(), { mode: 0o600 });
  fs.chmodSync(DEUS_CLI_KEY_FILE, 0o600);
}

export function clearKey(): void {
  try {
    if (fs.existsSync(DEUS_CLI_KEY_FILE)) fs.unlinkSync(DEUS_CLI_KEY_FILE);
  } catch {
    /* best effort */
  }
}
