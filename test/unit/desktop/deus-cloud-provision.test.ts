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
  getCloudCredential,
  getCloudCredentialMeta,
  setCloudCredential,
} from "../../../apps/desktop/main/cloud-credentials";
import {
  ensureDeviceKey,
  parseOrgList,
  pushCloudCredentialsToBackend,
  resolveAgntBaseUrl,
  revokeDeviceKey,
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

describe("ensureDeviceKey", () => {
  it("looks up the org with the session token, mints with hostname label, stores key + meta", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse([{ id: "org_1", name: "Adam's Organization" }]))
      .mockResolvedValueOnce(
        jsonResponse({ id: "key_9", key: "agnt_sk_live_minted", label: "deus-desktop mac" }, 201)
      );

    await ensureDeviceKey("session-jwt", "https://cloud.test");

    const [orgCall, mintCall] = fetchMock.mock.calls;
    expect(orgCall[0]).toBe("https://cloud.test/orgs");
    expect(orgCall[1].headers.authorization).toBe("Bearer session-jwt");
    expect(mintCall[0]).toBe("https://agnt.test/dashboard/orgs/org_1/api-keys");
    expect(JSON.parse(mintCall[1].body).label).toContain("deus-desktop");

    expect(await getCloudCredential("agntApiKey")).toBe("agnt_sk_live_minted");
    expect(await getCloudCredentialMeta("agntApiKey")).toMatchObject({
      keyId: "key_9",
      orgId: "org_1",
    });
  });

  it("is idempotent: an existing stored key validates, then skips the mint", async () => {
    await setCloudCredential("agntApiKey", "agnt_sk_existing");
    fetchMock.mockResolvedValueOnce(jsonResponse({ items: [] }));

    await ensureDeviceKey("session-jwt", "https://cloud.test");

    // Exactly one call — the validation probe. No org lookup, no mint.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toContain("/secrets");
    expect(await getCloudCredential("agntApiKey")).toBe("agnt_sk_existing");
  });

  it("keeps the stored key when the validation probe cannot reach the platform", async () => {
    await setCloudCredential("agntApiKey", "agnt_sk_existing");
    fetchMock.mockRejectedValueOnce(new Error("ENOTFOUND"));

    await ensureDeviceKey("session-jwt", "https://cloud.test");

    // Offline is not revoked: no re-mint, key survives.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(await getCloudCredential("agntApiKey")).toBe("agnt_sk_existing");
  });

  it("re-mints when the stored key was revoked server-side", async () => {
    await setCloudCredential("agntApiKey", "agnt_sk_revoked");
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ error: "UNAUTHORIZED" }, 401))
      .mockResolvedValueOnce(jsonResponse({ items: [{ id: "org_1" }] }))
      .mockResolvedValueOnce(jsonResponse({ id: "key_2", key: "agnt_sk_fresh", label: "Mac" }));

    await ensureDeviceKey("session-jwt", "https://cloud.test");

    expect(await getCloudCredential("agntApiKey")).toBe("agnt_sk_fresh");
  });

  it("surfaces a mint failure without storing anything", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ items: [{ id: "org_1" }] }))
      .mockResolvedValueOnce(jsonResponse({ error: "FORBIDDEN" }, 403));

    await expect(ensureDeviceKey("session-jwt", "https://cloud.test")).rejects.toThrow("403");
    expect(await getCloudCredential("agntApiKey")).toBeNull();
  });
});

describe("pushCloudCredentialsToBackend", () => {
  it("is a quiet no-op before the backend is up", async () => {
    vi.stubEnv("DEUS_BACKEND_PORT", "");
    expect(await pushCloudCredentialsToBackend()).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("posts stored credentials to the local credentials route with the backend auth token", async () => {
    vi.stubEnv("DEUS_BACKEND_PORT", "51999");
    vi.stubEnv("DEUS_AUTH_TOKEN", "local-token");
    await setCloudCredential("agntApiKey", "agnt_sk_live_x");
    fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true }));

    expect(await pushCloudCredentialsToBackend()).toBe(true);

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("http://127.0.0.1:51999/api/settings/cloud/credentials");
    expect(init.headers.authorization).toBe("Bearer local-token");
    // The full contract: credentials PLUS the deus-cloud mint context the
    // backend needs to request per-repo GitHub App installation tokens.
    expect(JSON.parse(init.body)).toEqual({
      apiKey: "agnt_sk_live_x",
      claudeOauthToken: null,
      deusCloudUrl: expect.any(String),
      deusCloudSessionToken: null,
      orgId: null,
    });
  });
});

describe("revokeDeviceKey", () => {
  it("revokes server-side when possible, always deletes locally, and clears the backend", async () => {
    vi.stubEnv("DEUS_BACKEND_PORT", "51999");
    vi.stubEnv("DEUS_AUTH_TOKEN", "local-token");
    await setCloudCredential("agntApiKey", "agnt_sk_live_x", { keyId: "key_9", orgId: "org_1" });
    fetchMock.mockResolvedValue(jsonResponse({ ok: true }));

    await revokeDeviceKey("session-jwt");

    const revokeCall = fetchMock.mock.calls[0];
    expect(revokeCall[0]).toBe("https://agnt.test/dashboard/orgs/org_1/api-keys/key_9");
    expect(revokeCall[1].method).toBe("DELETE");
    expect(await getCloudCredential("agntApiKey")).toBeNull();

    // The backend push at the end must clear the key (null), not resend it.
    const pushCall = fetchMock.mock.calls.at(-1);
    expect(pushCall?.[0]).toContain("/api/settings/cloud/credentials");
    expect(JSON.parse(pushCall?.[1].body).apiKey).toBeNull();
  });

  it("offline sign-out still deletes the local key", async () => {
    await setCloudCredential("agntApiKey", "agnt_sk_live_x", { keyId: "key_9", orgId: "org_1" });
    fetchMock.mockRejectedValue(new Error("offline"));

    await revokeDeviceKey("session-jwt");

    expect(await getCloudCredential("agntApiKey")).toBeNull();
  });
});

describe("syncClaudeTokenToPlatform", () => {
  it("PUTs the token as a non-fanout secret with the device key", async () => {
    const { syncClaudeTokenToPlatform } =
      await import("../../../apps/desktop/main/deus-cloud-provision");
    await setCloudCredential("agntApiKey", "agnt_sk_live_x");
    fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true }));

    expect(await syncClaudeTokenToPlatform("sk-ant-oat01-secret")).toBe(true);

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://agnt.test/secrets/CLAUDE_CODE_OAUTH_TOKEN");
    expect(init.method).toBe("PUT");
    expect(init.headers.authorization).toBe("Bearer agnt_sk_live_x");
    // applies_to_all=false is the load-bearing bit: a TURN credential the
    // session DO resolves — never fanned into sandbox env.
    expect(JSON.parse(init.body)).toEqual({ value: "sk-ant-oat01-secret", appliesToAll: false });
  });

  it("DELETEs the platform copy on disconnect (null)", async () => {
    const { syncClaudeTokenToPlatform } =
      await import("../../../apps/desktop/main/deus-cloud-provision");
    await setCloudCredential("agntApiKey", "agnt_sk_live_x");
    fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true }));

    expect(await syncClaudeTokenToPlatform(null)).toBe(true);
    expect(fetchMock.mock.calls[0][1].method).toBe("DELETE");
  });

  it("is a quiet no-op before a device key exists (local-only until sign-in)", async () => {
    const { syncClaudeTokenToPlatform } =
      await import("../../../apps/desktop/main/deus-cloud-provision");
    expect(await syncClaudeTokenToPlatform("sk-ant-oat01-secret")).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
