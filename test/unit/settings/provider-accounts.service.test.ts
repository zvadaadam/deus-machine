import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cancelProviderAccountLogin,
  saveProviderAccountSecret,
  disconnectProviderAccount,
  listProviderAccounts,
  startProviderAccountLogin,
  updateProviderAccount,
  waitForProviderAccountLogin,
} from "@/features/settings/api/provider-accounts.service";

const state = vi.hoisted(() => ({ getBaseURL: vi.fn() }));
vi.mock("@/shared/config/api.config", () => ({ getBaseURL: state.getBaseURL }));
vi.mock("@/features/auth/hooks/useAuth", () => ({
  needsRemoteAuth: () => false,
  getStoredToken: () => null,
}));
vi.mock("@/shared/api/queryClient", () => ({ queryClient: { invalidateQueries: vi.fn() } }));
const fetchMock = vi.fn();
const storage = new Map<string, string>();
const account = {
  id: "account-a",
  provider: "codex",
  authMethod: "subscription",
  label: "Personal",
  email: "person@example.com",
  planType: "plus",
  status: "connected",
  isDefault: true,
};

beforeEach(() => {
  fetchMock.mockReset();
  state.getBaseURL.mockReset().mockResolvedValue("http://localhost:5123/api");
  storage.clear();
  storage.set("deus_cloud_session", "browser-workos-bearer");
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("sessionStorage", {
    getItem: (key: string) => storage.get(key) ?? null,
    removeItem: (key: string) => storage.delete(key),
    setItem: (key: string, value: string) => storage.set(key, value),
  });
  vi.stubGlobal("localStorage", { getItem: () => null });
  vi.stubGlobal("window", {
    location: { pathname: "/settings", search: "", origin: "https://deusmachine.ai", href: "" },
  });
  vi.stubEnv("VITE_CLOUD_DIRECT", "1");
  vi.stubEnv("VITE_DEUS_CLOUD_URL", "https://cloud.test");
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("provider account transport", () => {
  it("uses the hosted web auth origin and bearer without resolving a localhost backend", async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({ accounts: [account], defaultAccountIds: { codex: account.id } })
      )
    );
    expect((await listProviderAccounts()).accounts).toEqual([account]);
    expect(fetchMock.mock.calls[0][0]).toBe("https://cloud.test/me/provider-accounts");
    expect(fetchMock.mock.calls[0][1].headers.get("authorization")).toBe(
      "Bearer browser-workos-bearer"
    );
    expect(state.getBaseURL).not.toHaveBeenCalled();
  });

  it("uses the backend proxy on backed builds without giving it the cloud bearer", async () => {
    vi.stubEnv("VITE_CLOUD_DIRECT", "0");
    fetchMock.mockResolvedValue(
      new Response('{"providers":[],"accounts":[],"defaultAccountIds":{}}')
    );
    await listProviderAccounts();
    expect(fetchMock.mock.calls[0][0]).toBe("http://localhost:5123/api/settings/provider-accounts");
    expect(fetchMock.mock.calls[0][1].headers.get("authorization")).toBeNull();
  });

  it("sends only account labels and references for login, default changes, disconnect and cancel", async () => {
    fetchMock.mockImplementation(() => Promise.resolve(new Response("{}")));
    const controller = new AbortController();
    await startProviderAccountLogin(
      { provider: "codex", label: "Work", replaceAccountId: "account-a" },
      controller.signal
    );
    await updateProviderAccount("account-a", { isDefault: true });
    await disconnectProviderAccount("account-a");
    await cancelProviderAccountLogin("login-a");
    expect(
      fetchMock.mock.calls.map(([url, options]) => [url, options.method, options.body])
    ).toEqual([
      [
        "https://cloud.test/me/provider-accounts/logins",
        "POST",
        '{"provider":"codex","label":"Work","replaceAccountId":"account-a"}',
      ],
      ["https://cloud.test/me/provider-accounts/account-a", "PATCH", '{"isDefault":true}'],
      ["https://cloud.test/me/provider-accounts/account-a", "DELETE", undefined],
      ["https://cloud.test/me/provider-accounts/logins/login-a", "DELETE", undefined],
    ]);
    expect(fetchMock.mock.calls[0][1].signal).toBe(controller.signal);
  });

  it("shows the API's message instead of its stable error code", async () => {
    fetchMock.mockResolvedValue(
      new Response('{"error":"identity_mismatch","message":"Use the original ChatGPT account."}', {
        status: 409,
      })
    );
    await expect(updateProviderAccount("a", { isDefault: true })).rejects.toThrow(
      "Use the original ChatGPT account."
    );
  });

  it.each(["claude", "codex"] as const)(
    "saves a %s API key through the same write-only endpoint",
    async (provider) => {
      fetchMock.mockResolvedValue(new Response(JSON.stringify({ account })));
      const controller = new AbortController();
      const input = {
        provider,
        authMethod: "api_key" as const,
        secret: "test-key",
        label: "Work",
        replaceAccountId: "account-a",
      };
      expect(await saveProviderAccountSecret(input, controller.signal)).toBeUndefined();
      expect(fetchMock.mock.calls[0][0]).toBe("https://cloud.test/me/provider-accounts");
      expect(fetchMock.mock.calls[0][1].method).toBe("POST");
      expect(fetchMock.mock.calls[0][1].body).toBe(JSON.stringify(input));
      expect(fetchMock.mock.calls[0][1].signal).toBe(controller.signal);
      expect(fetchMock.mock.calls[0][1].headers.get("content-type")).toBe("application/json");
    }
  );

  it("does not send requests when signed out", async () => {
    storage.clear();
    await expect(listProviderAccounts()).rejects.toThrow("Sign in to Deus Cloud");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("expires the hosted Deus identity on a 401", async () => {
    fetchMock.mockResolvedValue(new Response('{"message":"Sign in again."}', { status: 401 }));
    await expect(listProviderAccounts()).rejects.toThrow("Sign in again.");
    expect(storage.has("deus_cloud_session")).toBe(false);
    expect(window.location.href).toContain("https://cloud.test/auth/login");
  });
});

describe("device login event stream", () => {
  it("accepts a completed login across arbitrary chunks and keepalive comments, then closes the stream", async () => {
    const cancelled = vi.fn();
    const encoded = new TextEncoder().encode(
      `:keepalive\r\n\r\nevent: connected\r\ndata: ${JSON.stringify({ account: { ...account, label: "Práce" } })}\r\n\r\n`
    );
    fetchMock.mockResolvedValue(
      new Response(
        new ReadableStream({
          start(controller) {
            for (const byte of encoded) controller.enqueue(Uint8Array.of(byte));
          },
          cancel: cancelled,
        })
      )
    );
    expect(await waitForProviderAccountLogin("login-a", new AbortController().signal)).toEqual({
      ...account,
      label: "Práce",
    });
    expect(cancelled).toHaveBeenCalledOnce();
  });

  it("surfaces expiry/cancellation errors and a stream that closes without completion", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response('event: error\ndata: {"message":"This code expired. Try again."}\n\n')
    );
    await expect(
      waitForProviderAccountLogin("expired", new AbortController().signal)
    ).rejects.toThrow("This code expired. Try again.");
    fetchMock.mockResolvedValueOnce(new Response(":keepalive\n\n"));
    await expect(
      waitForProviderAccountLogin("closed", new AbortController().signal)
    ).rejects.toThrow("connection closed");
  });
});
