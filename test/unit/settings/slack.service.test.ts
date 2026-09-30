import { afterEach, expect, it, vi } from "vitest";
import { CloudSettingsError } from "@/features/settings/api/cloud-settings.service";
import {
  disconnectSlackInstallation,
  getSlackInstallUrl,
  getSlackOrganization,
  listSlackInstallations,
  saveSlackEnvironmentDescription,
  shareCompanyModelAccount,
  stopSharingCompanyModelAccount,
} from "@/features/settings/api/slack.service";
import { isCloudDirectWebMode } from "@/features/session/cloud/webCloudDirectConfig";

vi.mock("@/shared/config/api.config", () => ({ getBaseURL: async () => "http://127.0.0.1/api" }));
vi.mock("@/features/auth/hooks/useAuth", () => ({
  getStoredToken: vi.fn(),
  needsRemoteAuth: () => false,
}));
vi.mock("@/features/session/cloud/webCloudDirectConfig", () => ({
  isCloudDirectWebMode: vi.fn(() => true),
  readWebCloudSessionBearer: async () => "test-session",
  resolveAgntBaseUrl: () => "https://platform.test",
  resolveDeusCloudUrl: () => "https://product.test",
  handleWebCloudSessionExpired: vi.fn(),
}));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  vi.mocked(isCloudDirectWebMode).mockReturnValue(true);
});

it.each([
  {
    name: "lists installations",
    call: () => listSlackInstallations("org", new AbortController().signal),
    direct: "https://product.test/orgs/org/slack/installations",
    desktop: "http://127.0.0.1/api/settings/slack/installations?organizationId=org",
    method: undefined,
    body: undefined,
  },
  {
    name: "disconnects an installation",
    call: () => disconnectSlackInstallation("org", "inst/one", new AbortController().signal),
    direct: "https://product.test/orgs/org/slack/installations/inst%2Fone",
    desktop: "http://127.0.0.1/api/settings/slack/installations/inst%2Fone?organizationId=org",
    method: "DELETE",
    body: undefined,
  },
  {
    name: "loads the organization",
    call: () => getSlackOrganization("org", new AbortController().signal),
    direct: "https://platform.test/dashboard/orgs/org",
    desktop: "http://127.0.0.1/api/settings/slack/organization?organizationId=org",
    method: undefined,
    body: undefined,
  },
  {
    name: "shares the company account",
    call: () => shareCompanyModelAccount("org", new AbortController().signal),
    direct: "https://platform.test/dashboard/orgs/org/company-model-account",
    desktop: "http://127.0.0.1/api/settings/slack/company-model-account?organizationId=org",
    method: "PUT",
    body: undefined,
  },
  {
    name: "stops sharing the company account",
    call: () => stopSharingCompanyModelAccount("org", new AbortController().signal),
    direct: "https://platform.test/dashboard/orgs/org/company-model-account",
    desktop: "http://127.0.0.1/api/settings/slack/company-model-account?organizationId=org",
    method: "DELETE",
    body: undefined,
  },
  {
    name: "saves a routing description",
    call: () =>
      saveSlackEnvironmentDescription(
        "org",
        "env/one",
        "backend API",
        new AbortController().signal
      ),
    direct:
      "https://platform.test/dashboard/orgs/org/environment-settings/environments/env%2Fone/description",
    desktop:
      "http://127.0.0.1/api/settings/slack/environments/env%2Fone/description?organizationId=org",
    method: "PUT",
    body: JSON.stringify({ description: "backend API" }),
  },
])("builds the right Slack path in direct and desktop mode: $name", async (testCase) => {
  for (const direct of [true, false]) {
    vi.mocked(isCloudDirectWebMode).mockReturnValue(direct);
    const fetch = vi.fn(async () => Response.json({ ok: true }));
    vi.stubGlobal("fetch", fetch);
    await testCase.call();
    expect(fetch.mock.calls[0]).toEqual([
      direct ? testCase.direct : testCase.desktop,
      expect.objectContaining({
        ...(testCase.method ? { method: testCase.method } : {}),
        ...(testCase.body ? { body: testCase.body } : {}),
        headers: expect.objectContaining(direct ? { authorization: "Bearer test-session" } : {}),
        redirect: "error",
      }),
    ]);
  }
});

it("validates the Slack install URL before returning it", async () => {
  const fetch = vi.fn(async () =>
    Response.json({ url: "https://product.test/slack/install?state=abc" })
  );
  vi.stubGlobal("fetch", fetch);
  await expect(getSlackInstallUrl("org", new AbortController().signal)).resolves.toEqual({
    url: "https://product.test/slack/install?state=abc",
  });
  expect(fetch.mock.calls[0][0]).toBe("https://product.test/orgs/org/slack/install-url");
});

it.each([
  "https://elsewhere.test/slack/install?state=abc",
  "https://product.test/other?state=abc",
  "http://product.test/slack/install?state=abc",
  "https://product.test/slack/install",
])("rejects an invalid Slack install URL: %s", async (url) => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json({ url }))
  );
  await expect(getSlackInstallUrl("org", new AbortController().signal)).rejects.toThrow(
    "Slack connection returned an invalid link."
  );
});

it("preserves desktop-proxy cloud error codes", async () => {
  vi.mocked(isCloudDirectWebMode).mockReturnValue(false);
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      Response.json(
        { error: "Connect a Claude account first", details: { code: "NO_PROVIDER_ACCOUNT" } },
        { status: 409 }
      )
    )
  );
  await expect(shareCompanyModelAccount("org", new AbortController().signal)).rejects.toMatchObject(
    {
      message: "Connect a Claude account first",
      status: 409,
      code: "NO_PROVIDER_ACCOUNT",
    } satisfies Partial<CloudSettingsError>
  );
});
