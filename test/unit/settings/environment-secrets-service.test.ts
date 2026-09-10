import { afterEach, expect, it, vi } from "vitest";
import {
  getEnvironmentInstallUrl,
  getEnvironmentSecretSettings,
  listEnvironmentRepositories,
  saveCloudEnvironmentSetup,
} from "@/features/settings/api/environment-secrets.service";
import {
  handleWebCloudSessionExpired,
  isCloudDirectWebMode,
} from "@/features/session/cloud/webCloudDirectConfig";

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

it.each([true, false])(
  "sends GitHub discovery to the product service with direct=%s",
  async (direct) => {
    vi.mocked(isCloudDirectWebMode).mockReturnValue(direct);
    const fetch = vi.fn(async () => Response.json({ repos: ["acme/app"] }));
    vi.stubGlobal("fetch", fetch);
    expect(await listEnvironmentRepositories("org", new AbortController().signal)).toEqual({
      repos: ["acme/app"],
    });
    expect(fetch.mock.calls[0]).toEqual([
      direct
        ? "https://product.test/orgs/org/github/accessible-repos"
        : "http://127.0.0.1/api/settings/environment-secrets/orgs/org/github/accessible-repos",
      expect.objectContaining({
        headers: expect.objectContaining(direct ? { authorization: "Bearer test-session" } : {}),
        redirect: "error",
      }),
    ]);
  }
);

it("rejects an installation link to a different host", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json({ url: "https://elsewhere.test/github.com" }))
  );
  await expect(getEnvironmentInstallUrl("org", new AbortController().signal)).rejects.toThrow(
    "invalid installation link"
  );
});

it("saves script content unchanged to the platform's setup-only route", async () => {
  const fetch = vi.fn(async () => Response.json({ id: "env" }));
  vi.stubGlobal("fetch", fetch);
  const setup = [
    { commands: ["export SOME_KEY=value\nbun run prepare"], phase: "pre-clone" as const },
    { parallel: [["bun install"], ["echo done"]] },
  ];
  await saveCloudEnvironmentSetup(
    "org",
    { environmentId: "env" },
    { setup, run: "bun run dev" },
    new AbortController().signal
  );
  expect(fetch.mock.calls[0]).toEqual([
    "https://platform.test/dashboard/orgs/org/environment-settings/environments/env",
    expect.objectContaining({ method: "PUT", body: JSON.stringify({ setup, run: "bun run dev" }) }),
  ]);
});

it.each([401, 502])(
  "shows a useful message for a non-JSON HTTP %s and expires a rejected session",
  async (status) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(status === 401 ? null : "Gateway unavailable", { status }))
    );
    await expect(
      getEnvironmentSecretSettings("org", null, new AbortController().signal)
    ).rejects.toThrow("Couldn't load cloud environment settings.");
    expect(handleWebCloudSessionExpired).toHaveBeenCalledTimes(status === 401 ? 1 : 0);
  }
);

it.each([
  { transport: "direct web", direct: true, body: { message: "Organization access denied" } },
  { transport: "desktop proxy", direct: false, body: { error: "Organization access denied" } },
])("preserves the $transport server's explanation", async ({ direct, body }) => {
  vi.mocked(isCloudDirectWebMode).mockReturnValue(direct);
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json(body, { status: 403 }))
  );
  await expect(
    getEnvironmentSecretSettings("org", null, new AbortController().signal)
  ).rejects.toThrow("Organization access denied");
  expect(handleWebCloudSessionExpired).not.toHaveBeenCalled();
});
