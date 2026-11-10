// backend/src/services/integrations/apps.ts
// Apps: install, connect, remove. Installing and authorizing are separate:
// connecting an app installs it; installing one leaves its account for later
// ("Installed · needs sign-in"). What an account's rows mean is accounts.ts;
// apps that connect through the Deus account are cloud-apps.ts.

import { getErrorMessage } from "@shared/lib/errors";
import {
  CustomAppInputSchema,
  type CatalogApp,
  type ConnectAppInput,
  type ConnectAppResult,
  type CustomAppInput,
} from "@shared/integrations/types";
import { runGh } from "../gh.service";
import { attachConnection, forgetAccounts } from "./accounts";
import { signInReturnUrl } from "./auth/callback";
import { registeredClient } from "./auth/clients";
import { abandonOAuth, attemptFor, beginOAuth, completeOAuth } from "./auth/mcp-oauth";
import { findApp } from "./catalog";
import { checkApp } from "./checks";
import { connectThroughCloud } from "./cloud-apps";
import type { SecretCredential } from "./credentials";
import { integrationsChanged } from "./events";
import { signInRoute } from "./sign-in-route";
import {
  createConnection,
  deleteInstallation,
  getConnection,
  getInstallation,
  listConnections,
  updateConnection,
  upsertInstallation,
} from "./store";

// ---------------------------------------------------------------------------
// Install / remove
// ---------------------------------------------------------------------------

function requireApp(appId: string): CatalogApp {
  const app = findApp(appId);
  if (!app) throw new Error(`Unknown app: ${appId}`);
  return app;
}

/**
 * Install an app. `explicit: false` is a plugin bringing it in: an app the
 * user already installed themselves stays theirs.
 */
export function installApp(appId: string, options: { explicit?: boolean } = {}): void {
  const app = requireApp(appId);
  const current = getInstallation("app", app.id);
  const explicit = options.explicit ?? true;
  if (current) {
    if (explicit && !current.explicit)
      upsertInstallation({ kind: "app", itemId: app.id, explicit });
  } else {
    upsertInstallation({ kind: "app", itemId: app.id, explicit });
    if (app.auth.kind === "none") void checkApp(app.id);
  }
  integrationsChanged();
}

/** Remove an app, and its account with it. */
export function uninstallApp(appId: string): void {
  deleteInstallation("app", appId);
  forgetAccounts(appId);
  integrationsChanged();
}

export function setAppEnabled(appId: string, enabled: boolean): void {
  if (!getInstallation("app", appId)) throw new Error("Install the app first");
  upsertInstallation({ kind: "app", itemId: appId, enabled });
  integrationsChanged();
}

// ---------------------------------------------------------------------------
// Connect / disconnect
// ---------------------------------------------------------------------------

/**
 * Connect an app: OAuth answers with a page to open in the browser (the
 * callback finishes it); a key, token or CLI login connects at once.
 */
export async function connectApp(input: ConnectAppInput): Promise<ConnectAppResult> {
  const app = requireApp(input.appId);
  const auth = app.auth;
  const route = signInRoute(app);
  if (route.via === "unavailable") {
    throw new Error(
      route.reason === "account"
        ? `Sign in to your Deus account to connect ${app.name}`
        : `${app.name} sign-in is coming soon`
    );
  }
  if (!getInstallation("app", app.id)) installApp(app.id);

  if (route.via === "cloud") return connectThroughCloud(app, route);

  if (auth.kind === "none") {
    void checkApp(app.id);
    return { status: "connected" };
  }

  if (auth.kind === "oauth") {
    if (app.transport.type === "stdio" || app.transport.type === "broker") {
      throw new Error("OAuth needs a remote server");
    }
    // One connection waits for the browser at a time: a second click reuses it.
    const waiting =
      listConnections(app.id).find((c) => c.kind === "oauth" && c.status !== "active") ??
      createConnection({ appId: app.id, kind: "oauth" });
    try {
      const url = await beginOAuth({
        connectionId: waiting.id,
        serverUrl: app.transport.url,
        redirectUrl: signInReturnUrl(),
        client: auth.registration === "preregistered" ? registeredClient(app.id) : null,
      });
      return { status: "redirect", url };
    } catch (error) {
      updateConnection(waiting.id, { lastError: getErrorMessage(error) });
      integrationsChanged();
      throw new Error(`${app.name} did not start a sign-in: ${getErrorMessage(error)}`);
    }
  }

  // A managed app only ever connects through Deus Cloud (handled above).
  if (auth.kind === "managed") throw new Error(`${app.name} has no sign-in of its own`);

  // A signed-in CLI: nothing is stored, the CLI supplies the token at each use.
  const values = input.values ?? {};
  if (auth.kind === "bearer" && values.fromCli === "gh" && auth.cliToken === "gh") {
    const token = await runGh(["auth", "token"], { timeoutMs: 5_000 });
    if (!token.success || !token.stdout) {
      throw new Error("The GitHub CLI is not signed in. Run `gh auth login`, or paste a token.");
    }
    const connection = createConnection({
      appId: app.id,
      kind: "cli",
      label: "GitHub CLI login",
      status: "active",
    });
    attachConnection(app.id, connection.id);
    void checkApp(app.id);
    return { status: "connected" };
  }

  // A pasted key or token, or a local server's variables: sealed in the vault.
  let credential: SecretCredential;
  if (auth.kind === "bearer" || auth.kind === "header") {
    const token = values.token?.trim();
    if (!token) throw new Error(`Paste your ${auth.label.toLowerCase()}`);
    credential = { values: { token } };
  } else {
    const vars = Object.fromEntries(
      auth.vars.map((v) => [v.name, values[v.name]?.trim() ?? ""] as const)
    );
    const missing = auth.vars.find((v) => !v.optional && !vars[v.name]);
    if (missing) throw new Error(`${missing.label} is required`);
    credential = { values: vars };
  }

  const connection = createConnection({
    appId: app.id,
    kind: "secret",
    status: "active",
    credential,
  });
  attachConnection(app.id, connection.id);
  void checkApp(app.id);
  return { status: "connected" };
}

/** Sign out of an app: forget its account; the app stays installed. */
export function disconnectApp(appId: string): void {
  forgetAccounts(appId);
  integrationsChanged();
}

/** Finish an OAuth redirect. Returns the app's name for the page the browser shows. */
export async function completeOAuthCallback(params: URLSearchParams): Promise<string> {
  const state = params.get("state") ?? "";
  const connectionId = attemptFor(state);
  const connection = connectionId ? getConnection(connectionId) : null;
  const app = connection ? findApp(connection.appId) : null;
  if (!connection || !app) throw new Error("This sign-in link has expired. Start again from Deus.");

  const error = params.get("error");
  if (error) {
    abandonOAuth(state);
    const reason = (params.get("error_description") ?? error).slice(0, 300);
    updateConnection(connection.id, { lastError: reason });
    integrationsChanged();
    throw new Error(error === "access_denied" ? "The sign-in was cancelled." : reason);
  }
  const code = params.get("code");
  if (!code) throw new Error("The provider did not return a sign-in code");
  try {
    await completeOAuth({ state, code });
  } catch (err) {
    updateConnection(connection.id, { lastError: getErrorMessage(err) });
    integrationsChanged();
    throw err;
  }
  attachConnection(app.id, connection.id);
  void checkApp(app.id);
  return app.name;
}

// ---------------------------------------------------------------------------
// The user's own servers
// ---------------------------------------------------------------------------

/** Add the user's own MCP server as an app. */
export function addCustomApp(raw: CustomAppInput): { appId: string } {
  const input = CustomAppInputSchema.parse(raw);
  const base =
    input.name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "server";
  let id = base;
  for (let n = 2; findApp(id); n++) id = `${base}-${n}`;
  const local = input.transport.type === "stdio" || isLoopback(input.transport.url);
  const app: CatalogApp = {
    id,
    name: input.name,
    publisher: "You",
    official: false,
    description:
      input.description ||
      (input.transport.type === "stdio"
        ? [input.transport.command, ...input.transport.args].join(" ")
        : input.transport.url),
    categories: ["developer"],
    transport: input.transport,
    auth: input.auth,
    local,
  };
  upsertInstallation({
    kind: "app",
    itemId: id,
    definition: app,
    explicit: true,
  });
  if (app.auth.kind === "none") void checkApp(id);
  integrationsChanged();
  return { appId: id };
}

function isLoopback(url: string): boolean {
  try {
    return ["localhost", "127.0.0.1", "[::1]"].includes(new URL(url).hostname);
  } catch {
    return false;
  }
}
