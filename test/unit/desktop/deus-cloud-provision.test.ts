import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const electronMocks = vi.hoisted(() => ({
  userDataDir: "",
}));

vi.mock("electron", () => ({
  app: {
    getPath: () => electronMocks.userDataDir,
  },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(value, "utf8"),
    decryptString: (value: Buffer) => value.toString("utf8"),
  },
}));

import {
  getOrgKey,
  getOrgKeys,
  listOrgKeys,
  setOrgKey,
} from "../../../apps/desktop/main/cloud-credentials";
import {
  ensureDeviceKeys,
  getPlatformKeyError,
  parseOrgList,
  provisionAfterLogin,
  pushCloudCredentialsToBackend,
  resolveAgntBaseUrl,
  revokeDeviceKeys,
} from "../../../apps/desktop/main/deus-cloud-provision";

const fetchMock = vi.fn();

beforeEach(async () => {
  electronMocks.userDataDir = await mkdtemp(join(tmpdir(), "deus-provision-"));
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  vi.stubEnv("DEUS_CLOUD_AGNT_URL", "https://agnt.test");
});

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  await rm(electronMocks.userDataDir, { recursive: true, force: true });
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("resolveAgntBaseUrl", () => {
  it("mirrors the backend precedence and strips trailing slash", () => {
    expect(resolveAgntBaseUrl({ DEUS_CLOUD_AGNT_URL: "https://a.example/" })).toBe(
      "https://a.example"
    );
    expect(resolveAgntBaseUrl({ AGNT_BASE_URL: "https://b.example" })).toBe("https://b.example");
    expect(resolveAgntBaseUrl({})).toBe("https://api.deusmachine.ai");
  });
});

describe("parseOrgList", () => {
  it("accepts a bare array, a wrapped list, and snake/camel ids", () => {
    // The shape deus-cloud's GET /orgs actually serves (`c.json({ items: rows })`).
    // Pinned FIRST because assuming the others is what broke every real sign-in:
    // the parser returned [], the mint never ran, and the failure was log-only.
    expect(parseOrgList({ items: [{ id: "org_1", name: "A" }] })).toEqual([
      { id: "org_1", name: "A" },
    ]);
    expect(parseOrgList([{ id: "org_1", name: "A" }])).toEqual([{ id: "org_1", name: "A" }]);
    expect(parseOrgList({ organizations: [{ organization_id: "org_2" }] })).toEqual([
      { id: "org_2", name: undefined },
    ]);
    expect(parseOrgList({ organizations: [{ organizationId: "org_3" }] })).toEqual([
      { id: "org_3", name: undefined },
    ]);
  });

  it("drops malformed entries instead of throwing", () => {
    expect(parseOrgList([null, {}, { id: 42 }, "x"])).toEqual([]);
    expect(parseOrgList(undefined)).toEqual([]);
  });
});

/**
 * A URL-dispatched platform: the probes and mints for different organizations
 * run in PARALLEL, so sequence-based mocks would depend on scheduling order.
 */
function platformMock(handlers: {
  orgs?: () => Response | Promise<Response>;
  /** The key probe: `key` is the bearer it was asked with. */
  secrets?: (key: string) => Response | Promise<Response>;
  mint?: (orgId: string) => Response | Promise<Response>;
  revoke?: (orgId: string, keyId: string) => Response;
}) {
  fetchMock.mockImplementation(async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const bearer = String(
      (init?.headers as Record<string, string> | undefined)?.authorization ?? ""
    ).replace(/^Bearer /, "");
    if (url.endsWith("/secrets")) {
      return handlers.secrets ? handlers.secrets(bearer) : jsonResponse({ items: [] });
    }
    const mint = url.match(/\/dashboard\/orgs\/([^/]+)\/api-keys$/);
    if (mint) {
      if (!handlers.mint) throw new Error(`unexpected mint for ${mint[1]}`);
      return handlers.mint(mint[1]);
    }
    const revoke = url.match(/\/dashboard\/orgs\/([^/]+)\/api-keys\/([^/]+)$/);
    if (revoke && init?.method === "DELETE") {
      return handlers.revoke ? handlers.revoke(revoke[1], revoke[2]) : jsonResponse({ ok: true });
    }
    if (url.includes("/api/settings/cloud/credentials")) return jsonResponse({ ok: true });
    if (url.endsWith("/orgs")) {
      return handlers.orgs ? handlers.orgs() : jsonResponse({ items: [{ id: "org_1" }] });
    }
    throw new Error(`unexpected fetch: ${url}`);
  });
}

const minted = (orgId: string) =>
  jsonResponse({ id: `key_${orgId}`, key: `agnt_sk_${orgId}`, label: "deus-desktop mac" }, 201);
const urls = () => fetchMock.mock.calls.map((call) => String(call[0]));
const mints = () => urls().filter((url) => url.endsWith("/api-keys"));

describe("ensureDeviceKeys", () => {
  it("looks up the orgs with the session token, mints with hostname label, stores key + meta", async () => {
    platformMock({
      orgs: () => jsonResponse([{ id: "org_1", name: "Adam's Organization" }]),
      mint: minted,
    });

    expect(await ensureDeviceKeys("session-jwt", "https://cloud.test")).toBeNull();

    const orgCall = fetchMock.mock.calls.find((call) => String(call[0]).endsWith("/orgs"))!;
    expect(orgCall[0]).toBe("https://cloud.test/orgs");
    expect(orgCall[1].headers.authorization).toBe("Bearer session-jwt");
    const mintCall = fetchMock.mock.calls.find((call) => String(call[0]).endsWith("/api-keys"))!;
    expect(mintCall[0]).toBe("https://agnt.test/dashboard/orgs/org_1/api-keys");
    expect(JSON.parse(mintCall[1].body).label).toContain("deus-desktop");

    expect(await getOrgKey("org_1")).toBe("agnt_sk_org_1");
    expect(await listOrgKeys()).toMatchObject([{ orgId: "org_1", keyId: "key_org_1" }]);
  });

  it("gets two organizations two keys, in the platform's order", async () => {
    platformMock({
      orgs: () => jsonResponse({ items: [{ id: "org_b" }, { id: "org_a" }] }),
      mint: minted,
    });

    await ensureDeviceKeys("session-jwt", "https://cloud.test");

    expect(await getOrgKeys()).toEqual({ org_b: "agnt_sk_org_b", org_a: "agnt_sk_org_a" });
    expect(Object.keys(await getOrgKeys())).toEqual(["org_b", "org_a"]);
  });

  it("is idempotent: a valid key in each listed organization skips the mint", async () => {
    await setOrgKey("org_1", "agnt_sk_existing", { keyId: "key_1" });
    platformMock({});

    await ensureDeviceKeys("session-jwt", "https://cloud.test");

    expect(await getOrgKey("org_1")).toBe("agnt_sk_existing");
    expect(mints()).toEqual([]);
  });

  it("deletes nothing and mints nothing when the list's order changes", async () => {
    await setOrgKey("org_a", "agnt_sk_a", { keyId: "key_a" });
    await setOrgKey("org_b", "agnt_sk_b", { keyId: "key_b" });
    platformMock({ orgs: () => jsonResponse({ items: [{ id: "org_b" }, { id: "org_a" }] }) });

    expect(await ensureDeviceKeys("session-jwt", "https://cloud.test")).toBeNull();

    expect(await getOrgKeys()).toEqual({ org_b: "agnt_sk_b", org_a: "agnt_sk_a" });
    expect(mints()).toEqual([]);
    expect(fetchMock.mock.calls.some((call) => call[1]?.method === "DELETE")).toBe(false);
    // The new first organization is the default now.
    expect((await listOrgKeys()).map((key) => key.orgId)).toEqual(["org_b", "org_a"]);
  });

  it("retires the key of an organization the account no longer lists", async () => {
    await setOrgKey("org_a", "agnt_sk_a", { keyId: "key_a" });
    await setOrgKey("org_gone", "agnt_sk_gone", { keyId: "key_gone" });
    platformMock({ orgs: () => jsonResponse({ items: [{ id: "org_a" }] }) });

    await ensureDeviceKeys("session-jwt", "https://cloud.test");

    expect(await getOrgKeys()).toEqual({ org_a: "agnt_sk_a" });
    const revoke = fetchMock.mock.calls.find((call) => call[1]?.method === "DELETE")!;
    expect(revoke[0]).toBe("https://agnt.test/dashboard/orgs/org_gone/api-keys/key_gone");
    expect(revoke[1].headers.authorization).toBe("Bearer session-jwt");
  });

  it("re-mints for a DIFFERENT account: the previous account's organization is not on its list", async () => {
    // A 401-expired session clears only the session file; without the
    // ownership check, signing into account B silently reused A's org key.
    await setOrgKey("org_a", "agnt_sk_org_a", { keyId: "key_a" });
    platformMock({ mint: minted });

    await ensureDeviceKeys("session-jwt", "https://cloud.test");

    expect(await getOrgKeys()).toEqual({ org_1: "agnt_sk_org_1" });
  });

  it("one failing mint does not block the other organization", async () => {
    platformMock({
      orgs: () =>
        jsonResponse({
          items: [
            { id: "org_a", name: "Acme" },
            { id: "org_b", name: "Beta" },
          ],
        }),
      mint: (orgId) =>
        orgId === "org_a" ? jsonResponse({ error: "FORBIDDEN" }, 403) : minted(orgId),
    });

    const failure = await ensureDeviceKeys("session-jwt", "https://cloud.test");

    expect(failure).toBe("Acme: device key mint failed (403)");
    expect(await getOrgKeys()).toEqual({ org_b: "agnt_sk_org_b" });
  });

  it("keeps the stored keys when neither probe can reach the platform", async () => {
    await setOrgKey("org_1", "agnt_sk_existing", { keyId: "key_1" });
    platformMock({
      secrets: () => Promise.reject(new Error("ENOTFOUND")),
      orgs: () => Promise.reject(new Error("ENOTFOUND")),
    });

    // Offline is neither revoked nor foreign: the key is kept and no mint is attempted.
    expect(await ensureDeviceKeys("session-jwt", "https://cloud.test")).toBeNull();

    expect(await getOrgKey("org_1")).toBe("agnt_sk_existing");
    expect(mints()).toEqual([]);
  });

  it("re-mints when a stored key was revoked server-side", async () => {
    await setOrgKey("org_1", "agnt_sk_revoked", { keyId: "key_1" });
    platformMock({
      secrets: () => jsonResponse({ error: "UNAUTHORIZED" }, 401),
      mint: () => jsonResponse({ id: "key_2", key: "agnt_sk_fresh", label: "Mac" }),
    });

    await ensureDeviceKeys("session-jwt", "https://cloud.test");

    expect(await getOrgKey("org_1")).toBe("agnt_sk_fresh");
  });

  it("surfaces a mint failure without storing anything", async () => {
    platformMock({ mint: () => jsonResponse({ error: "FORBIDDEN" }, 403) });

    expect(await ensureDeviceKeys("session-jwt", "https://cloud.test")).toContain("403");
    expect(await getOrgKeys()).toEqual({});
  });

  it("throws when the list cannot be read and nothing is stored", async () => {
    platformMock({ orgs: () => jsonResponse({ items: [] }) });
    await expect(ensureDeviceKeys("session-jwt", "https://cloud.test")).rejects.toThrow(
      /no organization/
    );
  });
});

describe("pushCloudCredentialsToBackend", () => {
  it("is a quiet no-op before the backend is up", async () => {
    vi.stubEnv("DEUS_BACKEND_PORT", "");
    expect(await pushCloudCredentialsToBackend()).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("posts every organization's key to the local credentials route with the backend auth token", async () => {
    vi.stubEnv("DEUS_BACKEND_PORT", "51999");
    vi.stubEnv("DEUS_AUTH_TOKEN", "local-token");
    await setOrgKey("org_a", "agnt_sk_live_a");
    await setOrgKey("org_b", "agnt_sk_live_b");
    fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true }));

    expect(await pushCloudCredentialsToBackend()).toBe(true);

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("http://127.0.0.1:51999/api/settings/cloud/credentials");
    expect(init.headers.authorization).toBe("Bearer local-token");
    // The full contract: one key per organization PLUS the deus-cloud mint
    // context the backend needs to request per-repo GitHub App installation tokens.
    expect(JSON.parse(init.body)).toEqual({
      deusCloudUrl: expect.any(String),
      deusCloudSessionToken: null,
      orgKeys: { org_a: "agnt_sk_live_a", org_b: "agnt_sk_live_b" },
    });
  });
});

describe("revokeDeviceKeys", () => {
  it("revokes every organization's key server-side when possible, deletes locally, and clears the backend", async () => {
    vi.stubEnv("DEUS_BACKEND_PORT", "51999");
    vi.stubEnv("DEUS_AUTH_TOKEN", "local-token");
    await setOrgKey("org_1", "agnt_sk_live_x", { keyId: "key_9" });
    await setOrgKey("org_2", "agnt_sk_live_y", { keyId: "key_8" });
    fetchMock.mockResolvedValue(jsonResponse({ ok: true }));

    await revokeDeviceKeys("session-jwt");

    const revokes = fetchMock.mock.calls.filter((call) => call[1]?.method === "DELETE");
    expect(revokes.map((call) => call[0]).sort()).toEqual([
      "https://agnt.test/dashboard/orgs/org_1/api-keys/key_9",
      "https://agnt.test/dashboard/orgs/org_2/api-keys/key_8",
    ]);
    expect(await getOrgKeys()).toEqual({});

    // The backend push at the end must clear the keys, not resend them.
    const pushCall = fetchMock.mock.calls.at(-1);
    expect(pushCall?.[0]).toContain("/api/settings/cloud/credentials");
    expect(JSON.parse(pushCall?.[1].body).orgKeys).toEqual({});
  });

  it("offline sign-out still deletes the local keys", async () => {
    await setOrgKey("org_1", "agnt_sk_live_x", { keyId: "key_9" });
    fetchMock.mockRejectedValue(new Error("offline"));

    await revokeDeviceKeys("session-jwt");

    expect(await getOrgKeys()).toEqual({});
  });

  it("sign-out clears the provisioning error the account left behind", async () => {
    platformMock({ mint: () => jsonResponse({ error: "FORBIDDEN" }, 403) });
    await provisionAfterLogin("session-jwt", "https://cloud.test");
    expect(getPlatformKeyError()).toContain("403");

    await revokeDeviceKeys("session-jwt");

    expect(getPlatformKeyError()).toBeNull();
  });
});
