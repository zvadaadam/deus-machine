// The MCP OAuth path end to end, against a real local provider (provider.ts):
// discovery, dynamic client registration, PKCE, and a token endpoint whose
// refresh tokens rotate.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";
import { memoryDatabase, scratchDir } from "./fixtures";
import { startProvider, type Provider } from "./provider";

const state = vi.hoisted(() => ({
  db: null as Database.Database | null,
  dir: "",
  mcpUrl: "",
}));

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
import { getState, startIntegrations } from "../../../../src/services/integrations";
import {
  completeOAuthCallback,
  connectApp,
  disconnectApp,
} from "../../../../src/services/integrations/apps";
import { setSignInReturnBase } from "../../../../src/services/integrations/auth/callback";
import { checkApp, settleChecks } from "../../../../src/services/integrations/checks";
import { readAppTools } from "../../../../src/services/integrations/store";
import { credentialsFor } from "../../../../src/services/integrations/credentials";
import { __resetOAuthForTests } from "../../../../src/services/integrations/auth/mcp-oauth";
import { getConnection, getInstallation } from "../../../../src/services/integrations/store";
import { __resetVaultKeyForTests } from "../../../../src/services/integrations/vault";

let provider: Provider;

beforeAll(async () => {
  provider = await startProvider();
});
afterAll(() => provider.close());

beforeEach(() => {
  state.db = memoryDatabase();
  state.dir = scratchDir("deus-oauth-");
  state.mcpUrl = `${provider.base}/mcp`;
  process.env.DEUS_VAULT_KEY = "22".repeat(32);
  __resetVaultKeyForTests();
  __resetOAuthForTests();
  startIntegrations(4123);
  provider.reset();
});

afterEach(async () => {
  await settleChecks();
  state.db?.close();
  vi.restoreAllMocks();
});

/** Ask for the sign-in page and follow it like a browser: the provider approves at once. */
async function approve(): Promise<URL> {
  const result = await connectApp({ appId: "acme" });
  if (result.status !== "redirect") throw new Error("expected a sign-in page");
  const response = await fetch(result.url, { redirect: "manual" });
  expect(response.status).toBe(302);
  return new URL(response.headers.get("location")!);
}

/** A whole sign-in; returns the authorization URL it used. */
async function signIn(): Promise<void> {
  const callback = await approve();
  await completeOAuthCallback(callback.searchParams);
  await settleChecks();
}

const acme = () => composeSnapshot(CATALOG, getState()).apps.find((v) => v.app.id === "acme")!;
const credentials = (options?: { fresh?: boolean }) =>
  credentialsFor(acme().app, getConnection(getInstallation("app", "acme")!.connectionId!), options);
const bearer = async (options?: { fresh?: boolean }) => {
  const answer = await credentials(options);
  return answer.ok ? answer.headers.Authorization : answer;
};

describe("signing in", () => {
  it("registers Deus, signs in with PKCE, and the account's token reaches its requests", async () => {
    const result = await connectApp({ appId: "acme" });
    const authorize = new URL((result as { url: string }).url);
    expect(authorize.searchParams.get("redirect_uri")).toBe(
      "http://localhost:4123/api/integrations/oauth/callback"
    );
    expect(authorize.searchParams.get("code_challenge_method")).toBe("S256");
    expect(authorize.searchParams.get("resource")).toBe(`${provider.base}/mcp`);
    // Installed, but not yet an account.
    expect(acme()).toMatchObject({ installed: true, readiness: "needs_connection" });

    const callback = new URL(
      (await fetch(authorize, { redirect: "manual" })).headers.get("location")!
    );
    expect(await completeOAuthCallback(callback.searchParams)).toBe("Acme");
    expect(provider.clients.size).toBe(1);
    expect(acme()).toMatchObject({ readiness: "ready" });
    expect(await bearer()).toBe("Bearer access-1");
  });

  it("the check connects with the token and lists the tools, with what the server says of each", async () => {
    await signIn();
    await checkApp("acme");
    expect(readAppTools("acme")).toEqual([
      { name: "list_issues", description: "List issues", readOnly: true },
      { name: "create_issue", description: "Create an issue" },
    ]);
    expect(acme()).toMatchObject({ toolCount: 2, checkError: null });
  });

  it("a callback works once; a forged or replayed one is refused", async () => {
    await expect(
      completeOAuthCallback(new URLSearchParams({ state: "forged", code: "x" }))
    ).rejects.toThrow(/expired/);
    const callback = await approve();
    await completeOAuthCallback(callback.searchParams);
    await expect(completeOAuthCallback(callback.searchParams)).rejects.toThrow(/expired/);
  });

  it("the newest sign-in wins: an older tab's callback finds nothing, and no second account appears", async () => {
    const older = await approve();
    const newer = await approve();
    await expect(completeOAuthCallback(older.searchParams)).rejects.toThrow(/expired/);
    await completeOAuthCallback(newer.searchParams);
    expect(acme().readiness).toBe("ready");
    expect(state.db!.prepare("SELECT COUNT(*) AS n FROM integration_connections").get()).toEqual({
      n: 1,
    });
  });

  it("two clients starting one sign-in at once share its page", async () => {
    const [first, second] = await Promise.all([
      connectApp({ appId: "acme" }),
      connectApp({ appId: "acme" }),
    ]);
    expect(first.status).toBe("redirect");
    // One attempt, not two racing to be the newest: the page works for both.
    expect(second).toEqual(first);
    const response = await fetch((first as { url: string }).url, { redirect: "manual" });
    await completeOAuthCallback(new URL(response.headers.get("location")!).searchParams);
    expect(acme().readiness).toBe("ready");
  });

  it("a sign-in begun while an older one's code is being exchanged is the one that stays", async () => {
    const older = await approve();
    provider.exchangeDelayMs = 80;
    const exchanging = completeOAuthCallback(older.searchParams);
    exchanging.catch(() => {});
    await new Promise((next) => setTimeout(next, 10));
    // The person starts over and finishes first.
    const newer = await approve();
    await completeOAuthCallback(newer.searchParams);
    const chosen = await bearer();

    await expect(exchanging).rejects.toThrow(/newer sign-in/);
    expect(await bearer()).toBe(chosen);
    expect(acme()).toMatchObject({ readiness: "ready" });
    expect(acme().connection?.lastError ?? null).toBeNull();
  });

  it("a denied sign-in leaves the app waiting for its account", async () => {
    const result = await connectApp({ appId: "acme" });
    const oauthState = new URL((result as { url: string }).url).searchParams.get("state")!;
    await expect(
      completeOAuthCallback(new URLSearchParams({ state: oauthState, error: "access_denied" }))
    ).rejects.toThrow(/cancelled/);
    expect(acme().readiness).toBe("needs_connection");
  });

  it("signing in again keeps the old account working until the new one lands", async () => {
    await signIn();
    const callback = await approve();
    // The browser is open; the first sign-in still answers.
    expect(await bearer()).toBe("Bearer access-1");
    await completeOAuthCallback(callback.searchParams);
    expect(await bearer()).toBe("Bearer access-2");
    expect(state.db!.prepare("SELECT COUNT(*) AS n FROM integration_connections").get()).toEqual({
      n: 1,
    });
  });

  it("signing out mid sign-in: the callback finds nothing and no account is created", async () => {
    const callback = await approve();
    await disconnectApp("acme");
    await expect(completeOAuthCallback(callback.searchParams)).rejects.toThrow(/expired/);
    expect(acme()).toMatchObject({ installed: true, readiness: "needs_connection" });
    expect(state.db!.prepare("SELECT COUNT(*) AS n FROM integration_connections").get()).toEqual({
      n: 0,
    });
  });

  it("a new backend port registers a new client for the next sign-in", async () => {
    await signIn();
    setSignInReturnBase("http://localhost:5999");
    await signIn();
    expect(provider.clients.size).toBe(2);
    expect([...provider.clients.values()][1]?.redirect_uris).toEqual([
      "http://localhost:5999/api/integrations/oauth/callback",
    ]);
  });
});

describe("refreshing", () => {
  it("refreshes an expiring token once, however many requests need it together", async () => {
    provider.nextExpiresIn = 30; // inside the refresh margin
    await signIn();
    provider.nextExpiresIn = 3600;
    const refreshesBefore = provider.refreshCalls;

    const answers = await Promise.all(Array.from({ length: 8 }, () => bearer()));
    expect(new Set(answers).size).toBe(1);
    expect(provider.refreshCalls - refreshesBefore).toBeLessThanOrEqual(1);
    // The rotated refresh token is the one kept: the next refresh works.
    const kept = [...provider.refreshTokens];
    expect(kept).toHaveLength(1);
    expect(await bearer()).toBe(answers[0]);
  });

  it("a server that refuses the token gets a fresh one, but not in a loop", async () => {
    await signIn();
    const now = Date.now();
    // Just signed in: a refusal now is not answered with another refresh.
    expect(await bearer({ fresh: true })).toBe("Bearer access-1");
    expect(provider.refreshCalls).toBe(0);

    vi.spyOn(Date, "now").mockReturnValue(now + 60_000);
    expect(await bearer({ fresh: true })).toBe("Bearer access-2");
    expect(provider.refreshCalls).toBe(1);
  });

  it("a revoked sign-in asks the user to sign in again, and says so", async () => {
    provider.nextExpiresIn = -1; // already expired
    await signIn();
    provider.refreshTokens.clear(); // the provider revoked it

    expect(await credentials()).toMatchObject({ ok: false, reauth: true });
    expect(acme()).toMatchObject({ readiness: "needs_reauth" });
    expect(acme().connection?.lastError).toMatch(/revoked or expired/);
  });

  it("a token endpoint that is down keeps a token that still works", async () => {
    await signIn(); // an hour's token
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now + 3_500_000); // 100 s left: due a refresh
    const real = globalThis.fetch;
    vi.spyOn(globalThis, "fetch").mockImplementation((input, init) =>
      String(input).endsWith("/token") ? Promise.reject(new Error("offline")) : real(input, init)
    );
    expect(await bearer()).toBe("Bearer access-1");
    expect(acme().readiness).toBe("ready");

    // Once it has expired there is nothing to keep: the request fails, the account stands.
    vi.spyOn(Date, "now").mockReturnValue(now + 3_700_000);
    expect(await credentials()).toMatchObject({ ok: false, reauth: false });
    expect(acme().readiness).toBe("ready");
  });

  it.each(["invalid_request", "error_in_200"] as const)(
    "a refusal in the endpoint's own words (%s) still means sign in again, once",
    async (answer) => {
      await signIn();
      const now = Date.now();
      vi.spyOn(Date, "now").mockReturnValue(now + 3_590_000); // due a refresh
      provider.refreshAnswer = answer;
      expect(await credentials()).toMatchObject({ ok: false, reauth: true });
      expect(acme().readiness).toBe("needs_reauth");
      // It is not asked again on every request.
      await credentials();
      await credentials();
      expect(provider.refreshCalls).toBe(1);
    }
  );

  it("a token endpoint having a bad time is retried, but not on every request", async () => {
    await signIn();
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now + 3_590_000);
    provider.refreshAnswer = "unavailable";
    expect(await bearer()).toBe("Bearer access-1");
    expect(await bearer()).toBe("Bearer access-1");
    expect(provider.refreshCalls).toBe(1);
    expect(acme().readiness).toBe("ready");

    vi.spyOn(Date, "now").mockReturnValue(now + 3_590_000 + 11_000);
    provider.refreshAnswer = "ok";
    expect(await bearer()).toBe("Bearer access-2");
  });

  it("tokens are bound to their server: a changed address never receives them", async () => {
    await signIn();
    state.mcpUrl = "https://elsewhere.example.test/mcp";
    expect(await credentials()).toMatchObject({ ok: false, reauth: true });
    expect(acme().readiness).toBe("needs_reauth");
  });
});
