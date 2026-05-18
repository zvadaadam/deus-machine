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
  handleDeusCloudAuthCallbackUrl,
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
          redirect_uri: "deus-machine://auth/callback",
        });
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
    expect(loginUrl.searchParams.get("redirect_uri")).toBe("deus-machine://auth/callback");
    expect(loginUrl.searchParams.get("provider")).toBe("authkit");
    expect(loginUrl.searchParams.get("code_challenge_method")).toBe("S256");

    const state = loginUrl.searchParams.get("state");
    expect(state).toBeTruthy();

    await expect(
      handleDeusCloudAuthCallbackUrl(`deus-machine://auth/callback?code=workos-code&state=${state}`)
    ).resolves.toBe(true);

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
});
