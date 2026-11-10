// A local server standing in for Deus Cloud's `/me/connections` (AGNT
// `apps/deus-cloud`): it knows accounts by their session, connects apps on a
// sign-in page of its own, and serves a connected app's tools from an MCP
// endpoint. What it holds behind that (Composio, its key) is its business;
// this computer never sees it.

import http from "http";
import type { AddressInfo } from "net";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

interface Connection {
  appId: string;
  toolkit: string;
  tools?: string[];
  status: "pending" | "active";
  callbackUrl: string;
  linkId: string;
}

export interface FakeDeusCloud {
  base: string;
  /** Toolkits this deployment connects. */
  toolkits: string[];
  /** False: the deployment has app connections switched off (503). */
  configured: boolean;
  /** False: a deployment from before app connections existed (404 on every route). */
  deployed: boolean;
  /** Sessions Deus Cloud no longer accepts (expired, signed out elsewhere). */
  revokedSessions: Set<string>;
  /** HTTP methods that answer 502 for now (an outage, a proxy between). */
  failing: Set<string>;
  /** How long a disconnect takes to be heard. */
  deleteDelayMs: number;
  /** account id → app id → connection. */
  accounts: Map<string, Map<string, Connection>>;
  /** Every request to `/me/connections*`: method, path, headers. */
  requests: Array<{ method: string; path: string; headers: http.IncomingHttpHeaders }>;
  /** Tool calls served: `<account>:<app>:<tool>`. */
  calls: string[];
  /** Capabilities minted for cloud turns: the apps each was asked for. */
  capabilities: string[][];
  /** A session token for an account, shaped like the real one (`sub` in its payload). */
  session(accountId: string): string;
  /** Connect an app for an account as another computer would have. */
  connected(accountId: string, appId: string, toolkit: string): void;
  reset(): void;
  close(): Promise<void>;
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => resolve(body));
  });
}

function json(res: http.ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

const wire = (c: Connection) => ({
  app_id: c.appId,
  provider: "composio",
  toolkit: c.toolkit,
  status: c.status,
});

export async function startFakeDeusCloud(): Promise<FakeDeusCloud> {
  let counter = 0;
  const cloud: FakeDeusCloud = {
    base: "",
    toolkits: [],
    configured: true,
    deployed: true,
    revokedSessions: new Set(),
    failing: new Set(),
    deleteDelayMs: 0,
    accounts: new Map(),
    requests: [],
    calls: [],
    capabilities: [],
    session: (accountId) =>
      `e30.${Buffer.from(JSON.stringify({ sub: accountId })).toString("base64url")}.signature`,
    connected(accountId, appId, toolkit) {
      const mine = cloud.accounts.get(accountId) ?? new Map<string, Connection>();
      cloud.accounts.set(accountId, mine);
      mine.set(appId, { appId, toolkit, status: "active", callbackUrl: "", linkId: "elsewhere" });
    },
    reset() {
      cloud.toolkits = ["instagram", "slack"];
      cloud.configured = true;
      cloud.deployed = true;
      cloud.revokedSessions.clear();
      cloud.failing.clear();
      cloud.deleteDelayMs = 0;
      cloud.accounts.clear();
      cloud.requests = [];
      cloud.calls = [];
      cloud.capabilities = [];
      counter = 0;
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };

  function accountOf(req: http.IncomingMessage): string | null {
    const token = req.headers.authorization?.replace(/^Bearer /, "") ?? "";
    if (!token || cloud.revokedSessions.has(token)) return null;
    try {
      const claims = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString());
      return typeof claims.sub === "string" ? claims.sub : null;
    } catch {
      return null;
    }
  }

  async function handle(req: http.IncomingMessage, res: http.ServerResponse) {
    const url = new URL(req.url ?? "/", cloud.base);
    const path = url.pathname;
    if (cloud.failing.has(req.method ?? "")) return json(res, 502, { error: "BAD_GATEWAY" });

    // The broker's hosted sign-in page: the person approves and is sent back.
    const link = path.match(/^\/link\/(.+)$/);
    if (link) {
      for (const mine of cloud.accounts.values()) {
        for (const connection of mine.values()) {
          if (connection.linkId !== link[1]) continue;
          if (url.searchParams.get("approve") !== "no") connection.status = "active";
          const back = new URL(connection.callbackUrl);
          back.searchParams.set("status", connection.status === "active" ? "success" : "failed");
          res.writeHead(302, { Location: back.toString() });
          return res.end();
        }
      }
      return json(res, 404, { error: "NOT_FOUND", message: "No such sign-in" });
    }

    if (!path.startsWith("/me/connections")) return json(res, 404, { error: "NOT_FOUND" });
    cloud.requests.push({ method: req.method ?? "GET", path, headers: req.headers });
    const accountId = accountOf(req);
    if (!accountId) return json(res, 401, { error: "UNAUTHORIZED", message: "Invalid session" });
    if (!cloud.deployed) return json(res, 404, { error: "NOT_FOUND", message: "Not found" });
    if (!cloud.configured) {
      return json(res, 503, { error: "NOT_CONFIGURED", message: "Not configured yet." });
    }
    const mine = cloud.accounts.get(accountId) ?? new Map<string, Connection>();
    cloud.accounts.set(accountId, mine);

    if (path === "/me/connections" && req.method === "GET") {
      return json(res, 200, {
        providers: [{ id: "composio", label: "Composio", toolkits: cloud.toolkits }],
        items: [...mine.values()].map(wire),
      });
    }

    const mcp = path.match(/^\/me\/connections\/([^/]+)\/mcp$/);
    if (mcp) {
      const connection = mine.get(mcp[1]!);
      const raw = req.method === "POST" ? await readBody(req) : "";
      const sent = raw ? JSON.parse(raw) : null;
      if (connection?.status !== "active") {
        const message = "This app is not connected. Ask the user to open Deus → Customize.";
        return sent?.id === undefined
          ? json(res, 409, { error: "NOT_CONNECTED", message })
          : json(res, 200, { jsonrpc: "2.0", id: sent.id, error: { code: -32001, message } });
      }
      const tool = `${connection.toolkit.toUpperCase()}_CREATE_POST`;
      const mcpServer = new McpServer({ name: "deus-cloud", version: "1.0.0" });
      mcpServer.registerTool(tool, { description: "Publish a post" }, async () => {
        cloud.calls.push(`${accountId}:${connection.appId}:${tool}`);
        return { content: [{ type: "text", text: "posted" }] };
      });
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on("close", () => {
        void transport.close();
        void mcpServer.close();
      });
      await mcpServer.connect(transport);
      return transport.handleRequest(req, res, req.method === "POST" ? sent : undefined);
    }

    if (path === "/me/connections/capabilities" && req.method === "POST") {
      const asked: string[] = JSON.parse((await readBody(req)) || "{}").apps ?? [];
      cloud.capabilities.push(asked);
      const apps = asked.filter((appId) => mine.get(appId)?.status === "active");
      return json(
        res,
        200,
        apps.length
          ? {
              apps,
              token: `capability-${cloud.capabilities.length}-for-${accountId}`,
              expires_at: new Date(Date.now() + 8 * 60 * 60_000).toISOString(),
            }
          : { apps, token: null, expires_at: null }
      );
    }

    const one = path.match(/^\/me\/connections\/([^/]+)$/);
    if (!one) return json(res, 404, { error: "NOT_FOUND" });
    const appId = one[1]!;
    const existing = mine.get(appId);
    if (req.method === "GET") {
      return existing
        ? json(res, 200, { connection: wire(existing) })
        : json(res, 404, { error: "NOT_FOUND", message: "This app is not connected." });
    }
    if (req.method === "DELETE") {
      if (cloud.deleteDelayMs) await new Promise((next) => setTimeout(next, cloud.deleteDelayMs));
      return mine.delete(appId)
        ? json(res, 200, { ok: true })
        : json(res, 404, { error: "NOT_FOUND", message: "This app is not connected." });
    }
    if (req.method === "POST") {
      const body = JSON.parse((await readBody(req)) || "null");
      if (!cloud.toolkits.includes(body?.toolkit) || typeof body.callback_url !== "string") {
        return json(res, 400, {
          error: "INVALID_REQUEST",
          message: "Name an app this version of Deus can connect.",
        });
      }
      if (existing?.status === "active" && existing.toolkit === body.toolkit) {
        return json(res, 200, { status: "connected", connection: wire(existing) });
      }
      const connection: Connection = {
        appId,
        toolkit: body.toolkit,
        ...(body.tools ? { tools: body.tools } : {}),
        status: "pending",
        callbackUrl: body.callback_url,
        linkId: `link-${++counter}`,
      };
      mine.set(appId, connection);
      return json(res, 201, {
        status: "redirect",
        url: `${cloud.base}/link/${connection.linkId}`,
        connection: wire(connection),
      });
    }
    json(res, 405, { error: "METHOD_NOT_ALLOWED" });
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((error) => json(res, 500, { error: String(error) }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cloud.base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  cloud.reset();
  return cloud;
}
