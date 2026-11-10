// The gateway end to end, over real HTTP: an MCP client (as an agent's
// harness has) → this backend's gateway route → a provider whose tokens
// expire, rotate and get revoked. The agent's side only ever holds the
// gateway address and this process's key.

import { serve } from "@hono/node-server";
import { Hono } from "hono";
import type { AddressInfo } from "net";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { memoryDatabase, scratchDir } from "./fixtures";
import { startProvider, type Provider } from "./provider";

const state = vi.hoisted(() => ({ db: null as Database.Database | null, dir: "", mcpUrl: "" }));

vi.mock("../../../../src/lib/database", () => ({
  getDatabase: () => state.db,
  get DB_PATH() {
    return `${state.dir}/deus.db`;
  },
}));
vi.mock("../../../../src/services/query-engine", () => ({ invalidate: () => {} }));
vi.mock("../../../../src/services/gh.service", () => ({ runGh: async () => ({ success: false }) }));
vi.mock("@shared/integrations/catalog", () => ({
  get CATALOG() {
    return {
      version: "test",
      apps: [
        {
          id: "acme",
          name: "Acme",
          publisher: "Acme",
          official: true,
          description: "Acme issues",
          categories: ["developer"],
          transport: { type: "http", url: state.mcpUrl },
          auth: { kind: "oauth" },
          local: false,
        },
      ],
      skills: [],
      plugins: [],
    };
  },
}));

import { composeSnapshot } from "@shared/integrations/compose";
import { CATALOG } from "@shared/integrations/catalog";
import integrationRoutes from "../../../../src/routes/integrations";
import {
  getState,
  resolveTurnApps,
  startIntegrations,
} from "../../../../src/services/integrations";
import {
  completeOAuthCallback,
  connectApp,
  setAppEnabled,
} from "../../../../src/services/integrations/apps";
import { settleChecks } from "../../../../src/services/integrations/checks";
import { __resetOAuthForTests } from "../../../../src/services/integrations/auth/mcp-oauth";
import { __resetVaultKeyForTests } from "../../../../src/services/integrations/vault";

let provider: Provider;
let backend: ReturnType<typeof serve>;
let port: number;

beforeAll(async () => {
  provider = await startProvider();
  const app = new Hono();
  app.route("/api", integrationRoutes);
  await new Promise<void>((resolve) => {
    backend = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" }, () => resolve());
  });
  port = (backend.address() as AddressInfo).port;
});

afterAll(async () => {
  await provider.close();
  await new Promise<void>((resolve) => backend.close(() => resolve()));
});

beforeEach(() => {
  state.db = memoryDatabase();
  state.dir = scratchDir("deus-gateway-");
  state.mcpUrl = `${provider.base}/mcp`;
  process.env.DEUS_VAULT_KEY = "33".repeat(32);
  __resetVaultKeyForTests();
  __resetOAuthForTests();
  startIntegrations(port);
  provider.reset();
});

afterEach(async () => {
  await settleChecks();
  state.db?.close();
  vi.restoreAllMocks();
});

async function signIn(): Promise<void> {
  const result = await connectApp({ appId: "acme" });
  if (result.status !== "redirect") throw new Error("expected a sign-in page");
  const response = await fetch(result.url, { redirect: "manual" });
  await completeOAuthCallback(new URL(response.headers.get("location")!).searchParams);
  await settleChecks();
  provider.seenAuthorization = [];
}

/** An MCP client configured exactly as a turn's config says. */
async function agentClient(): Promise<Client> {
  const { servers } = await resolveTurnApps();
  const server = servers.acme;
  if (!server || server.type !== "http") throw new Error("acme is not in the turn");
  const client = new Client({ name: "agent", version: "1.0.0" }, { capabilities: {} });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(server.url), {
      requestInit: { headers: server.headers },
    })
  );
  return client;
}

const text = (result: unknown) =>
  (result as { content: Array<{ text: string }> }).content.map((part) => part.text).join("");
const acme = () => composeSnapshot(CATALOG, getState()).apps.find((v) => v.app.id === "acme")!;

describe("the gateway", () => {
  it("a turn's config holds the gateway and its key, never the account's token", async () => {
    await signIn();
    const { servers } = await resolveTurnApps();
    expect(servers.acme).toMatchObject({
      type: "http",
      url: `http://127.0.0.1:${port}/api/integrations/mcp/acme`,
      required: false,
    });
    expect(JSON.stringify(servers)).not.toContain("access-1");
    expect(JSON.stringify(servers)).not.toContain(provider.base);
  });

  it("an agent lists and calls the app's tools through it, with the account's token attached", async () => {
    await signIn();
    const client = await agentClient();
    expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual([
      "list_issues",
      "create_issue",
    ]);
    expect(text(await client.callTool({ name: "create_issue", arguments: {} }))).toBe("created");
    expect(provider.calls).toEqual(["create_issue"]);
    expect(new Set(provider.seenAuthorization)).toEqual(new Set(["Bearer access-1"]));
    await client.close();
  });

  it("a token that expires mid-turn is refreshed on the call that needs it", async () => {
    await signIn();
    const client = await agentClient();
    await client.listTools();
    const now = Date.now();
    // The turn has run for an hour: the token it started with is gone.
    vi.spyOn(Date, "now").mockReturnValue(now + 3_590_000);
    expect(text(await client.callTool({ name: "create_issue", arguments: {} }))).toBe("created");
    expect(provider.refreshCalls).toBe(1);
    expect(provider.seenAuthorization.at(-1)).toBe("Bearer access-2");
    await client.close();
  });

  it("a token the server stops accepting is replaced once and the call retried", async () => {
    await signIn();
    const client = await agentClient();
    await client.listTools();
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now + 60_000);
    provider.accessTokens.clear(); // revoked early; the refresh token still stands
    expect(text(await client.callTool({ name: "create_issue", arguments: {} }))).toBe("created");
    expect(provider.refreshCalls).toBe(1);
    await client.close();
  });

  it("many calls at once on an expiring token refresh it once", async () => {
    await signIn();
    const client = await agentClient();
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now + 3_590_000);
    const results = await Promise.all(
      Array.from({ length: 6 }, () => client.callTool({ name: "list_issues", arguments: {} }))
    );
    expect(results.map(text)).toEqual(Array(6).fill("[]"));
    expect(provider.refreshCalls).toBe(1);
    await client.close();
  });

  it("a revoked account tells the agent what the user must do, and the app shows it", async () => {
    await signIn();
    const client = await agentClient();
    await client.listTools();
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now + 60_000);
    provider.accessTokens.clear();
    provider.refreshTokens.clear();
    await expect(client.callTool({ name: "create_issue", arguments: {} })).rejects.toThrow(
      /Acme is not connected.*Customize/
    );
    expect(acme().readiness).toBe("needs_reauth");
    // The next turn leaves it out instead of offering tools that cannot work.
    expect((await resolveTurnApps()).servers.acme).toBeUndefined();
    await client.close().catch(() => {});
  });

  it("an app switched off mid-turn stops answering", async () => {
    await signIn();
    const client = await agentClient();
    await client.listTools();
    setAppEnabled("acme", false);
    await expect(client.callTool({ name: "create_issue", arguments: {} })).rejects.toThrow(
      /not installed/
    );
    await client.close().catch(() => {});
  });

  it("refuses a caller without this process's key", async () => {
    await signIn();
    const url = `http://127.0.0.1:${port}/api/integrations/mcp/acme`;
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    const headers = { "content-type": "application/json", accept: "application/json" };
    expect((await fetch(url, { method: "POST", headers, body })).status).toBe(403);
    expect(
      (
        await fetch(url, {
          method: "POST",
          headers: { ...headers, authorization: "Bearer nope" },
          body,
        })
      ).status
    ).toBe(403);
    expect(provider.seenAuthorization).toEqual([]);
  });
});
