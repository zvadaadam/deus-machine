import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getProviderAccounts } from "../../../src/services/provider-accounts.service";
import {
  resetCloudConfigForTests,
  setCloudRuntimeCredentials,
} from "../../../src/services/agent/cloud/config";

const fetchMock = vi.fn();
const accounts = { providers: [], accounts: [], defaultAccountIds: {} };
beforeEach(() => {
  resetCloudConfigForTests();
  fetchMock.mockReset().mockResolvedValue(new Response(JSON.stringify(accounts)));
  vi.stubGlobal("fetch", fetchMock);
  setCloudRuntimeCredentials({
    deusCloudUrl: "https://cloud.test",
    deusCloudSessionToken: "workos-a",
  });
});
afterEach(() => {
  resetCloudConfigForTests();
  vi.unstubAllGlobals();
});

describe("personal provider account preflight", () => {
  it("reads metadata using the product session, independently of the device key", async () => {
    expect(await getProviderAccounts()).toEqual(accounts);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://cloud.test/me/provider-accounts");
    expect(init.headers).toEqual({ authorization: "Bearer workos-a" });
    expect(init.redirect).toBe("manual");
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("does not substitute an organization key for a signed-out account", async () => {
    setCloudRuntimeCredentials({ apiKey: "org-key", deusCloudSessionToken: null });
    await expect(getProviderAccounts()).rejects.toThrow("Sign in to Deus Cloud");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects results from the previous account", async () => {
    fetchMock.mockImplementationOnce(async () => {
      setCloudRuntimeCredentials({ deusCloudSessionToken: "workos-b" });
      return new Response(JSON.stringify(accounts));
    });
    await expect(getProviderAccounts()).rejects.toThrow("account changed");
  });

  it("surfaces a failed metadata lookup without falling back to secrets", async () => {
    fetchMock.mockResolvedValueOnce(new Response("private diagnostic", { status: 401 }));
    await expect(getProviderAccounts()).rejects.toThrow("Couldn't check your provider accounts");
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});
