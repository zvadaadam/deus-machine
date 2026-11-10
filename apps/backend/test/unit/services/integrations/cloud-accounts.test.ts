// Apps that connect through the person's Deus account, end to end over real
// HTTP: the real client against a server that behaves like Deus Cloud, the
// real callback route, and an MCP client reaching the tools through the
// gateway the way an agent's harness does.

import fs from "fs";
import path from "path";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import type { AddressInfo } from "net";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { memoryDatabase, scratchDir } from "./fixtures";
import { startFakeDeusCloud, type FakeDeusCloud } from "./deus-cloud";

const state = vi.hoisted(() => ({ db: null as Database.Database | null, dir: "" }));

vi.mock("../../../../src/lib/database", () => ({
  getDatabase: () => state.db,
  get DB_PATH() {
    return `${state.dir}/deus.db`;
  },
}));
vi.mock("../../../../src/services/query-engine", () => ({ invalidate: () => {} }));
vi.mock("../../../../src/services/gh.service", () => ({ runGh: async () => ({ success: false }) }));
vi.mock("@shared/integrations/catalog", async () => {
  const { testCatalog } = await import("./fixtures");
  return { CATALOG: testCatalog() };
});

import { composeSnapshot } from "@shared/integrations/compose";
import { CATALOG } from "@shared/integrations/catalog";
import integrationRoutes from "../../../../src/routes/integrations";
import {
  resetCloudConfigForTests,
  setCloudRuntimeCredentials,
} from "../../../../src/services/agent/cloud/config";
import {
  getState,
  reconcileCloudAccounts,
  resolveCloudTurnExtensions,
  resolveTurnApps,
  startIntegrations,
} from "../../../../src/services/integrations";
import {
  connectApp,
  disconnectApp,
  installApp,
  setAppEnabled,
  uninstallApp,
} from "../../../../src/services/integrations/apps";
import { checkApp, settleChecks } from "../../../../src/services/integrations/checks";
import { markNeedsReauth } from "../../../../src/services/integrations/events";
import {
  completeCloudCallback,
  __setCallbackSettleForTests,
  settleCloudAccounts,
} from "../../../../src/services/integrations/cloud-apps";
import { __resetCloudAccountsForTests } from "../../../../src/services/integrations/auth/cloud-accounts";
import { __resetOAuthForTests } from "../../../../src/services/integrations/auth/mcp-oauth";
import { __gatewayKeyForTests } from "../../../../src/services/integrations/gateway";
import { listConnections } from "../../../../src/services/integrations/store";
import { __resetVaultKeyForTests } from "../../../../src/services/integrations/vault";

let cloud: FakeDeusCloud;
let backend: ReturnType<typeof serve>;
let port: number;

beforeAll(async () => {
  cloud = await startFakeDeusCloud();
  const app = new Hono();
  app.route("/api", integrationRoutes);
  await new Promise<void>((resolve) => {
    backend = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" }, () => resolve());
  });
  port = (backend.address() as AddressInfo).port;
});

afterAll(async () => {
  await cloud.close();
  await new Promise<void>((resolve) => backend.close(() => resolve()));
});

beforeEach(async () => {
  state.db = memoryDatabase();
  state.dir = scratchDir("deus-cloud-accounts-");
  process.env.DEUS_VAULT_KEY = "44".repeat(32);
  delete process.env.DEUS_OAUTH_CLIENTS;
  __resetVaultKeyForTests();
  __resetOAuthForTests();
  __resetCloudAccountsForTests();
  __setCallbackSettleForTests(5);
  resetCloudConfigForTests();
  cloud.reset();
  await startIntegrations(port);
  await settle();
});

afterEach(async () => {
  await settle();
  resetCloudConfigForTests();
  state.db?.close();
  vi.restoreAllMocks();
});

/** What the desktop does when the Deus account signs in, renews, switches or signs out. */
async function deusAccount(accountId: string | null): Promise<void> {
  setCloudRuntimeCredentials({
    deusCloudUrl: cloud.base,
    deusCloudSessionToken: accountId ? cloud.session(accountId) : null,
  });
  await reconcileCloudAccounts();
  await settleChecks();
}

/** Checks and background calls to Deus Cloud (a disconnect) have landed. */
async function settle(): Promise<void> {
  await settleCloudAccounts();
  await settleChecks();
  await new Promise((resolve) => setTimeout(resolve, 25));
}

const view = (id: string) =>
  composeSnapshot(CATALOG, getState()).apps.find((v) => v.app.id === id)!;
const text = (result: unknown) =>
  (result as { content: Array<{ text: string }> }).content.map((part) => part.text).join("");

/** Click Connect: the page Deus would open in the browser. */
async function startSignIn(appId: string): Promise<string> {
  const result = await connectApp({ appId });
  if (result.status !== "redirect") throw new Error("expected a sign-in page");
  return result.url;
}

/** The person approves on the sign-in page; the browser follows it back to Deus. */
async function approve(signInUrl: string): Promise<Response> {
  const page = await fetch(signInUrl, { redirect: "manual" });
  return fetch(page.headers.get("location")!);
}

async function signIn(appId: string): Promise<void> {
  const back = await approve(await startSignIn(appId));
  expect(back.status).toBe(200);
  await settleChecks();
}

/** An MCP client configured exactly as a turn's config says. */
async function agentClient(appId: string): Promise<Client> {
  const server = (await resolveTurnApps()).servers[appId];
  if (!server || server.type !== "http") throw new Error(`${appId} is not in the turn`);
  const client = new Client({ name: "agent", version: "1.0.0" }, { capabilities: {} });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(server.url), {
      requestInit: { headers: server.headers },
    })
  );
  return client;
}

describe("an app that connects through the Deus account", () => {
  it("needs someone signed in to Deus", async () => {
    expect(view("instagram")).toMatchObject({
      available: false,
      unavailable: "account",
      via: null,
    });
    await expect(connectApp({ appId: "instagram" })).rejects.toThrow(
      "Sign in to your Deus account to connect Instagram"
    );
    expect(view("instagram").installed).toBe(false);

    await deusAccount("alice");
    expect(view("instagram")).toMatchObject({
      available: true,
      unavailable: null,
      via: "Composio",
    });
    expect(getState().brokered).toEqual({ instagram: "Composio", slack: "Composio" });
  });

  it("is coming soon where Deus Cloud does not serve it", async () => {
    cloud.toolkits = ["slack"];
    await deusAccount("alice");
    expect(view("instagram")).toMatchObject({ available: false, unavailable: "soon" });
    expect(view("slack")).toMatchObject({ available: true, via: "Composio" });
    await expect(connectApp({ appId: "instagram" })).rejects.toThrow(/coming soon/);

    // A deployment with app connections switched off serves nothing.
    cloud.configured = false;
    await deusAccount("bob");
    expect(view("slack")).toMatchObject({ available: false, unavailable: "soon" });
    // Nor does a Deus Cloud from before it had them (this app released first).
    cloud.configured = true;
    cloud.deployed = false;
    await deusAccount("carol");
    expect(view("slack")).toMatchObject({ available: false, unavailable: "soon" });
  });

  it("connects on the sign-in page, and the agent reaches its tools through the gateway", async () => {
    await deusAccount("alice");
    const url = await startSignIn("instagram");
    expect(url).toMatch(new RegExp(`^${cloud.base}/link/`));
    expect(view("instagram").readiness).toBe("needs_connection");
    expect((await resolveTurnApps()).servers.instagram).toBeUndefined();
    // Deus Cloud was told which toolkit, and to come back to this computer.
    const started = cloud.accounts.get("alice")!.get("instagram")!;
    expect(started).toMatchObject({ toolkit: "instagram", status: "pending" });
    expect(started.callbackUrl).toMatch(
      new RegExp(`^http://localhost:${port}/api/integrations/oauth/callback/[\\w-]{32}$`)
    );

    const back = await approve(url);
    expect(await back.text()).toContain("Instagram is connected");
    await settleChecks();
    expect(view("instagram")).toMatchObject({ readiness: "ready", toolCount: 1 });

    // The turn names the gateway; nothing of Deus Cloud or the Deus session is in it.
    const turn = await resolveTurnApps();
    expect(turn.servers.instagram).toMatchObject({
      type: "http",
      url: `http://127.0.0.1:${port}/api/integrations/mcp/instagram`,
      required: false,
    });
    expect(JSON.stringify(turn)).not.toContain(cloud.session("alice"));
    expect(JSON.stringify(turn)).not.toContain(cloud.base);

    cloud.requests = [];
    const client = await agentClient("instagram");
    expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual([
      "INSTAGRAM_CREATE_POST",
    ]);
    expect(text(await client.callTool({ name: "INSTAGRAM_CREATE_POST", arguments: {} }))).toBe(
      "posted"
    );
    await client.close();
    expect(cloud.calls).toEqual(["alice:instagram:INSTAGRAM_CREATE_POST"]);
    // Deus Cloud saw the Deus session from the gateway, never the agent's gateway key.
    expect(cloud.requests.length).toBeGreaterThan(0);
    for (const request of cloud.requests) {
      expect(request.path).toBe("/me/connections/instagram/mcp");
      expect(request.headers.authorization).toBe(`Bearer ${cloud.session("alice")}`);
      expect(JSON.stringify(request.headers)).not.toContain(__gatewayKeyForTests());
    }
  });

  it("keeps no credential on this computer for it", async () => {
    await deusAccount("alice");
    await signIn("instagram");
    const rows = state
      .db!.prepare("SELECT kind, deus_account_id, credential FROM integration_connections")
      .all();
    expect(rows).toEqual([{ kind: "managed", deus_account_id: "alice", credential: null }]);
    // And what the app's UI reads does not name the account.
    expect(JSON.stringify(getState())).not.toContain("alice");
  });

  it("the page that returns proves nothing: Deus Cloud is asked", async () => {
    await deusAccount("alice");
    const url = await startSignIn("instagram");
    // The person backs out; the page still sends the browser back.
    const refused = await fetch(`${url}?approve=no`, { redirect: "manual" });
    const callback = refused.headers.get("location")!;
    const back = await fetch(callback.replace("status=failed", "status=success"));
    expect(back.status).toBe(400);
    expect(await back.text()).toContain("not finished");
    expect(view("instagram").readiness).toBe("needs_connection");

    const unknown = await fetch(
      `http://127.0.0.1:${port}/api/integrations/oauth/callback/${"x".repeat(32)}`
    );
    expect(unknown.status).toBe(400);
    expect(await unknown.text()).toContain("expired");
  });

  it("a sign-in that finished in a closed tab is picked up by the next click", async () => {
    await deusAccount("alice");
    const url = await startSignIn("instagram");
    await fetch(url, { redirect: "manual" }); // approved; the browser never came back
    expect(view("instagram").readiness).toBe("needs_connection");
    expect(await connectApp({ appId: "instagram" })).toEqual({ status: "connected" });
    await settleChecks();
    expect(view("instagram").readiness).toBe("ready");
    expect(listConnections("instagram")).toHaveLength(1);
  });

  it("a second click reuses the attempt instead of piling up rows", async () => {
    await deusAccount("alice");
    await startSignIn("instagram");
    const second = await startSignIn("instagram");
    expect(listConnections("instagram")).toHaveLength(1);
    expect((await approve(second)).status).toBe(200);
  });

  it("signing out of the app, or removing it, disconnects the account in Deus Cloud", async () => {
    await deusAccount("alice");
    await signIn("instagram");
    disconnectApp("instagram");
    await settle();
    expect(cloud.accounts.get("alice")!.has("instagram")).toBe(false);
    expect(view("instagram")).toMatchObject({ installed: true, readiness: "needs_connection" });

    await signIn("instagram");
    uninstallApp("instagram");
    await settle();
    expect(cloud.accounts.get("alice")!.has("instagram")).toBe(false);
    expect(listConnections("instagram")).toHaveLength(0);
  });

  it("a disconnect Deus Cloud did not hear stays owed, and is asked again", async () => {
    await deusAccount("alice");
    await signIn("instagram");
    cloud.failing.add("DELETE");
    disconnectApp("instagram");
    await settle();
    // The app is signed out here; the account is still in Deus Cloud, so the row waits.
    expect(view("instagram")).toMatchObject({ installed: true, readiness: "needs_connection" });
    expect(cloud.accounts.get("alice")!.has("instagram")).toBe(true);
    expect(listConnections("instagram").map((c) => c.status)).toEqual(["removing"]);

    // A pass that still cannot disconnect it does not take the account back
    // as one connected on another computer.
    await deusAccount("alice");
    expect(view("instagram").readiness).toBe("needs_connection");
    expect(listConnections("instagram").map((c) => c.status)).toEqual(["removing"]);

    cloud.failing.clear();
    await deusAccount("alice");
    expect(cloud.accounts.get("alice")!.has("instagram")).toBe(false);
    expect(listConnections("instagram")).toHaveLength(0);
    expect(view("instagram").readiness).toBe("needs_connection");
  });

  it("a sign-in begun while a disconnect is still on its way waits for it", async () => {
    await deusAccount("alice");
    await signIn("instagram");
    cloud.deleteDelayMs = 80;
    disconnectApp("instagram");
    // Connected again at once, before Deus Cloud has heard the disconnect:
    // the new account must not be the one that disconnect then takes.
    await signIn("instagram");
    await settle();
    expect(cloud.accounts.get("alice")!.get("instagram")?.status).toBe("active");
    expect(view("instagram").readiness).toBe("ready");
    expect(listConnections("instagram").map((c) => c.status)).toEqual(["active"]);
  });

  it("a sign-in that waited does not go on as another Deus account", async () => {
    await deusAccount("alice");
    await signIn("instagram");
    cloud.deleteDelayMs = 80;
    disconnectApp("instagram");
    const connecting = connectApp({ appId: "instagram" });
    connecting.catch(() => {});
    // Bob signs in to Deus while Alice's disconnect is still on its way.
    setCloudRuntimeCredentials({
      deusCloudUrl: cloud.base,
      deusCloudSessionToken: cloud.session("bob"),
    });
    await expect(connecting).rejects.toThrow(/Deus account changed/);
    await settle();
    expect(cloud.accounts.get("bob")?.has("instagram") ?? false).toBe(false);
    expect(listConnections("instagram").some((c) => c.status === "active")).toBe(false);
  });

  it("a sign-in whose app was disconnected while it was landing does not come back", async () => {
    await deusAccount("alice");
    const page = await fetch(await startSignIn("instagram"), { redirect: "manual" });
    const attempt = new URL(page.headers.get("location")!).pathname.split("/").pop()!;
    // The browser is back and Deus Cloud is being asked; the person disconnects meanwhile.
    const landing = completeCloudCallback(attempt);
    landing.catch(() => {});
    disconnectApp("instagram");
    await expect(landing).rejects.toThrow(/cancelled/);
    await settle();
    expect(view("instagram").readiness).toBe("needs_connection");
    expect(listConnections("instagram")).toHaveLength(0);
    expect(cloud.accounts.get("alice")?.has("instagram") ?? false).toBe(false);
  });

  it("connecting again cancels a disconnect that is still owed", async () => {
    await deusAccount("alice");
    await signIn("instagram");
    cloud.failing.add("DELETE");
    disconnectApp("instagram");
    await settle();
    expect(listConnections("instagram").map((c) => c.status)).toEqual(["removing"]);

    // The account is still in Deus Cloud, so connecting again finds it there.
    expect(await connectApp({ appId: "instagram" })).toEqual({ status: "connected" });
    expect(listConnections("instagram").map((c) => c.status)).toEqual(["active"]);

    // No later pass disconnects what the person connected again.
    cloud.failing.clear();
    await deusAccount("alice");
    await settle();
    expect(cloud.accounts.get("alice")!.get("instagram")?.status).toBe("active");
    expect(view("instagram").readiness).toBe("ready");
  });

  it("an app removed while its sign-in was starting does not come back connected", async () => {
    await deusAccount("alice");
    // Connected on another computer, so starting a sign-in answers "connected".
    cloud.connected("alice", "instagram", "instagram");
    cloud.startDelayMs = 60;
    cloud.failing.add("DELETE");
    const connecting = connectApp({ appId: "instagram" });
    connecting.catch(() => {});
    await new Promise((next) => setTimeout(next, 20));
    uninstallApp("instagram");
    await expect(connecting).rejects.toThrow(/cancelled/);
    await settle();
    expect(view("instagram").installed).toBe(false);
    // The disconnect that did not go through is still owed.
    expect(listConnections("instagram").map((c) => c.status)).toEqual(["removing"]);
  });

  it("two clients starting one sign-in at once share it", async () => {
    await deusAccount("alice");
    const [first, second] = await Promise.all([
      connectApp({ appId: "instagram" }),
      connectApp({ appId: "instagram" }),
    ]);
    expect(first.status).toBe("redirect");
    expect(second).toEqual(first);
    expect(listConnections("instagram")).toHaveLength(1);
    expect((await approve((first as { url: string }).url)).status).toBe(200);
    await settle();
    expect(view("instagram").readiness).toBe("ready");
  });

  it("a sign-in that a pass lands first still answers connected", async () => {
    await deusAccount("alice");
    cloud.connected("alice", "instagram", "instagram");
    cloud.startDelayMs = 60;
    const connecting = connectApp({ appId: "instagram" });
    await new Promise((next) => setTimeout(next, 20));
    // The pass finds the account connected on another computer and lands it.
    await reconcileCloudAccounts();
    expect(await connecting).toEqual({ status: "connected" });
    await settle();
    expect(view("instagram").readiness).toBe("ready");
    expect(listConnections("instagram").map((c) => c.status)).toEqual(["active"]);
  });

  it("a disconnect one Deus account still owes survives another account using the app", async () => {
    await deusAccount("alice");
    await signIn("instagram");
    await deusAccount(null);
    uninstallApp("instagram");
    await settle();

    // Bob signs in to Deus on this computer and connects the same app as himself.
    await deusAccount("bob");
    await signIn("instagram");
    expect(
      listConnections("instagram")
        .map((c) => c.status)
        .sort()
    ).toEqual(["active", "removing"]);
    // He removes it again: his account is disconnected, hers still waits for her.
    uninstallApp("instagram");
    await settle();
    expect(cloud.accounts.get("bob")?.has("instagram") ?? false).toBe(false);
    expect(listConnections("instagram").map((c) => c.status)).toEqual(["removing"]);
    expect(cloud.accounts.get("alice")!.has("instagram")).toBe(true);

    await deusAccount("alice");
    await settle();
    expect(cloud.accounts.get("alice")!.has("instagram")).toBe(false);
    expect(listConnections("instagram")).toHaveLength(0);
  });

  it("a late answer about its sign-in does not undo a disconnect that is still owed", async () => {
    await deusAccount("alice");
    await signIn("instagram");
    const row = listConnections("instagram")[0]!;
    cloud.failing.add("DELETE");
    disconnectApp("instagram");
    await settle();
    // A check begun before the disconnect now reports the account gone.
    markNeedsReauth(row.id, "Instagram is no longer signed in");
    expect(listConnections("instagram").map((c) => c.status)).toEqual(["removing"]);
  });

  it("removing an app while Deus Cloud is down still disconnects its account later", async () => {
    await deusAccount("alice");
    await signIn("instagram");
    for (const method of ["GET", "POST", "DELETE"]) cloud.failing.add(method);
    uninstallApp("instagram");
    await settle();
    expect(view("instagram").installed).toBe(false);
    expect(listConnections("instagram").map((c) => c.status)).toEqual(["removing"]);

    cloud.failing.clear();
    await deusAccount("alice");
    expect(cloud.accounts.get("alice")!.has("instagram")).toBe(false);
    expect(listConnections("instagram")).toHaveLength(0);
  });

  it("a check notices an account that is gone, and a new sign-in replaces it", async () => {
    await deusAccount("alice");
    await signIn("instagram");
    // Disconnected on another computer, or revoked at the vendor.
    cloud.accounts.get("alice")!.delete("instagram");
    await checkApp("instagram");
    expect(view("instagram")).toMatchObject({
      readiness: "needs_reauth",
      checkError: "Instagram is no longer signed in",
    });
    expect((await resolveTurnApps()).servers.instagram).toBeUndefined();

    await signIn("instagram");
    expect(view("instagram").readiness).toBe("ready");
    expect(listConnections("instagram")).toHaveLength(1);
  });

  it("a check with an expired Deus session does not ask for the app's sign-in again", async () => {
    await deusAccount("alice");
    await signIn("instagram");
    cloud.revokedSessions.add(cloud.session("alice"));
    await checkApp("instagram");
    // The app's own sign-in still stands; what expired is the Deus session.
    expect(view("instagram")).toMatchObject({
      readiness: "ready",
      checkError: "Your Deus sign-in has expired. Sign in to Deus again.",
    });
  });

  it("says what went wrong when Deus Cloud cannot start a sign-in", async () => {
    await deusAccount("alice");
    cloud.revokedSessions.add(cloud.session("alice"));
    await expect(connectApp({ appId: "instagram" })).rejects.toThrow(
      "Instagram did not start a sign-in: Your Deus sign-in has expired. Sign in to Deus again."
    );
    expect(listConnections("instagram")).toHaveLength(0);
  });
});

describe("the Deus account the app was connected with", () => {
  it("brings its apps to a second computer with no sign-in", async () => {
    // Another computer connected Instagram for this account.
    cloud.connected("alice", "instagram", "instagram");
    await deusAccount("alice");
    // Not installed here: nothing appears by itself.
    expect(view("instagram")).toMatchObject({ installed: false });
    // Connecting it answers at once, with no browser.
    expect(await connectApp({ appId: "instagram" })).toEqual({ status: "connected" });
    await settleChecks();
    expect(view("instagram").readiness).toBe("ready");
  });

  it("readies an installed app the account already connected, when it signs in", async () => {
    installApp("instagram");
    expect(view("instagram")).toMatchObject({ readiness: "unavailable", unavailable: "account" });
    cloud.connected("alice", "instagram", "instagram");
    await deusAccount("alice");
    expect(view("instagram").readiness).toBe("ready");
    const client = await agentClient("instagram");
    expect(text(await client.callTool({ name: "INSTAGRAM_CREATE_POST", arguments: {} }))).toBe(
      "posted"
    );
    await client.close();
  });

  it("signing out of Deus pauses the app; signing back in resumes it", async () => {
    await deusAccount("alice");
    await signIn("instagram");
    await deusAccount(null);
    expect(view("instagram")).toMatchObject({ readiness: "unavailable", unavailable: "account" });
    expect((await resolveTurnApps()).servers.instagram).toBeUndefined();
    // The connection waits; nothing was disconnected in Deus Cloud.
    expect(listConnections("instagram")).toHaveLength(1);
    expect(cloud.accounts.get("alice")!.get("instagram")!.status).toBe("active");

    await deusAccount("alice");
    expect(view("instagram").readiness).toBe("ready");
    expect((await resolveTurnApps()).servers.instagram).toBeDefined();
  });

  it("an app removed while signed out of Deus is disconnected when its account returns", async () => {
    await deusAccount("alice");
    await signIn("instagram");
    await deusAccount(null);
    uninstallApp("instagram");
    await settle();
    // Deus Cloud could not be told: the row waits, belonging to no app.
    expect(view("instagram").installed).toBe(false);
    expect(cloud.accounts.get("alice")!.has("instagram")).toBe(true);
    expect(listConnections("instagram").map((c) => c.status)).toEqual(["removing"]);

    // Someone else signs in first: what Alice removed still waits for Alice.
    await deusAccount("bob");
    expect(listConnections("instagram").map((c) => c.status)).toEqual(["removing"]);
    expect(cloud.accounts.get("alice")!.has("instagram")).toBe(true);

    await deusAccount("alice");
    await settle();
    expect(cloud.accounts.get("alice")!.has("instagram")).toBe(false);
    expect(listConnections("instagram")).toHaveLength(0);
    // Installing it again starts clean: it asks to connect.
    installApp("instagram");
    expect(view("instagram").readiness).toBe("needs_connection");
  });

  it("a sign-in that lands while the account is being read is not undone", async () => {
    await deusAccount("alice");
    await signIn("instagram");
    // Deus Cloud's list was read a moment before the sign-in landed.
    const real = globalThis.fetch;
    const listed = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url === `${cloud.base}/me/connections`) {
        return Response.json({
          providers: [{ id: "composio", toolkits: cloud.toolkits }],
          items: [],
        });
      }
      return real(input, init);
    });
    await deusAccount("alice");
    listed.mockRestore();
    expect(view("instagram").readiness).toBe("ready");
  });

  it("another Deus account does not inherit it", async () => {
    await deusAccount("alice");
    await signIn("instagram");
    await deusAccount("bob");
    // Bob's computer forgets Alice's row; Alice keeps her connection in Deus Cloud.
    expect(view("instagram")).toMatchObject({ installed: true, readiness: "needs_connection" });
    expect(listConnections("instagram")).toHaveLength(0);
    expect((await resolveTurnApps()).servers.instagram).toBeUndefined();
    expect(cloud.accounts.get("alice")!.get("instagram")!.status).toBe("active");
    expect(cloud.requests.some((r) => r.method === "DELETE")).toBe(false);

    await signIn("instagram");
    const client = await agentClient("instagram");
    await client.callTool({ name: "INSTAGRAM_CREATE_POST", arguments: {} });
    await client.close();
    expect(cloud.calls).toEqual(["bob:instagram:INSTAGRAM_CREATE_POST"]);
  });

  it("an account disconnected on another computer asks to sign in again here", async () => {
    await deusAccount("alice");
    await signIn("instagram");
    cloud.accounts.get("alice")!.delete("instagram");
    await deusAccount("alice"); // the session renews
    expect(view("instagram").readiness).toBe("needs_reauth");
  });

  it("an expired Deus session is not the app's sign-in to redo", async () => {
    await deusAccount("alice");
    await signIn("instagram");
    const client = await agentClient("instagram");
    cloud.revokedSessions.add(cloud.session("alice"));
    const result = await client
      .callTool({ name: "INSTAGRAM_CREATE_POST", arguments: {} })
      .catch((error: Error) => error);
    expect(String(result)).toMatch(/Deus sign-in has expired/);
    expect(view("instagram").readiness).toBe("ready");
    await client.close().catch(() => {});
  });
});

describe("a cloud turn", () => {
  beforeEach(() => {
    process.env.DEUS_CLOUD_EXTENSIONS = "1";
  });
  afterEach(() => {
    delete process.env.DEUS_CLOUD_EXTENSIONS;
  });

  it("reaches a connected app with a capability, never the Deus session", async () => {
    await deusAccount("alice");
    await signIn("instagram");
    expect(view("instagram").cloud).toBe(true);
    const turn = await resolveCloudTurnExtensions();
    expect(turn.mcpServers).toEqual({
      instagram: {
        type: "http",
        url: `${cloud.base}/connections/instagram/mcp`,
        headers: { Authorization: "Bearer capability-1-for-alice" },
        required: false,
      },
    });
    expect(JSON.stringify(turn)).not.toContain(cloud.session("alice"));
    expect(cloud.capabilities).toEqual([["instagram"]]);
  });

  it("reuses one capability across turns, and asks again when the apps change", async () => {
    await deusAccount("alice");
    await signIn("instagram");
    await resolveCloudTurnExtensions();
    await resolveCloudTurnExtensions();
    expect(cloud.capabilities).toHaveLength(1);

    await signIn("slack");
    const turn = await resolveCloudTurnExtensions();
    expect(Object.keys(turn.mcpServers ?? {}).sort()).toEqual(["instagram", "slack"]);
    expect(cloud.capabilities).toHaveLength(2);

    // Near its end, the next turn gets a fresh one.
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now + 5 * 60 * 60_000);
    await resolveCloudTurnExtensions();
    expect(cloud.capabilities).toHaveLength(3);
  });

  it("leaves out an app that is off, disconnected, or another account's", async () => {
    await deusAccount("alice");
    await signIn("instagram");
    setAppEnabled("instagram", false);
    expect((await resolveCloudTurnExtensions()).mcpServers).toBeUndefined();
    setAppEnabled("instagram", true);
    disconnectApp("instagram");
    await settle();
    expect((await resolveCloudTurnExtensions()).mcpServers).toBeUndefined();

    await signIn("instagram");
    await deusAccount(null);
    expect((await resolveCloudTurnExtensions()).mcpServers).toBeUndefined();
    expect(view("instagram").cloud).toBe(false);
  });

  it("starts without its apps when Deus Cloud cannot be asked, rather than failing", async () => {
    await deusAccount("alice");
    await signIn("instagram");
    installApp("context7");
    cloud.revokedSessions.add(cloud.session("alice"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const turn = await resolveCloudTurnExtensions();
    expect(turn.mcpServers).toEqual({
      context7: { type: "http", url: "https://mcp.context7.test/mcp", required: false },
    });
    expect(turn.skills).toEqual([]);
    expect(warn).toHaveBeenCalled();
  });
});

describe("an app whose own sign-in needs an approved client", () => {
  it("goes through Deus Cloud until Deus has that client, then signs in directly", async () => {
    await deusAccount("alice");
    expect(view("slack")).toMatchObject({ available: true, via: "Composio" });
    await signIn("slack");
    expect(view("slack")).toMatchObject({ readiness: "ready" });
    expect(view("slack").connection?.kind).toBe("managed");

    // Deus registers its own Slack app: new sign-ins go to Slack itself.
    process.env.DEUS_OAUTH_CLIENTS = JSON.stringify({ slack: { client_id: "deus-slack" } });
    expect(view("slack")).toMatchObject({ available: true, via: null });
    // The account made through Deus Cloud keeps working through it.
    const client = await agentClient("slack");
    expect(text(await client.callTool({ name: "SLACK_CREATE_POST", arguments: {} }))).toBe(
      "posted"
    );
    await client.close();
    // And with its own client, Slack needs no Deus account at all.
    await deusAccount(null);
    expect(view("slack")).toMatchObject({ available: true, unavailable: null });
  });
});

describe("the broker's key", () => {
  it("is nowhere in this app: only Deus Cloud talks to the broker", () => {
    // Composio's project key can act on every account connected through it.
    // The backend must have no way to hold one, so a build cannot ship one.
    const root = path.resolve(__dirname, "../../../../src");
    const sources = fs
      .readdirSync(root, { recursive: true, encoding: "utf8" })
      .filter((file) => file.endsWith(".ts"));
    expect(sources.length).toBeGreaterThan(100);
    for (const file of sources) {
      const source = fs.readFileSync(path.join(root, file), "utf8");
      expect(source, file).not.toMatch(/COMPOSIO_API_KEY|backend\.composio\.dev|x-api-key/i);
    }
  });
});
