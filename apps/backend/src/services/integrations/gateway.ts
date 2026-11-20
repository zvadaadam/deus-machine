// backend/src/services/integrations/gateway.ts
// The one door an agent uses to reach an app that has an account.
//
// A turn's MCP config names only `http://127.0.0.1:<port>/api/integrations/mcp/<app>`
// and this process's gateway key. Each request the agent's MCP client makes
// arrives here; the gateway attaches the account's current credential and
// forwards it to the app's real server, streaming the answer back. So:
//
//  - A token that expires mid-turn is refreshed on the request that needs it
//    (one retry after a 401), not only when a turn starts.
//  - A turn start does no network work for apps, and a slow or dead token
//    endpoint can delay a tool call but never a turn.
//  - The agent's process and config files (Codex writes its MCP servers to
//    disk) never hold a provider's token.
//  - The config is the same every turn, so neither harness reconnects its
//    MCP servers because a token rotated.
//
// The same shape as the engine's API-key proxy (@zvada/agent-server/core/proxy),
// and the shape a cloud gateway takes for sandboxes. Local (stdio) servers and
// servers with no account are reached directly.

import crypto from "crypto";
import type { McpServerConfig } from "@zvada/agent-server/protocol";
import type { CatalogApp } from "@shared/integrations/types";
import { getErrorMessage } from "@shared/lib/errors";
import { findApp } from "./catalog";
import { credentialsFor } from "./credentials";
import { markNeedsReauth } from "./events";
import { getConnection, getInstallation } from "./store";

export const GATEWAY_PATH = "/api/integrations/mcp";

/** This process's key: a turn's config carries it, nothing persists it. */
const gatewayKey = crypto.randomBytes(32).toString("base64url");

let origin: string | null = null;

/** Called once the backend listens. Loopback by address: agents run on this computer. */
export function setGatewayPort(port: number): void {
  origin = `http://127.0.0.1:${port}`;
}

/**
 * Whether an app's requests go through the gateway: it has an account and a
 * remote server, its own or its broker's in Deus Cloud.
 */
export function usesGateway(app: CatalogApp): boolean {
  if (app.transport.type === "broker") return true;
  return app.transport.type === "http" && app.auth.kind !== "none";
}

/** The server a turn names for a gateway app, or null before the backend listens. */
export function gatewayServer(appId: string): McpServerConfig | null {
  if (!origin) return null;
  return {
    type: "http",
    url: `${origin}${GATEWAY_PATH}/${encodeURIComponent(appId)}`,
    headers: { Authorization: `Bearer ${gatewayKey}` },
    required: false,
  };
}

export function isGatewayKey(authorization: string | undefined): boolean {
  const given = Buffer.from(authorization?.replace(/^Bearer /i, "") ?? "");
  const wanted = Buffer.from(gatewayKey);
  return given.length === wanted.length && crypto.timingSafeEqual(given, wanted);
}

/** What of the agent's request goes upstream: MCP's own headers, never its gateway key. */
const REQUEST_HEADERS = [
  "accept",
  "content-type",
  "mcp-session-id",
  "mcp-protocol-version",
  "last-event-id",
];
const RESPONSE_HEADERS = ["content-type", "mcp-session-id", "cache-control"];

/**
 * Why an app cannot answer, in a form the agent can pass on. A JSON-RPC
 * request gets a JSON-RPC error (the model reads its message); anything else
 * a 503. Never a 401: an MCP client that sees one starts its own OAuth flow.
 */
function unavailable(body: ArrayBuffer | undefined, message: string): Response {
  let id: unknown;
  try {
    const parsed = body ? JSON.parse(Buffer.from(body).toString("utf8")) : null;
    if (parsed && !Array.isArray(parsed) && typeof parsed === "object") id = parsed.id;
  } catch {
    // Not JSON: answered as a plain 503 below.
  }
  if (id !== undefined && id !== null) {
    return Response.json({ jsonrpc: "2.0", id, error: { code: -32001, message } });
  }
  return new Response(message, { status: 503, headers: { "content-type": "text/plain" } });
}

function signInMessage(app: CatalogApp, reason: string): string {
  return `${app.name} is not connected (${reason}). Ask the user to open Deus → Customize → ${app.name} and connect it.`;
}

/**
 * Forward one MCP request to `appId`'s server with its account's credential.
 * The caller has already checked the gateway key.
 */
export async function proxyMcp(appId: string, request: Request): Promise<Response> {
  const body =
    request.method === "GET" || request.method === "HEAD" ? undefined : await request.arrayBuffer();
  const app = findApp(appId);
  const row = app ? getInstallation("app", app.id) : null;
  if (!app || !row || !row.enabled || !usesGateway(app)) {
    return unavailable(body, `${app?.name ?? appId} is not installed in Deus`);
  }

  const headers = new Headers();
  for (const name of REQUEST_HEADERS) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }

  // Once as we are; once more with a fresh credential if the server refuses it.
  for (const fresh of [false, true]) {
    const connection = row.connectionId ? getConnection(row.connectionId) : null;
    const credentials = await credentialsFor(app, connection, { fresh });
    if (!credentials.ok) {
      if (credentials.reauth && connection && connection.status === "active") {
        markNeedsReauth(connection.id, credentials.reason);
      }
      return unavailable(
        body,
        credentials.reauth
          ? signInMessage(app, credentials.reason)
          : `${app.name} could not be reached: ${credentials.reason}`
      );
    }
    // Deus Cloud when it holds the account, else the app's own server.
    const { cloud } = credentials;
    const url = cloud?.url ?? (app.transport.type === "http" ? app.transport.url : null);
    if (!url) return unavailable(body, signInMessage(app, "Not connected"));
    for (const [name, value] of Object.entries({ ...cloud?.headers, ...credentials.headers })) {
      headers.set(name, value);
    }

    let upstream: Response;
    try {
      upstream = await fetch(url, {
        method: request.method,
        headers,
        body,
        signal: request.signal,
      });
    } catch (error) {
      if (request.signal.aborted) return new Response(null, { status: 499 });
      return unavailable(body, `${app.name} could not be reached: ${getErrorMessage(error)}`);
    }

    if (upstream.status !== 401) {
      const answer = new Headers();
      for (const name of RESPONSE_HEADERS) {
        const value = upstream.headers.get(name);
        if (value) answer.set(name, value);
      }
      return new Response(upstream.body, { status: upstream.status, headers: answer });
    }

    await upstream.body?.cancel().catch(() => {});
    if (cloud) {
      // Deus Cloud refused the Deus session, not the app's account: the
      // person signs in to Deus again, and the app's own sign-in still stands.
      return unavailable(
        body,
        `${app.name} could not be reached: the Deus sign-in has expired. Ask the user to sign in to Deus again.`
      );
    }
    if (fresh) {
      const reason = "its server refused the saved sign-in";
      if (connection) markNeedsReauth(connection.id, reason);
      return unavailable(body, signInMessage(app, reason));
    }
  }
  return unavailable(body, `${app.name} could not be reached`);
}

/** @internal */
export function __gatewayKeyForTests(): string {
  return gatewayKey;
}
