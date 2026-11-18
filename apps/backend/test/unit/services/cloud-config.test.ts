import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cloudAccount,
  cloudOrg,
  cloudOrgOf,
  defaultCloudOrgId,
  getCloudConnectionIdentity,
  getCloudIdentitySignal,
  getDeusCloudSessionConfig,
  hasFallbackCloudKey,
  requireCloudOrg,
  resetCloudConfigForTests,
  setCloudRuntimeCredentials,
  setCloudIdentityChangedHandler,
} from "../../../src/services/agent/cloud/config";

const ENV_KEYS = [
  "DEUS_CLOUD_AGNT_API_KEY",
  "AGNT_API_KEY",
  "DEUS_CLOUD_AGNT_URL",
  "AGNT_BASE_URL",
  "DEUS_CLOUD_URL",
  "DEUS_CLOUD_ENV",
] as const;

const savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};

beforeEach(() => {
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  resetCloudConfigForTests();
});

afterEach(() => {
  setCloudIdentityChangedHandler(() => {});
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  resetCloudConfigForTests();
});

const bearer = (sub: string, exp = 1000) =>
  `header.${Buffer.from(JSON.stringify({ sub, iss: "deus-cloud", exp })).toString("base64url")}.signature`;

describe("cloud config runtime credentials", () => {
  it("invalidates on product principal changes, while same-account token renewal retains sockets", () => {
    const changed = vi.fn();
    setCloudIdentityChangedHandler(changed);
    setCloudRuntimeCredentials({
      orgKeys: { "shared-org": "shared-org-key" },
      deusCloudSessionToken: bearer("alice"),
    });
    changed.mockClear();
    const signal = getCloudIdentitySignal();

    setCloudRuntimeCredentials({ deusCloudSessionToken: bearer("alice", 2000) });
    expect(changed).not.toHaveBeenCalled();
    expect(getCloudIdentitySignal()).toBe(signal);
    expect(signal.aborted).toBe(false);
    setCloudRuntimeCredentials({ deusCloudSessionToken: bearer("bob") });
    expect(changed).toHaveBeenCalledOnce();
    expect(signal.aborted).toBe(true);
    expect(getCloudIdentitySignal().aborted).toBe(false);
    setCloudRuntimeCredentials({ deusCloudSessionToken: null });
    expect(changed).toHaveBeenCalledTimes(2);
    expect(cloudOrg()?.apiKey).toBe("shared-org-key");
  });

  it("the identity is the account: adding, removing or replacing a key changes nothing", () => {
    const changed = vi.fn();
    setCloudRuntimeCredentials({
      deusCloudSessionToken: bearer("alice"),
      orgKeys: { org_a: "key_a" },
    });
    setCloudIdentityChangedHandler(changed);
    const signal = getCloudIdentitySignal();
    const identity = getCloudConnectionIdentity();

    setCloudRuntimeCredentials({ orgKeys: { org_a: "key_a", org_b: "key_b" } });
    setCloudRuntimeCredentials({ orgKeys: { org_a: "key_a2", org_b: "key_b" } });
    setCloudRuntimeCredentials({ orgKeys: { org_b: "key_b" } });
    setCloudRuntimeCredentials({ orgId: "org_c" });
    setCloudRuntimeCredentials({ orgKeys: null, orgId: null });

    expect(changed).not.toHaveBeenCalled();
    expect(signal.aborted).toBe(false);
    expect(getCloudConnectionIdentity()).toBe(identity);
    expect(identity).not.toContain("key_");
    expect(identity).not.toContain("org_");
  });

  it("no env, no runtime → lane disabled (null)", () => {
    expect(cloudAccount()).toBeNull();
    expect(cloudOrg()).toBeNull();
  });

  it("a runtime key enables the lane AFTER a read found it disabled — the invalidation seam", () => {
    expect(cloudOrg()).toBeNull();

    setCloudRuntimeCredentials({ orgKeys: { org_1: "agnt_sk_minted_later" } });

    const config = cloudOrg();
    expect(config).toEqual({
      orgId: "org_1",
      baseUrl: "https://api.deusmachine.ai",
      apiKey: "agnt_sk_minted_later",
    });
    expect(cloudAccount()?.baseUrl).toBe("https://api.deusmachine.ai");
  });

  it("picks each organization's own key; the default is the first one pushed", () => {
    setCloudRuntimeCredentials({
      deusCloudSessionToken: bearer("alice"),
      orgKeys: { org_a: "key_a", org_b: "key_b" },
    });
    expect(defaultCloudOrgId()).toBe("org_a");
    expect(cloudOrg()).toMatchObject({ orgId: "org_a", apiKey: "key_a" });
    expect(cloudOrg("org_b")).toMatchObject({ orgId: "org_b", apiKey: "key_b" });
    // An organization without a key, and no fallback: not set up here.
    expect(cloudOrg("org_c")).toBeNull();
    expect(() => requireCloudOrg("org_c")).toThrow(/not set up on this computer/);
    // A row with no organization yet is the default one's.
    expect(cloudOrgOf({ organization_id: null })).toMatchObject({ apiKey: "key_a" });
    expect(cloudOrgOf({ organization_id: "org_b" })).toMatchObject({ apiKey: "key_b" });
    expect(cloudAccount()).toMatchObject({ accountId: "alice", sessionToken: bearer("alice") });
  });

  it("the fallback key serves any organization only while no organization keys were pushed", () => {
    process.env.AGNT_API_KEY = "agnt_sk_from_env";
    expect(defaultCloudOrgId()).toBeNull();
    expect(cloudOrg()).toMatchObject({ orgId: null, apiKey: "agnt_sk_from_env" });
    expect(cloudOrg("org_x")).toMatchObject({ orgId: "org_x", apiKey: "agnt_sk_from_env" });
    expect(hasFallbackCloudKey()).toBe(true);

    // One organization's key is pushed: the developer key no longer stands in for another.
    setCloudRuntimeCredentials({ orgKeys: { org_a: "key_a" } });
    expect(cloudOrg("org_a")?.apiKey).toBe("key_a");
    expect(cloudOrg("org_x")).toBeNull();
    expect(() => requireCloudOrg("org_x")).toThrow(/not set up on this computer/);
    expect(hasFallbackCloudKey()).toBe(false);
  });

  it("the default is the organization the desktop names, even when its key is missing", () => {
    setCloudRuntimeCredentials({
      deusCloudSessionToken: bearer("alice"),
      orgKeys: { org_b: "key_b" },
      orgId: "org_a",
    });
    expect(defaultCloudOrgId()).toBe("org_a");
    // A row of the default organization is refused in words, never sent with org_b's key.
    expect(cloudOrg()).toBeNull();
    expect(cloudOrgOf({ organization_id: null })).toBeNull();
    expect(() => requireCloudOrg(null)).toThrow(/not set up on this computer/);
    expect(cloudOrg("org_b")).toMatchObject({ orgId: "org_b", apiKey: "key_b" });
  });

  it("clearing the only key disables the organization calls again (sign-out on a keyless env)", () => {
    setCloudRuntimeCredentials({ orgKeys: { org_1: "agnt_sk_device" } });
    expect(cloudOrg()).not.toBeNull();

    setCloudRuntimeCredentials({ orgKeys: {} });
    expect(cloudOrg()).toBeNull();
    expect(cloudAccount()).toBeNull();
  });

  it("strips trailing slash on runtime baseUrl", () => {
    setCloudRuntimeCredentials({ orgKeys: { org: "agnt_sk_x" }, baseUrl: "https://agnt.example/" });
    expect(cloudOrg()?.baseUrl).toBe("https://agnt.example");
  });

  it("partial updates retain the product session and device keys", () => {
    setCloudRuntimeCredentials({
      orgKeys: { "org-a": "agnt_sk_x" },
      deusCloudSessionToken: "workos-token",
    });
    setCloudRuntimeCredentials({ deusCloudUrl: "https://cloud.test" });
    expect(cloudOrg()).toMatchObject({ orgId: "org-a", apiKey: "agnt_sk_x" });
    expect(cloudAccount()).toMatchObject({
      sessionToken: "workos-token",
      deusCloudUrl: "https://cloud.test",
    });
  });

  it.each(["baseUrl", "deusCloudUrl"] as const)(
    "rejects an insecure runtime %s before changing the current credentials",
    (field) => {
      setCloudRuntimeCredentials({
        orgKeys: { org: "agnt_sk_device" },
        deusCloudUrl: "https://cloud.test",
      });
      const account = cloudAccount();
      const signal = getCloudIdentitySignal();
      expect(() => setCloudRuntimeCredentials({ [field]: "http://cloud.test" })).toThrow(/HTTPS/);
      expect(cloudAccount()).toEqual(account);
      expect(signal.aborted).toBe(false);
    }
  );

  it("rejects an insecure product environment URL even before VM-key provisioning", () => {
    process.env.DEUS_CLOUD_URL = "http://cloud.test";
    expect(cloudOrg()).toBeNull();
    expect(() => getDeusCloudSessionConfig()).toThrow(/HTTPS/);
  });
});

describe("DEUS_CLOUD_ENV=local", () => {
  it("points BOTH platform URLs at localhost", () => {
    // `bun run dev:cloud-local` sets this once; the desktop main process and
    // the backend both inherit it. The backend ignoring it is what made the
    // local script a half-switch — main hit localhost, the backend (which
    // makes the actual workspace calls) still hit production.
    process.env.DEUS_CLOUD_ENV = "local";
    setCloudRuntimeCredentials({ orgKeys: { org: "agnt_sk_test" } });

    expect(cloudOrg()?.baseUrl).toBe("http://127.0.0.1:8788");
    expect(cloudAccount()?.deusCloudUrl).toBe("http://127.0.0.1:5788");
  });

  it("yields to an explicit URL override", () => {
    process.env.DEUS_CLOUD_ENV = "local";
    process.env.DEUS_CLOUD_AGNT_URL = "https://staging.example";
    setCloudRuntimeCredentials({ orgKeys: { org: "agnt_sk_test" } });

    expect(cloudOrg()?.baseUrl).toBe("https://staging.example");
  });

  it("leaves production alone when unset", () => {
    setCloudRuntimeCredentials({ orgKeys: { org: "agnt_sk_test" } });

    expect(cloudOrg()?.baseUrl).toBe("https://api.deusmachine.ai");
    expect(cloudAccount()?.deusCloudUrl).toBeNull();
  });
});
