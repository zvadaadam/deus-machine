// A real local server playing both parts a remote app has: an authorization
// server (metadata, dynamic client registration, a PKCE-checking token
// endpoint whose refresh tokens rotate) and a protected MCP endpoint (the
// SDK's own server) that answers only a currently valid access token.

import crypto from "crypto";
import http from "http";
import type { AddressInfo } from "net";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

export interface Provider {
  base: string;
  clients: Map<string, { redirect_uris: string[] }>;
  accessTokens: Set<string>;
  refreshTokens: Set<string>;
  refreshCalls: number;
  /** Lifetime of the next tokens issued, in seconds. */
  nextExpiresIn: number;
  /** How the token endpoint answers a refresh, when not properly. */
  refreshAnswer: "ok" | "invalid_request" | "error_in_200" | "unavailable";
  /** The `Authorization` header of each request the MCP endpoint received. */
  seenAuthorization: string[];
  /** Tool calls the MCP endpoint served. */
  calls: string[];
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

export async function startProvider(): Promise<Provider> {
  const codes = new Map<string, { clientId: string; challenge: string; redirectUri: string }>();
  let issued = 0;
  const provider: Provider = {
    base: "",
    clients: new Map(),
    accessTokens: new Set(),
    refreshTokens: new Set(),
    refreshCalls: 0,
    nextExpiresIn: 3600,
    refreshAnswer: "ok",
    seenAuthorization: [],
    calls: [],
    reset() {
      provider.clients.clear();
      codes.clear();
      provider.accessTokens.clear();
      provider.refreshTokens.clear();
      provider.refreshCalls = 0;
      provider.nextExpiresIn = 3600;
      provider.refreshAnswer = "ok";
      provider.seenAuthorization = [];
      provider.calls = [];
      issued = 0;
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };

  function issueTokens() {
    issued += 1;
    const access = `access-${issued}`;
    const refresh = `refresh-${issued}`;
    provider.accessTokens.add(access);
    provider.refreshTokens.add(refresh);
    return {
      access_token: access,
      refresh_token: refresh,
      token_type: "Bearer",
      expires_in: provider.nextExpiresIn,
    };
  }

  async function handle(req: http.IncomingMessage, res: http.ServerResponse) {
    const url = new URL(req.url ?? "/", provider.base);
    if (url.pathname.startsWith("/.well-known/oauth-protected-resource")) {
      return json(res, 200, {
        resource: `${provider.base}/mcp`,
        authorization_servers: [provider.base],
      });
    }
    if (url.pathname === "/.well-known/oauth-authorization-server") {
      return json(res, 200, {
        issuer: provider.base,
        authorization_endpoint: `${provider.base}/authorize`,
        token_endpoint: `${provider.base}/token`,
        registration_endpoint: `${provider.base}/register`,
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["none"],
      });
    }
    if (url.pathname === "/register" && req.method === "POST") {
      const metadata = JSON.parse(await readBody(req));
      const clientId = `client-${provider.clients.size + 1}`;
      provider.clients.set(clientId, { redirect_uris: metadata.redirect_uris });
      return json(res, 201, { ...metadata, client_id: clientId });
    }
    if (url.pathname === "/authorize") {
      // The user approves at once: redirect back with a code.
      const clientId = url.searchParams.get("client_id")!;
      const redirectUri = url.searchParams.get("redirect_uri")!;
      if (!provider.clients.get(clientId)?.redirect_uris.includes(redirectUri)) {
        return json(res, 400, { error: "invalid_redirect_uri" });
      }
      if (url.searchParams.get("code_challenge_method") !== "S256") {
        return json(res, 400, { error: "pkce_required" });
      }
      const code = crypto.randomBytes(8).toString("hex");
      codes.set(code, {
        clientId,
        challenge: url.searchParams.get("code_challenge")!,
        redirectUri,
      });
      const back = new URL(redirectUri);
      back.searchParams.set("code", code);
      back.searchParams.set("state", url.searchParams.get("state")!);
      res.writeHead(302, { Location: back.toString() });
      return res.end();
    }
    if (url.pathname === "/token" && req.method === "POST") {
      const form = new URLSearchParams(await readBody(req));
      if (form.get("grant_type") === "authorization_code") {
        const grant = codes.get(form.get("code") ?? "");
        codes.delete(form.get("code") ?? "");
        const verifier = form.get("code_verifier") ?? "";
        const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
        if (
          !grant ||
          grant.challenge !== challenge ||
          grant.redirectUri !== form.get("redirect_uri") ||
          grant.clientId !== form.get("client_id")
        ) {
          return json(res, 400, { error: "invalid_grant" });
        }
        return json(res, 200, issueTokens());
      }
      if (form.get("grant_type") === "refresh_token") {
        provider.refreshCalls += 1;
        // Real token endpoints do not all say `invalid_grant`.
        if (provider.refreshAnswer === "invalid_request") {
          return json(res, 400, { error: "invalid_request", error_description: "Token expired" });
        }
        if (provider.refreshAnswer === "error_in_200") {
          return json(res, 200, { error: "invalid_grant" });
        }
        if (provider.refreshAnswer === "unavailable") {
          return json(res, 503, { error: "temporarily_unavailable" });
        }
        const token = form.get("refresh_token") ?? "";
        // Rotation: a refresh token works once.
        if (!provider.refreshTokens.delete(token)) {
          return json(res, 400, { error: "invalid_grant" });
        }
        await new Promise((r) => setTimeout(r, 30));
        return json(res, 200, issueTokens());
      }
      return json(res, 400, { error: "unsupported_grant_type" });
    }
    if (url.pathname === "/mcp") {
      provider.seenAuthorization.push(req.headers.authorization ?? "");
      const token = req.headers.authorization?.replace(/^Bearer /, "");
      if (!token || !provider.accessTokens.has(token)) {
        res.writeHead(401, {
          "WWW-Authenticate": `Bearer resource_metadata="${provider.base}/.well-known/oauth-protected-resource/mcp"`,
        });
        return res.end();
      }
      const server = new McpServer({ name: "acme", version: "1.0.0" });
      server.registerTool(
        "list_issues",
        { description: "List issues", annotations: { readOnlyHint: true } },
        async () => {
          provider.calls.push("list_issues");
          return { content: [{ type: "text", text: "[]" }] };
        }
      );
      server.registerTool("create_issue", { description: "Create an issue" }, async () => {
        provider.calls.push("create_issue");
        return { content: [{ type: "text", text: "created" }] };
      });
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on("close", () => {
        void transport.close();
        void server.close();
      });
      await server.connect(transport);
      const body = req.method === "POST" ? JSON.parse((await readBody(req)) || "null") : undefined;
      return transport.handleRequest(req, res, body);
    }
    json(res, 404, { error: "not_found" });
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((error) => json(res, 500, { error: String(error) }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  provider.base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return provider;
}
