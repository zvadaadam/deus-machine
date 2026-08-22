import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const electronMocks = vi.hoisted(() => ({
  openExternal: vi.fn(),
  userDataDir: "",
  sentEvents: [] as Array<{ channel: string; payload: unknown }>,
}));

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

const originalFetch = global.fetch;
const originalEnv = { ...process.env };

beforeEach(async () => {
  vi.clearAllMocks();
  electronMocks.sentEvents = [];
  electronMocks.userDataDir = await mkdtemp(join(tmpdir(), "deus-cloud-auth-"));
  process.env.DEUS_MACHINE_CLOUD_URL = "http://cloud.test";
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
        cloudUrl: "http://cloud.test",
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
    process.env.DEUS_MACHINE_CLOUD_URL = "http://cloud.test/deus";
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
        cloudUrl: "http://cloud.test/deus",
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
