import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const electronMocks = vi.hoisted(() => ({
  openExternal: vi.fn(),
  userDataDir: "",
  sentEvents: [] as Array<{ channel: string; payload: unknown }>,
}));

/**
 * A seam on file reads: `holdNextSessionRead` makes the next read of the session
 * file read it at once and then wait to return it until released.
 */
const fileReads = vi.hoisted(() => ({
  holdNextSessionRead: false,
  held: null as null | (() => void),
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const readFile = (async (...args: Parameters<typeof actual.readFile>) => {
    const content = await actual.readFile(...args);
    if (fileReads.holdNextSessionRead && String(args[0]).endsWith("deus-cloud-session.json")) {
      fileReads.holdNextSessionRead = false;
      await new Promise<void>((resolve) => (fileReads.held = resolve));
    }
    return content;
  }) as typeof actual.readFile;
  return { ...actual, default: { ...actual, readFile }, readFile };
});

vi.mock("electron", () => ({
  app: {
    getPath: (name: string) => {
      if (name !== "userData") throw new Error(`unexpected app path: ${name}`);
      return electronMocks.userDataDir;
    },
    setAsDefaultProtocolClient: vi.fn(),
  },
  BrowserWindow: {
    getAllWindows: () => [
      {
        isDestroyed: () => false,
        webContents: {
          send: (channel: string, payload: unknown) => {
            electronMocks.sentEvents.push({ channel, payload });
          },
        },
      },
    ],
  },
  ipcMain: {
    handle: vi.fn(),
  },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(value, "utf8"),
    decryptString: (value: Buffer) => value.toString("utf8"),
  },
  shell: {
    openExternal: electronMocks.openExternal,
  },
}));

import {
  getDeusCloudSessionStatus,
  getStoredDeusCloudSessionToken,
  signOutDeusCloud,
  startDeusCloudLogin,
} from "../../../apps/desktop/main/deus-cloud-auth";
import { listOrgKeys } from "../../../apps/desktop/main/cloud-credentials";
import { provisionAtStartup } from "../../../apps/desktop/main/deus-cloud-provision";

const originalFetch = global.fetch;
const originalEnv = { ...process.env };

beforeEach(async () => {
  vi.clearAllMocks();
  electronMocks.sentEvents = [];
  electronMocks.userDataDir = await mkdtemp(join(tmpdir(), "deus-cloud-auth-"));
  process.env.DEUS_MACHINE_CLOUD_URL = "https://cloud.test";
});

afterEach(async () => {
  global.fetch = originalFetch;
  process.env = { ...originalEnv };
  await rm(electronMocks.userDataDir, { recursive: true, force: true });
});

describe("desktop session refresh", () => {
  /** Sign in once so a real session file (with a refresh token) exists. */
  async function signIn(expiresInSeconds: number): Promise<void> {
    global.fetch = vi.fn(async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname === "/auth/desktop/config") {
        return Response.json({
          authorization_endpoint: "https://api.workos.test/user_management/authorize",
          client_id: "client_test",
          provider: "authkit",
          redirect_uri: "http://127.0.0.1:*/auth/callback",
        });
      }
      if (url.hostname === "127.0.0.1") return originalFetch(input, init);
      if (url.pathname === "/auth/desktop/exchange") {
        return Response.json({
          session_token: "session-v1",
          token_type: "Bearer",
          expires_in_seconds: expiresInSeconds,
          account_id: "user_test",
          refresh_token: "refresh-v1",
        });
      }
      if (url.pathname === "/me")
        return Response.json({ account: { name: "Ada", email: "a@b.c" } });
      throw new Error(`unexpected fetch: ${url.toString()}`);
    }) as typeof fetch;

    const login = startDeusCloudLogin();
    await vi.waitFor(() => expect(electronMocks.openExternal).toHaveBeenCalledTimes(1));
    const loginUrl = new URL(electronMocks.openExternal.mock.calls[0]?.[0] as string);
    const callbackUrl = new URL(loginUrl.searchParams.get("redirect_uri") ?? "");
    callbackUrl.searchParams.set("code", "workos-code");
    callbackUrl.searchParams.set("state", loginUrl.searchParams.get("state") ?? "");
    await originalFetch(callbackUrl);
    await expect(login).resolves.toMatchObject({ success: true });
  }

  it("renews silently when the session is near expiry, keeping the user signed in", async () => {
    await signIn(60); // inside the 6h refresh window

    let refreshBody: Record<string, unknown> | null = null;
    global.fetch = vi.fn(async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname === "/auth/desktop/refresh") {
        refreshBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return Response.json({
          session_token: "session-v2",
          token_type: "Bearer",
          expires_in_seconds: 24 * 60 * 60,
          account_id: "user_test",
          refresh_token: "refresh-v2",
        });
      }
      throw new Error(`unexpected fetch: ${url.toString()}`);
    }) as typeof fetch;

    await expect(getDeusCloudSessionStatus()).resolves.toMatchObject({
      signedIn: true,
      accountId: "user_test",
    });
    // Presented the stored token; WorkOS rotates, so the new one must be kept.
    expect(refreshBody).toMatchObject({ refresh_token: "refresh-v1" });

    // Second read uses the ROTATED token — proof the new one was persisted.
    await expect(getStoredDeusCloudSessionToken()).resolves.toBe("session-v2");
  });

  it("does not re-refresh on every read when the token's own lifetime is short", async () => {
    // A 60s token is permanently inside the absolute 6h window. Without a
    // floor, EVERY session read becomes a network round-trip — and every
    // settings render blocks on one.
    await signIn(60);

    let refreshes = 0;
    global.fetch = vi.fn(async (input) => {
      const url = new URL(String(input));
      if (url.pathname === "/auth/desktop/refresh") {
        refreshes += 1;
        return Response.json({
          session_token: `session-v${refreshes + 1}`,
          token_type: "Bearer",
          expires_in_seconds: 60,
          account_id: "user_test",
          refresh_token: `refresh-v${refreshes + 1}`,
        });
      }
      throw new Error(`unexpected fetch: ${url.toString()}`);
    }) as typeof fetch;

    await getDeusCloudSessionStatus();
    await getDeusCloudSessionStatus();
    await getStoredDeusCloudSessionToken();

    expect(refreshes).toBe(1);
  });

  it("signs out only when the refresh token is actually rejected (401)", async () => {
    await signIn(60);
    global.fetch = vi.fn(async () => new Response(null, { status: 401 })) as typeof fetch;
    await expect(getDeusCloudSessionStatus()).resolves.toMatchObject({ signedIn: false });
  });

  it("keeps a still-valid session when refresh fails transiently", async () => {
    await signIn(60);
    // 503 = the worker is misconfigured, not "your session is bad". Discarding
    // a good session here would sign the user out for a server-side problem.
    global.fetch = vi.fn(async () => new Response(null, { status: 503 })) as typeof fetch;
    await expect(getDeusCloudSessionStatus()).resolves.toMatchObject({
      signedIn: true,
      accountId: "user_test",
    });
  });
});

describe("desktop Deus Cloud auth flow", () => {
  it("opens WorkOS with PKCE, handles callback, and stores the Deus Cloud session", async () => {
    let exchangedBody: Record<string, unknown> | null = null;
    global.fetch = vi.fn(async (input, init) => {
      const url = new URL(String(input));

      if (url.pathname === "/auth/desktop/config") {
        return Response.json({
          authorization_endpoint: "https://api.workos.test/user_management/authorize",
          client_id: "client_test",
          provider: "authkit",
          redirect_uri: "http://127.0.0.1:*/auth/callback",
        });
      }

      if (url.hostname === "127.0.0.1") {
        return originalFetch(input, init);
      }

      if (url.pathname === "/auth/desktop/exchange") {
        exchangedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return Response.json({
          session_token: "deus-session-token",
          token_type: "Bearer",
          expires_in_seconds: 3600,
          account_id: "user_test",
        });
      }

      throw new Error(`unexpected fetch: ${url.toString()}`);
    }) as typeof fetch;

    const loginResult = startDeusCloudLogin();
    await vi.waitFor(() => expect(electronMocks.openExternal).toHaveBeenCalledTimes(1));

    const loginUrl = new URL(electronMocks.openExternal.mock.calls[0]?.[0] as string);
    expect(loginUrl.origin).toBe("https://api.workos.test");
    expect(loginUrl.pathname).toBe("/user_management/authorize");
    expect(loginUrl.searchParams.get("response_type")).toBe("code");
    expect(loginUrl.searchParams.get("client_id")).toBe("client_test");
    const redirectUri = loginUrl.searchParams.get("redirect_uri");
    expect(redirectUri).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/auth\/callback$/);
    expect(loginUrl.searchParams.get("provider")).toBe("authkit");
    expect(loginUrl.searchParams.get("code_challenge_method")).toBe("S256");

    const state = loginUrl.searchParams.get("state");
    expect(state).toBeTruthy();

    const callbackUrl = new URL(redirectUri ?? "");
    callbackUrl.searchParams.set("code", "workos-code");
    callbackUrl.searchParams.set("state", state ?? "");
    await expect(originalFetch(callbackUrl)).resolves.toMatchObject({ status: 200 });

    await expect(loginResult).resolves.toMatchObject({
      success: true,
      session: {
        signedIn: true,
        accountId: "user_test",
        tokenType: "Bearer",
        cloudUrl: "https://cloud.test",
      },
    });

    expect(exchangedBody).toMatchObject({
      code: "workos-code",
      code_verifier: expect.stringMatching(/^[A-Za-z0-9._~-]{43,128}$/),
    });
    await expect(getDeusCloudSessionStatus()).resolves.toMatchObject({
      signedIn: true,
      accountId: "user_test",
    });
    expect(electronMocks.sentEvents).toContainEqual({
      channel: "deus_cloud:changed",
      payload: expect.objectContaining({ signedIn: true, accountId: "user_test" }),
    });

    await expect(signOutDeusCloud()).resolves.toMatchObject({
      success: true,
      session: { signedIn: false },
    });
  });

  it("rejects overlapping sign-in attempts while login setup is pending", async () => {
    process.env.DEUS_MACHINE_CLOUD_URL = "https://cloud.test/deus";
    let resolveConfig: (response: Response) => void = () => {};
    const configResponse = new Promise<Response>((resolve) => {
      resolveConfig = resolve;
    });

    global.fetch = vi.fn(async (input, init) => {
      const url = new URL(String(input));

      if (url.pathname === "/deus/auth/desktop/config") {
        return configResponse;
      }

      if (url.hostname === "127.0.0.1") {
        return originalFetch(input, init);
      }

      if (url.pathname === "/deus/auth/desktop/exchange") {
        return Response.json({
          session_token: "deus-session-token",
          token_type: "Bearer",
          expires_in_seconds: 3600,
          account_id: "user_test",
        });
      }

      throw new Error(`unexpected fetch: ${url.toString()}`);
    }) as typeof fetch;

    const firstLogin = startDeusCloudLogin();
    await vi.waitFor(() => expect(global.fetch).toHaveBeenCalledTimes(1));

    await expect(startDeusCloudLogin()).rejects.toThrow(
      "Deus Cloud sign-in is already in progress"
    );

    resolveConfig(
      Response.json({
        authorization_endpoint: "https://api.workos.test/user_management/authorize",
        client_id: "client_test",
        provider: "authkit",
        redirect_uri: "http://127.0.0.1:*/auth/callback",
      })
    );

    await vi.waitFor(() => expect(electronMocks.openExternal).toHaveBeenCalledTimes(1));
    const loginUrl = new URL(electronMocks.openExternal.mock.calls[0]?.[0] as string);
    const redirectUri = loginUrl.searchParams.get("redirect_uri");
    const state = loginUrl.searchParams.get("state");
    const callbackUrl = new URL(redirectUri ?? "");
    callbackUrl.searchParams.set("code", "workos-code");
    callbackUrl.searchParams.set("state", state ?? "");
    await expect(originalFetch(callbackUrl)).resolves.toMatchObject({ status: 200 });

    await expect(firstLogin).resolves.toMatchObject({
      success: true,
      session: {
        signedIn: true,
        accountId: "user_test",
        cloudUrl: "https://cloud.test/deus",
      },
    });
  });

  it("cancels an in-flight browser login when signing out", async () => {
    global.fetch = vi.fn(async (input, init) => {
      const url = new URL(String(input));

      if (url.pathname === "/auth/desktop/config") {
        return Response.json({
          authorization_endpoint: "https://api.workos.test/user_management/authorize",
          client_id: "client_test",
          provider: "authkit",
          redirect_uri: "http://127.0.0.1:*/auth/callback",
        });
      }

      if (url.hostname === "127.0.0.1") {
        return originalFetch(input, init);
      }

      if (url.pathname === "/auth/desktop/exchange") {
        return Response.json({
          session_token: "deus-session-token",
          token_type: "Bearer",
          expires_in_seconds: 3600,
          account_id: "user_test",
        });
      }

      throw new Error(`unexpected fetch: ${url.toString()}`);
    }) as typeof fetch;

    const loginResult = startDeusCloudLogin().catch((error) => error as Error);
    await vi.waitFor(() => expect(electronMocks.openExternal).toHaveBeenCalledTimes(1));

    await expect(signOutDeusCloud()).resolves.toMatchObject({
      success: true,
      session: { signedIn: false },
    });
    await expect(loginResult).resolves.toMatchObject({
      message: "Deus Cloud sign-in was cancelled",
    });
    await expect(getDeusCloudSessionStatus()).resolves.toMatchObject({ signedIn: false });
  });

  it("rejects invalid desktop exchange responses before storing a session", async () => {
    global.fetch = vi.fn(async (input, init) => {
      const url = new URL(String(input));

      if (url.pathname === "/auth/desktop/config") {
        return Response.json({
          authorization_endpoint: "https://api.workos.test/user_management/authorize",
          client_id: "client_test",
          provider: "authkit",
          redirect_uri: "http://127.0.0.1:*/auth/callback",
        });
      }

      if (url.hostname === "127.0.0.1") {
        return originalFetch(input, init);
      }

      if (url.pathname === "/auth/desktop/exchange") {
        return Response.json({
          session_token: "",
          token_type: "Bearer",
          expires_in_seconds: 0,
          account_id: "",
        });
      }

      throw new Error(`unexpected fetch: ${url.toString()}`);
    }) as typeof fetch;

    const loginResult = startDeusCloudLogin().catch((error) => error as Error);
    await vi.waitFor(() => expect(electronMocks.openExternal).toHaveBeenCalledTimes(1));

    const loginUrl = new URL(electronMocks.openExternal.mock.calls[0]?.[0] as string);
    const callbackUrl = new URL(loginUrl.searchParams.get("redirect_uri") ?? "");
    callbackUrl.searchParams.set("code", "workos-code");
    callbackUrl.searchParams.set("state", loginUrl.searchParams.get("state") ?? "");
    await expect(originalFetch(callbackUrl)).resolves.toMatchObject({ status: 200 });

    await expect(loginResult).resolves.toMatchObject({
      message: "Deus Cloud returned an invalid desktop session",
    });
    await expect(getDeusCloudSessionStatus()).resolves.toMatchObject({ signedIn: false });
  });
});

describe("device keys of a session that ended", () => {
  /**
   * One scripted cloud, platform and backend. Each sign-in exchanges for the next
   * session (`session-1`, `session-2`); a mint answers with a key named after the
   * session that asked, and is held open for the sessions in `holdFor`.
   */
  function scriptedCloud() {
    const script = {
      exchanges: 0,
      holdFor: new Set<string>(),
      release: new Map<string, () => void>(),
      mintedKeyIds: [] as string[],
      revokedKeyIds: [] as string[],
      pushes: [] as Array<{ orgKeys: Record<string, string> }>,
    };
    process.env.DEUS_BACKEND_PORT = "51999";
    process.env.DEUS_AUTH_TOKEN = "local-token";
    global.fetch = vi.fn(async (input, init) => {
      const url = new URL(String(input));
      const bearer = String(
        (init?.headers as Record<string, string> | undefined)?.authorization ?? ""
      ).replace(/^Bearer /, "");
      if (url.pathname === "/api/settings/cloud/credentials") {
        script.pushes.push(JSON.parse(String(init?.body)));
        return Response.json({ ok: true });
      }
      if (url.hostname === "127.0.0.1") return originalFetch(input, init);
      if (url.pathname === "/auth/desktop/config") {
        return Response.json({
          authorization_endpoint: "https://api.workos.test/user_management/authorize",
          client_id: "client_test",
          provider: "authkit",
          redirect_uri: "http://127.0.0.1:*/auth/callback",
        });
      }
      if (url.pathname === "/auth/desktop/exchange") {
        script.exchanges += 1;
        return Response.json({
          session_token: `session-${script.exchanges}`,
          token_type: "Bearer",
          expires_in_seconds: 24 * 60 * 60,
          account_id: "user_test",
          refresh_token: `refresh-${script.exchanges}`,
        });
      }
      if (url.pathname === "/auth/desktop/refresh") return new Response(null, { status: 401 });
      if (url.pathname === "/me") return Response.json({ account: { name: "Ada" } });
      if (url.pathname === "/orgs") return Response.json({ items: [{ id: "org_1" }] });
      if (url.pathname === "/secrets") return Response.json({ items: [] });
      const revoke = url.pathname.match(/\/api-keys\/([^/]+)$/);
      if (revoke && init?.method === "DELETE") {
        script.revokedKeyIds.push(revoke[1]);
        return Response.json({ ok: true });
      }
      if (url.pathname.endsWith("/api-keys") && init?.method === "POST") {
        const minted = () => {
          script.mintedKeyIds.push(`key_${bearer}`);
          return Response.json(
            { id: `key_${bearer}`, key: `agnt_sk_${bearer}`, label: "deus-desktop mac" },
            { status: 201 }
          );
        };
        if (!script.holdFor.has(bearer)) return minted();
        return new Promise<Response>((resolve) =>
          script.release.set(bearer, () => resolve(minted()))
        );
      }
      throw new Error(`unexpected fetch: ${url.toString()}`);
    }) as typeof fetch;
    return script;
  }

  async function signIn(): Promise<void> {
    const opened = electronMocks.openExternal.mock.calls.length;
    const login = startDeusCloudLogin();
    await vi.waitFor(() => expect(electronMocks.openExternal).toHaveBeenCalledTimes(opened + 1));
    const loginUrl = new URL(electronMocks.openExternal.mock.calls[opened]?.[0] as string);
    const callbackUrl = new URL(loginUrl.searchParams.get("redirect_uri") ?? "");
    callbackUrl.searchParams.set("code", "workos-code");
    callbackUrl.searchParams.set("state", loginUrl.searchParams.get("state") ?? "");
    await originalFetch(callbackUrl);
    await expect(login).resolves.toMatchObject({ success: true });
  }

  /** Let background work that has nothing left to wait on finish. */
  const settle = () => new Promise((resolve) => setTimeout(resolve, 200));

  it("a first sign-in's provisioning that ends last leaves the next sign-in's keys alone", async () => {
    const script = scriptedCloud();
    script.holdFor.add("session-1");

    await signIn();
    await vi.waitFor(() => expect(script.release.has("session-1")).toBe(true));
    await signOutDeusCloud();
    await signIn();
    await vi.waitFor(() =>
      expect(script.pushes.some((push) => push.orgKeys.org_1 === "agnt_sk_session-2")).toBe(true)
    );

    script.release.get("session-1")?.();
    await vi.waitFor(() => expect(script.revokedKeyIds).toContain("key_session-1"));
    await settle();

    expect(await listOrgKeys()).toMatchObject([{ orgId: "org_1", keyId: "key_session-2" }]);
    expect(script.revokedKeyIds).not.toContain("key_session-2");
    expect(script.pushes.at(-1)?.orgKeys).toEqual({ org_1: "agnt_sk_session-2" });
  });

  it("a sign-out while sign-in's provisioning reads the session token leaves no key", async () => {
    const script = scriptedCloud();
    fileReads.holdNextSessionRead = true;

    await signIn();
    // Provisioning has read the session file and is held before it returns the token.
    await vi.waitFor(() => expect(fileReads.held).not.toBeNull());
    await signOutDeusCloud();

    fileReads.held?.();
    fileReads.held = null;
    await settle();

    expect(await listOrgKeys()).toEqual([]);
    expect(script.pushes.every((push) => Object.keys(push.orgKeys).length === 0)).toBe(true);
    for (const keyId of script.mintedKeyIds) expect(script.revokedKeyIds).toContain(keyId);
  });

  it("a session the server revokes ends a mint in flight: nothing stored, nothing pushed", async () => {
    const script = scriptedCloud();
    // Registers the session-revoked handler, as the app does at startup.
    provisionAtStartup(async () => null, "https://cloud.test");
    script.holdFor.add("session-1");

    await signIn();
    await vi.waitFor(() => expect(script.release.has("session-1")).toBe(true));

    // A day later the refresh is refused: the server revoked the session.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 25 * 60 * 60 * 1000);
    try {
      await expect(getDeusCloudSessionStatus()).resolves.toMatchObject({ signedIn: false });
    } finally {
      vi.useRealTimers();
    }

    script.release.get("session-1")?.();
    await vi.waitFor(() => expect(script.revokedKeyIds).toContain("key_session-1"));
    await settle();

    expect(await listOrgKeys()).toEqual([]);
    expect(script.pushes.every((push) => Object.keys(push.orgKeys).length === 0)).toBe(true);
  });
});
