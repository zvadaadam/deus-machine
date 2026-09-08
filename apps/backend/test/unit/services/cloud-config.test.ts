import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getCloudConfig,
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

describe("cloud config runtime credentials", () => {
  it("invalidates on product principal changes, while same-account token renewal retains sockets", () => {
    const bearer = (sub: string, exp = 1000) =>
      `header.${Buffer.from(JSON.stringify({ sub, iss: "deus-cloud", exp })).toString("base64url")}.signature`;
    const changed = vi.fn();
    setCloudIdentityChangedHandler(changed);
    setCloudRuntimeCredentials({
      apiKey: "shared-org-key",
      orgId: "shared-org",
      deusCloudSessionToken: bearer("alice"),
    });
    changed.mockClear();

    setCloudRuntimeCredentials({ deusCloudSessionToken: bearer("alice", 2000) });
    expect(changed).not.toHaveBeenCalled();
    setCloudRuntimeCredentials({ deusCloudSessionToken: bearer("bob") });
    expect(changed).toHaveBeenCalledOnce();
    setCloudRuntimeCredentials({ deusCloudSessionToken: null });
    expect(changed).toHaveBeenCalledTimes(2);
    expect(getCloudConfig()?.apiKey).toBe("shared-org-key");
  });

  it("no env, no runtime → lane disabled (null)", () => {
    expect(getCloudConfig()).toBeNull();
  });

  it("a runtime key enables the lane AFTER the memo already read null — the invalidation seam", () => {
    // First read memoizes "disabled" — exactly the state a freshly started
    // backend is in before the desktop mints a key.
    expect(getCloudConfig()).toBeNull();

    setCloudRuntimeCredentials({ apiKey: "agnt_sk_minted_later" });

    const config = getCloudConfig();
    expect(config).not.toBeNull();
    expect(config?.apiKey).toBe("agnt_sk_minted_later");
    expect(config?.baseUrl).toBe("https://api.deusmachine.ai");
  });

  it("runtime values win over env; null clears back to env", () => {
    process.env.DEUS_CLOUD_AGNT_API_KEY = "agnt_sk_from_env";
    expect(getCloudConfig()?.apiKey).toBe("agnt_sk_from_env");

    setCloudRuntimeCredentials({ apiKey: "agnt_sk_runtime" });
    expect(getCloudConfig()?.apiKey).toBe("agnt_sk_runtime");

    setCloudRuntimeCredentials({ apiKey: null });
    expect(getCloudConfig()?.apiKey).toBe("agnt_sk_from_env");
  });

  it("clearing the only key disables the lane again (sign-out on a keyless env)", () => {
    setCloudRuntimeCredentials({ apiKey: "agnt_sk_device" });
    expect(getCloudConfig()).not.toBeNull();

    setCloudRuntimeCredentials({ apiKey: null });
    expect(getCloudConfig()).toBeNull();
  });

  it("strips trailing slash on runtime baseUrl", () => {
    setCloudRuntimeCredentials({ apiKey: "agnt_sk_x", baseUrl: "https://agnt.example/" });
    expect(getCloudConfig()?.baseUrl).toBe("https://agnt.example");
  });

  it("partial updates retain the product session and device key", () => {
    setCloudRuntimeCredentials({ apiKey: "agnt_sk_x", deusCloudSessionToken: "workos-token" });
    setCloudRuntimeCredentials({ orgId: "org-a" });
    const config = getCloudConfig();
    expect(config?.apiKey).toBe("agnt_sk_x");
    expect(config?.deusCloudSessionToken).toBe("workos-token");
    expect(config?.orgId).toBe("org-a");
  });
});

describe("DEUS_CLOUD_ENV=local", () => {
  it("points BOTH platform URLs at localhost", () => {
    // `bun run dev:cloud-local` sets this once; the desktop main process and
    // the backend both inherit it. The backend ignoring it is what made the
    // local script a half-switch — main hit localhost, the backend (which
    // makes the actual workspace calls) still hit production.
    process.env.DEUS_CLOUD_ENV = "local";
    setCloudRuntimeCredentials({ apiKey: "agnt_sk_test" });

    const config = getCloudConfig();
    expect(config?.baseUrl).toBe("http://127.0.0.1:8788");
    expect(config?.deusCloudUrl).toBe("http://127.0.0.1:5788");
  });

  it("yields to an explicit URL override", () => {
    process.env.DEUS_CLOUD_ENV = "local";
    process.env.DEUS_CLOUD_AGNT_URL = "https://staging.example";
    setCloudRuntimeCredentials({ apiKey: "agnt_sk_test" });

    expect(getCloudConfig()?.baseUrl).toBe("https://staging.example");
  });

  it("leaves production alone when unset", () => {
    setCloudRuntimeCredentials({ apiKey: "agnt_sk_test" });

    const config = getCloudConfig();
    expect(config?.baseUrl).toBe("https://api.deusmachine.ai");
    expect(config?.deusCloudUrl).toBeNull();
  });
});
