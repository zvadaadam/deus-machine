import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { openExternal, fetchMock } = vi.hoisted(() => ({
  openExternal: vi.fn(),
  fetchMock: vi.fn(),
}));
vi.mock("electron", () => ({ shell: { openExternal }, ipcMain: {} }));
vi.mock("../../../apps/desktop/main/cloud-credentials", () => ({
  // The default organization first.
  listOrgKeys: async () => [{ orgId: "personal-org" }, { orgId: "team-org" }],
}));
vi.mock("../../../apps/desktop/main/deus-cloud-auth", () => ({
  getStoredDeusCloudSessionToken: async () => "desktop-session",
}));
vi.mock("../../../apps/desktop/main/deus-cloud-provision", () => ({ PLATFORM_TIMEOUT_MS: 1000 }));
vi.mock("../../../apps/desktop/main/deus-cloud-auth-contract", () => ({
  resolveDeusCloudUrl: () => "https://cloud.test",
}));

import { getGithubAppState, startGithubAppInstall } from "../../../apps/desktop/main/github-app";

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe("GitHub App install handoff", () => {
  it("preserves the cloud's OAuth configuration error instead of claiming the app is unregistered", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json(
        { error: "CONFIG_ERROR", message: "GitHub user authorization is not configured" },
        { status: 503 }
      )
    );
    expect(await startGithubAppInstall()).toEqual({
      ok: false,
      error: "GitHub user authorization is not configured",
    });
    expect(openExternal).not.toHaveBeenCalled();
  });

  it.each([404, 502])(
    "handles an unavailable route or non-JSON gateway error (%s)",
    async (status) => {
      fetchMock.mockResolvedValueOnce(new Response("Unavailable", { status }));
      const result = await startGithubAppInstall();
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/GitHub linking/);
      expect(openExternal).not.toHaveBeenCalled();
    }
  );

  it("opens the signed GitHub install link returned by the selected cloud", async () => {
    const url = "https://github.com/apps/deus-test/installations/new?state=signed";
    fetchMock.mockResolvedValueOnce(Response.json({ url }));
    expect(await startGithubAppInstall()).toEqual({ ok: true });
    expect(openExternal).toHaveBeenCalledWith(url);
  });
});

describe("organizations", () => {
  it("asks about the default organization when none is named, and the named one otherwise", async () => {
    fetchMock.mockImplementation(async () =>
      Response.json({ installations: [], app_slug: "deus" })
    );
    await getGithubAppState();
    await getGithubAppState("team-org");
    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
      "https://cloud.test/orgs/personal-org/github/installation",
      "https://cloud.test/orgs/team-org/github/installation",
    ]);
  });

  it("installs into the organization it is given", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({ url: "https://github.com/apps/deus-test/installations/new" })
    );
    expect(await startGithubAppInstall("team-org")).toEqual({ ok: true });
    expect(String(fetchMock.mock.calls[0][0])).toBe(
      "https://cloud.test/orgs/team-org/github/install-url"
    );
  });
});
