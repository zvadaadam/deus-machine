import { beforeEach, describe, expect, it, vi } from "vitest";

const mockGetEnvironment = vi.fn(async (..._args: unknown[]) => ({}) as unknown);
const mockUpdateEnvironment = vi.fn(async (..._args: unknown[]) => undefined);
vi.mock("@deus-hq/sdk", () => ({
  getEnvironment: (...args: unknown[]) => mockGetEnvironment(...args),
  listEnvironments: vi.fn(),
  updateEnvironment: (...args: unknown[]) => mockUpdateEnvironment(...args),
}));
vi.mock("../../../src/services/agent/cloud/config", () => ({
  getCloudConfig: () => ({ baseUrl: "http://agnt.test", apiKey: "agnt_sk_test_x" }),
}));

import {
  enableCloudEnvironmentSimulator,
  getCloudEnvironmentInfo,
} from "../../../src/services/cloud-environment.service";

const ORIGIN = "https://github.com/acme/app";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("getCloudEnvironmentInfo — hosted device support of a saved environment", () => {
  it("reports an environment saved before devices existed as lacking a simulator", async () => {
    mockGetEnvironment.mockResolvedValueOnce({ id: "env-1", config: { repo: ORIGIN } });
    await expect(getCloudEnvironmentInfo(ORIGIN)).resolves.toMatchObject({
      configured: true,
      environmentId: "env-1",
      simulator: false,
    });
  });

  it("reports `true` and a config object alike as simulator-enabled", async () => {
    mockGetEnvironment.mockResolvedValueOnce({ id: "env-1", config: { simulator: true } });
    await expect(getCloudEnvironmentInfo(ORIGIN)).resolves.toMatchObject({ simulator: true });
    mockGetEnvironment.mockResolvedValueOnce({
      id: "env-1",
      config: { simulator: { platform: "android", idleTimeoutMinutes: 30 } },
    });
    await expect(getCloudEnvironmentInfo(ORIGIN)).resolves.toMatchObject({ simulator: true });
  });
});

describe("getCloudEnvironmentInfo — saved project validation", () => {
  it("returns the shared schema's validated project", async () => {
    mockGetEnvironment.mockResolvedValueOnce({
      id: "env-1",
      config: { project: { version: 1, setup: " bun install\n", local: { setup: null } } },
    });
    await expect(getCloudEnvironmentInfo(ORIGIN)).resolves.toMatchObject({
      configured: true,
      project: { version: 1, setup: "bun install", local: { setup: null } },
    });
  });

  it.each([null, { version: 2 }, { version: 1, setup: ["bun install"] }])(
    "fails the lookup instead of exposing malformed project %j",
    async (project) => {
      mockGetEnvironment.mockResolvedValueOnce({ id: "env-1", config: { project } });
      const result = await getCloudEnvironmentInfo(ORIGIN);
      expect(result).toMatchObject({ configured: false, lookupFailed: true });
      expect(result).not.toHaveProperty("project");
      expect(result).not.toHaveProperty("environmentId");
    }
  );
});

describe("enableCloudEnvironmentSimulator", () => {
  it("merges `simulator: true` into the saved environment's config on the platform", async () => {
    await enableCloudEnvironmentSimulator("env-1");
    expect(mockUpdateEnvironment).toHaveBeenCalledWith("env-1", {
      config: { simulator: true },
      baseUrl: "http://agnt.test",
      apiKey: "agnt_sk_test_x",
    });
  });
});
