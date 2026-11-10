// backend/src/services/integrations/credentials.ts
// What an app's account gives a request, at the moment of the request: the
// headers for its remote MCP server, or the environment of its local one.
// The gateway and the readiness check both ask here, so a turn and "Check
// connection" use an account exactly the same way.
//
// Nothing here is cached beyond what its source allows: an OAuth token is
// refreshed when it is about to expire (single-flight, in auth/mcp-oauth.ts);
// a CLI's token is read from the CLI, kept a minute; a pasted key is opened
// from the vault. `fresh` asks again after the server refused what we sent.

import type { McpServerConfig } from "@zvada/agent-server/protocol";
import { match } from "ts-pattern";
import type { CatalogApp } from "@shared/integrations/types";
import { runGh } from "../gh.service";
import { registeredClient } from "./auth/clients";
import { cloudServer } from "./auth/cloud-accounts";
import { oauthAccessToken } from "./auth/mcp-oauth";
import { integrationsChanged } from "./events";
import { readCredential, updateConnection, type ConnectionRow } from "./store";
import { vaultProblem } from "./vault";

/** What the vault holds for a `secret` connection: a pasted key, or a local server's variables. */
export interface SecretCredential {
  values: Record<string, string>;
}

export type Credentials =
  | {
      ok: true;
      /** Sent to the app's remote server. */
      headers: Record<string, string>;
      /** Given to the app's local server. */
      env: Record<string, string>;
      /** Deus Cloud holds the account: requests go to its endpoint, not the app's own server. */
      cloud?: McpServerConfig & { type: "http" };
    }
  | {
      ok: false;
      reason: string;
      /** The account itself is the problem: the user has to sign in or paste a key again. */
      reauth: boolean;
    };

const NONE: Credentials = { ok: true, headers: {}, env: {} };

/** How long a CLI's token is reused before the CLI is asked again. */
const CLI_TOKEN_TTL_MS = 60_000;
/** A refresh or a CLI that does not answer must not hold a tool call forever. */
const CREDENTIAL_TIMEOUT_MS = 20_000;

let ghToken: { value: string; at: number } | null = null;

async function cliToken(cli: "gh", fresh: boolean): Promise<string | null> {
  if (cli !== "gh") return null;
  if (!fresh && ghToken && Date.now() - ghToken.at < CLI_TOKEN_TTL_MS) return ghToken.value;
  const result = await runGh(["auth", "token"], { timeoutMs: 5_000 });
  ghToken = result.success && result.stdout ? { value: result.stdout, at: Date.now() } : null;
  return ghToken?.value ?? null;
}

function timeout<T>(promise: Promise<T>, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${what} timed out`)), CREDENTIAL_TIMEOUT_MS);
    }),
  ]).finally(() => clearTimeout(timer));
}

const NOT_CONNECTED: Credentials = { ok: false, reason: "Not connected", reauth: true };
/** The catalog changed how the app signs in since this account was made. */
const CONNECT_AGAIN: Credentials = { ok: false, reason: "Connect again", reauth: true };

/**
 * The credentials `app` uses through `connection` (null for an app with no
 * account). Never throws: a failure says why, and whether the account needs
 * the user.
 */
export async function credentialsFor(
  app: CatalogApp,
  connection: ConnectionRow | null,
  options: { fresh?: boolean } = {}
): Promise<Credentials> {
  const auth = app.auth;
  if (auth.kind === "none") return NONE;
  if (!connection) return NOT_CONNECTED;
  if (connection.status === "needs_reauth") {
    // A CLI's login is the user's to fix outside Deus (`gh auth login`): look again.
    const recovered = connection.kind === "cli" && (await cliRecovered(connection));
    if (!recovered) {
      return { ok: false, reason: connection.lastError ?? "Sign in again", reauth: true };
    }
  } else if (connection.status !== "active") {
    return NOT_CONNECTED;
  }

  try {
    // The connection says how its account is held, whatever route the app
    // would take today: an app that signs in directly now may hold an
    // account made through Deus Cloud, and the reverse.
    return await match(connection.kind)
      .with("managed", (): Credentials => {
        // Signed out of Deus, or signed in as someone else, throws: the
        // app's own sign-in still stands, so nothing asks for it again.
        return { ok: true, headers: {}, env: {}, cloud: cloudServer(connection) };
      })
      .with("oauth", async (): Promise<Credentials> => {
        if (auth.kind !== "oauth" || app.transport.type !== "http") return CONNECT_AGAIN;
        const client = auth.registration === "preregistered" ? registeredClient(app.id) : null;
        if (auth.registration === "preregistered" && !client) {
          return { ok: false, reason: `Deus has no ${app.name} sign-in yet`, reauth: false };
        }
        const token = await timeout(
          oauthAccessToken(connection.id, app.transport.url, client, { force: options.fresh }),
          `Refreshing the ${app.name} sign-in`
        );
        return token
          ? { ok: true, headers: { Authorization: `Bearer ${token}` }, env: {} }
          : { ok: false, reason: "Sign in again", reauth: true };
      })
      .with("cli", async (): Promise<Credentials> => {
        if (auth.kind !== "bearer" || !auth.cliToken) return CONNECT_AGAIN;
        const token = await cliToken(auth.cliToken, options.fresh === true);
        return token
          ? { ok: true, headers: { Authorization: `Bearer ${token}` }, env: {} }
          : { ok: false, reason: "The GitHub CLI is not signed in (gh auth login)", reauth: true };
      })
      .with("secret", (): Credentials => {
        const credential = readCredential<SecretCredential>(connection.id);
        if (!credential) {
          const problem = vaultProblem();
          return problem
            ? { ok: false, reason: problem, reauth: false }
            : { ok: false, reason: "The saved key cannot be read; connect again", reauth: true };
        }
        if (auth.kind === "bearer" || auth.kind === "header") {
          const token = credential.values.token;
          if (!token) return { ok: false, reason: "No key saved", reauth: true };
          return auth.kind === "bearer"
            ? { ok: true, headers: { Authorization: `Bearer ${token}` }, env: {} }
            : { ok: true, headers: { [auth.header]: token }, env: {} };
        }
        if (auth.kind !== "env") return CONNECT_AGAIN;
        const env = Object.fromEntries(
          Object.entries(credential.values).filter(([, value]) => value.length > 0)
        );
        const missing = auth.vars.find((v) => !v.optional && !env[v.name]);
        return missing
          ? { ok: false, reason: `Missing ${missing.name}`, reauth: true }
          : { ok: true, headers: {}, env };
      })
      .exhaustive();
  } catch (error) {
    // A network failure or a timeout: the account may be fine.
    return {
      ok: false,
      reason: error instanceof Error ? error.message : String(error),
      reauth: false,
    };
  }
}

/** Whether a CLI-backed account that needed the user has its login back; marks it active. */
export async function cliRecovered(connection: ConnectionRow): Promise<boolean> {
  if (!(await cliToken("gh", true))) return false;
  updateConnection(connection.id, { status: "active", lastError: null });
  integrationsChanged();
  return true;
}

/** @internal */
export function __resetCredentialCacheForTests(): void {
  ghToken = null;
}
