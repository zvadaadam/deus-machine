// backend/src/services/integrations/auth/cloud-accounts.ts
// Accounts Deus Cloud holds. Some apps cannot sign in from this computer:
// their vendor admits only an approved OAuth client Deus does not have yet,
// or they have no MCP server of their own. Deus Cloud connects those through
// a broker (Composio), keyed by the person's Deus account, and serves each
// one's tools from an MCP endpoint of its own (AGNT `apps/deus-cloud`,
// `/me/connections`).
//
// The broker's key lives in Deus Cloud and nowhere else: it can act on every
// account connected through it, so it must never be on a computer. What this
// computer holds for such a connection is a row saying which app and which
// Deus account, with no credential. Its requests go through the gateway like
// any other app's; the Deus session rides only the hop from this backend to
// Deus Cloud, and the agent sees neither.

import crypto from "crypto";
import type { McpServerConfig } from "@zvada/agent-server/protocol";
import { BROKER_LABELS, type CatalogApp } from "@shared/integrations/types";
import { currentAccountSession, type AccountSession } from "../../account-session";
import type { ConnectionRow } from "../store";

type BrokerRoute = NonNullable<CatalogApp["broker"]>;

/** Deus Cloud answered, and refused. */
export class CloudAccountsError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
    this.name = "CloudAccountsError";
  }
}

/** A connection as Deus Cloud lists it. */
export interface CloudConnection {
  appId: string;
  provider: string;
  toolkit: string;
  status: "pending" | "active";
}

const CLOUD_TIMEOUT_MS = 20_000;
const SIGNED_OUT = "Sign in to your Deus account";

async function cloud<T>(
  session: AccountSession,
  method: string,
  path: string,
  body?: unknown
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${session.cloudUrl}/me/connections${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${session.sessionToken}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(CLOUD_TIMEOUT_MS),
    });
  } catch {
    throw new Error("Deus Cloud could not be reached. Check your connection and try again.");
  }
  const text = await response.text();
  let parsed: unknown = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    // Not JSON: an error page from something in between.
  }
  if (!response.ok) {
    const message = (parsed as { message?: unknown } | null)?.message;
    throw new CloudAccountsError(
      response.status,
      response.status === 401
        ? "Your Deus sign-in has expired. Sign in to Deus again."
        : typeof message === "string"
          ? message
          : `Deus Cloud answered ${response.status}`
    );
  }
  return parsed as T;
}

interface WireConnection {
  app_id: string;
  provider: string;
  toolkit: string;
  status: "pending" | "active";
}

const fromWire = (wire: WireConnection): CloudConnection => ({
  appId: wire.app_id,
  provider: wire.provider,
  toolkit: wire.toolkit,
  status: wire.status,
});

// ---------------------------------------------------------------------------
// What Deus Cloud serves for the signed-in account
// ---------------------------------------------------------------------------

/** The toolkits Deus Cloud connects, per broker, as last read for one account. */
let directory: { accountId: string; toolkits: Map<string, Set<string>> } | null = null;

/**
 * Whether an app's broker route can be used right now: `account` when no one
 * is signed in to Deus, `soon` when Deus Cloud does not serve the toolkit.
 * Until the first answer for an account arrives, the route counts as served:
 * Deus Cloud has the last word when the person connects.
 */
export function cloudRouteAvailability(route: BrokerRoute): "ready" | "account" | "soon" {
  const session = currentAccountSession();
  if (!session) return "account";
  if (directory?.accountId !== session.accountId) return "ready";
  return directory.toolkits.get(route.provider)?.has(route.toolkit) ? "ready" : "soon";
}

/** Changes when what Deus Cloud serves for the signed-in account changes (to push only then). */
export function cloudDirectoryVersion(): string {
  if (!directory) return "";
  const served = [...directory.toolkits].map(([id, toolkits]) => [id, [...toolkits].sort()]);
  return JSON.stringify([directory.accountId, served]);
}

export function brokerLabel(route: BrokerRoute): string {
  return BROKER_LABELS[route.provider];
}

/**
 * Read what Deus Cloud serves and what the signed-in account has connected.
 * Null when no one is signed in. A deployment with app connections switched
 * off (503), or one from before it had them (404), serves nothing.
 */
export async function readCloudAccounts(): Promise<{
  accountId: string;
  connections: CloudConnection[];
} | null> {
  const session = currentAccountSession();
  if (!session) {
    directory = null;
    return null;
  }
  let listed: {
    providers: Array<{ id: string; toolkits: string[] }>;
    items: WireConnection[];
  };
  try {
    listed = await cloud(session, "GET", "");
  } catch (error) {
    const unserved =
      error instanceof CloudAccountsError && (error.status === 503 || error.status === 404);
    if (!unserved) throw error;
    listed = { providers: [], items: [] };
  }
  // The account may have changed while Deus Cloud answered: keep nothing of the old one.
  if (currentAccountSession()?.accountId !== session.accountId) return null;
  directory = {
    accountId: session.accountId,
    toolkits: new Map(listed.providers.map((p) => [p.id, new Set(p.toolkits)])),
  };
  return { accountId: session.accountId, connections: listed.items.map(fromWire) };
}

// ---------------------------------------------------------------------------
// One connection
// ---------------------------------------------------------------------------

/**
 * Whether this computer can use the connection now: the Deus account that
 * made it is the one signed in. No network.
 */
export function cloudHolds(connection: ConnectionRow): boolean {
  const session = currentAccountSession();
  return session !== null && session.accountId === connection.deusAccountId;
}

/** The signed-in Deus account's id, or null. */
export function cloudAccountId(): string | null {
  return currentAccountSession()?.accountId ?? null;
}

function sessionFor(connection: Pick<ConnectionRow, "deusAccountId">): AccountSession {
  const session = currentAccountSession();
  if (!session) throw new Error(SIGNED_OUT);
  if (session.accountId !== connection.deusAccountId) {
    throw new Error("This app was connected with another Deus account");
  }
  return session;
}

/**
 * Start connecting `appId` for the signed-in account. An account already
 * connected (on another computer, or in a tab that never came back) answers
 * `connected`; otherwise `url` is the broker's sign-in page, which returns to
 * `callbackUrl` on this computer.
 */
export async function startCloudSignIn(input: {
  appId: string;
  route: BrokerRoute;
  callbackUrl: string;
}): Promise<{ status: "connected" } | { status: "redirect"; url: string }> {
  const session = currentAccountSession();
  if (!session) throw new Error(SIGNED_OUT);
  const started = await cloud<{ status: "connected" | "redirect"; url?: string }>(
    session,
    "POST",
    `/${encodeURIComponent(input.appId)}`,
    {
      toolkit: input.route.toolkit,
      callback_url: input.callbackUrl,
    }
  );
  if (started.status === "connected") return { status: "connected" };
  if (!started.url) throw new Error("Deus Cloud did not name a sign-in page");
  return { status: "redirect", url: started.url };
}

/** Whether the connection's account is connected, asked of Deus Cloud (which asks the broker). */
export async function cloudAccountConnected(
  connection: Pick<ConnectionRow, "appId" | "deusAccountId">
): Promise<boolean> {
  try {
    const { connection: found } = await cloud<{ connection: WireConnection }>(
      sessionFor(connection),
      "GET",
      `/${encodeURIComponent(connection.appId)}`
    );
    return found.status === "active";
  } catch (error) {
    // Not there: never finished, disconnected elsewhere, or revoked at the vendor.
    if (error instanceof CloudAccountsError && error.status === 404) return false;
    throw error;
  }
}

/**
 * Where the connection's tool requests go: its MCP endpoint in Deus Cloud,
 * with the Deus session as it is now (it renews daily, so it is read per
 * request). Throws when no one is signed in, or another account is.
 */
export function cloudServer(connection: ConnectionRow): McpServerConfig & { type: "http" } {
  const session = sessionFor(connection);
  return {
    type: "http",
    url: `${session.cloudUrl}/me/connections/${encodeURIComponent(connection.appId)}/mcp`,
    headers: { Authorization: `Bearer ${session.sessionToken}` },
  };
}

/**
 * Disconnect the account in Deus Cloud. True once Deus Cloud says it is gone
 * (or never had it); false when it could not be asked: signed out, another
 * Deus account signed in (only the account that made the connection can
 * disconnect it), or the request failed.
 */
export async function disconnectCloudAccount(connection: ConnectionRow): Promise<boolean> {
  forgetCloudTurnCapability();
  if (!cloudHolds(connection)) return false;
  try {
    await cloud(sessionFor(connection), "DELETE", `/${encodeURIComponent(connection.appId)}`);
    return true;
  } catch (error) {
    if (error instanceof CloudAccountsError && error.status === 404) return true;
    console.warn(`[Integrations] Deus Cloud did not disconnect ${connection.appId}:`, error);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Cloud turns: a capability instead of the session
// ---------------------------------------------------------------------------

/** A capability is reused while it has this long left, so a turn does not outlive it. */
const CAPABILITY_MIN_LIFE_MS = 4 * 60 * 60_000;

let capability: {
  accountId: string;
  /** The apps it was asked for, to tell when the set changed. */
  asked: string;
  apps: Set<string>;
  token: string;
  expiresAt: number;
} | null = null;

/**
 * Where a cloud turn's agent reaches the account's connected apps: each
 * app's MCP endpoint in Deus Cloud, with a capability that can call those
 * apps' tools for a few hours and nothing else. The Deus session never goes
 * to a sandbox. One capability serves every turn until the apps change or
 * it nears its end, so most turns start with no request at all. Apps that
 * are not connected in Deus Cloud are left out. Throws when Deus Cloud
 * cannot be asked.
 */
export async function cloudTurnServers(
  appIds: string[]
): Promise<Record<string, McpServerConfig & { type: "http" }>> {
  const session = currentAccountSession();
  if (!session || appIds.length === 0) return {};
  const asked = [...appIds].sort().join(",");
  const reusable =
    capability?.accountId === session.accountId &&
    capability.asked === asked &&
    capability.expiresAt - Date.now() > CAPABILITY_MIN_LIFE_MS;
  if (!reusable) {
    const minted = await cloud<{ apps: string[]; token: string | null; expires_at: string | null }>(
      session,
      "POST",
      "/capabilities",
      { apps: appIds }
    );
    capability =
      minted.token && minted.expires_at
        ? {
            accountId: session.accountId,
            asked,
            apps: new Set(minted.apps),
            token: minted.token,
            expiresAt: Date.parse(minted.expires_at),
          }
        : null;
  }
  const held = capability;
  if (!held) return {};
  return Object.fromEntries(
    appIds
      .filter((appId) => held.apps.has(appId))
      .map((appId) => [
        appId,
        {
          type: "http" as const,
          url: `${session.cloudUrl}/connections/${encodeURIComponent(appId)}/mcp`,
          headers: { Authorization: `Bearer ${held.token}` },
        },
      ])
  );
}

/** A connection changed: the next cloud turn asks for a capability again. */
export function forgetCloudTurnCapability(): void {
  capability = null;
}

// ---------------------------------------------------------------------------
// A sign-in under way: the address it returns to
// ---------------------------------------------------------------------------

const ATTEMPT_TTL_MS = 15 * 60_000;
const attempts = new Map<string, { connectionId: string; expiresAt: number }>();

/** An unguessable address for a sign-in to return to. The newest attempt wins. */
export function newCloudAttempt(connectionId: string): string {
  const now = Date.now();
  for (const [key, other] of attempts) {
    if (other.connectionId === connectionId || other.expiresAt <= now) attempts.delete(key);
  }
  const attempt = crypto.randomBytes(24).toString("base64url");
  attempts.set(attempt, { connectionId, expiresAt: now + ATTEMPT_TTL_MS });
  return attempt;
}

/** The connection a returning sign-in belongs to, or null when the link is old. */
export function cloudAttempt(attempt: string): string | null {
  const found = attempts.get(attempt);
  return found && found.expiresAt > Date.now() ? found.connectionId : null;
}

export function forgetCloudAttempts(connectionId: string): void {
  for (const [key, other] of attempts) {
    if (other.connectionId === connectionId) attempts.delete(key);
  }
}

/** @internal */
export function __resetCloudAccountsForTests(): void {
  attempts.clear();
  directory = null;
  capability = null;
}
