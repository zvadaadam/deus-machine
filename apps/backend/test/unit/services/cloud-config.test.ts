import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  getCloudConfig,
  resetCloudConfigForTests,
  setCloudRuntimeCredentials,
} from "../../../src/services/agent/cloud/config";

const ENV_KEYS = [
  "DEUS_CLOUD_AGNT_API_KEY",
  "AGNT_API_KEY",
  "DEUS_CLOUD_AGNT_URL",
  "AGNT_BASE_URL",
  "DEUS_CLOUD_ANTHROPIC_KEY",
  "ANTHROPIC_API_KEY",
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
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  resetCloudConfigForTests();
});

describe("cloud config runtime credentials", () => {
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

  it("carries the Claude subscription token and strips trailing slash on runtime baseUrl", () => {
    setCloudRuntimeCredentials({
      apiKey: "agnt_sk_x",
      baseUrl: "https://agnt.example/",
      claudeOauthToken: "sk-ant-oat01-abc",
    });
    const config = getCloudConfig();
    expect(config?.baseUrl).toBe("https://agnt.example");
    expect(config?.claudeOauthToken).toBe("sk-ant-oat01-abc");
    // Anthropic API key fallback stays independent of the subscription token.
    expect(config?.anthropicApiKey).toBeNull();
  });

  it("partial updates do not disturb other runtime values", () => {
    setCloudRuntimeCredentials({ apiKey: "agnt_sk_x", claudeOauthToken: "sk-ant-oat01-abc" });
    setCloudRuntimeCredentials({ anthropicApiKey: "sk-ant-key" });
    const config = getCloudConfig();
    expect(config?.apiKey).toBe("agnt_sk_x");
    expect(config?.claudeOauthToken).toBe("sk-ant-oat01-abc");
    expect(config?.anthropicApiKey).toBe("sk-ant-key");
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
