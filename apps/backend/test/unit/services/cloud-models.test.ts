/**
 * The cloud model lists: what @deus-hq/sdk's listModels() answers, kept a few
 * minutes per cloud identity. The platform is the only source — deus ships no
 * cloud list — so what matters is when it is asked again.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockListModels, mockGetCloudConfig, mockIdentity } = vi.hoisted(() => ({
  mockListModels: vi.fn(),
  mockGetCloudConfig: vi.fn(),
  mockIdentity: vi.fn(),
}));

vi.mock("@deus-hq/sdk", () => ({ listModels: mockListModels }));
vi.mock("../../../src/services/agent/cloud/config", () => ({
  getCloudConfig: mockGetCloudConfig,
  getCloudConnectionIdentity: mockIdentity,
}));

import {
  getCloudModelLists,
  resetCloudModelListsForTests,
} from "../../../src/services/agent/cloud/models";

const CONFIG = { baseUrl: "https://api.test", apiKey: "agnt_sk_test" };
const MINUTE = 60_000;

function lists(label: string) {
  return [
    {
      harness: "claude-code",
      source: "catalog",
      fetchedAt: 1,
      models: [
        {
          id: "opus",
          harness: "claude-code",
          label,
          thinking: { levels: ["low", "medium", "high", "xhigh", "max"] },
        },
      ],
    },
  ];
}

beforeEach(() => {
  resetCloudModelListsForTests();
  mockListModels.mockReset();
  mockGetCloudConfig.mockReset().mockReturnValue(CONFIG);
  mockIdentity.mockReset().mockReturnValue("account-a");
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-26T09:00:00Z"));
});

afterEach(() => {
  vi.useRealTimers();
});

describe("getCloudModelLists", () => {
  it("asks no one without a cloud account", async () => {
    mockGetCloudConfig.mockReturnValue(null);
    await expect(getCloudModelLists()).resolves.toBeNull();
    expect(mockListModels).not.toHaveBeenCalled();
  });

  it("reads the platform's lists with the device key, and again only after five minutes", async () => {
    mockListModels.mockResolvedValueOnce(lists("Opus 5.5")).mockResolvedValueOnce(lists("Opus 6"));

    await expect(getCloudModelLists()).resolves.toEqual(lists("Opus 5.5"));
    expect(mockListModels).toHaveBeenCalledWith(
      expect.objectContaining({ baseUrl: CONFIG.baseUrl, apiKey: CONFIG.apiKey })
    );

    vi.advanceTimersByTime(4 * MINUTE);
    await expect(getCloudModelLists()).resolves.toEqual(lists("Opus 5.5"));
    expect(mockListModels).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(2 * MINUTE);
    await expect(getCloudModelLists()).resolves.toEqual(lists("Opus 6"));
    expect(mockListModels).toHaveBeenCalledTimes(2);
  });

  it("shares one read between callers that ask at once", async () => {
    let answer!: (value: unknown) => void;
    mockListModels.mockReturnValueOnce(new Promise((resolve) => (answer = resolve)));

    const first = getCloudModelLists();
    const second = getCloudModelLists();
    answer(lists("Opus 5.5"));

    await expect(first).resolves.toEqual(lists("Opus 5.5"));
    await expect(second).resolves.toEqual(lists("Opus 5.5"));
    expect(mockListModels).toHaveBeenCalledTimes(1);
  });

  it("reads again for another account, and keeps no answer the old one was still waiting for", async () => {
    let answer!: (value: unknown) => void;
    mockListModels
      .mockReturnValueOnce(new Promise((resolve) => (answer = resolve)))
      .mockResolvedValueOnce(lists("Account B"));

    const pending = getCloudModelLists();
    mockIdentity.mockReturnValue("account-b");
    answer(lists("Account A"));
    await pending;

    await expect(getCloudModelLists()).resolves.toEqual(lists("Account B"));
    expect(mockListModels).toHaveBeenCalledTimes(2);
  });

  it("serves the previous lists when a refresh fails, and fails with none to serve", async () => {
    mockListModels.mockRejectedValueOnce(new Error("platform unavailable"));
    await expect(getCloudModelLists()).rejects.toThrow(/platform unavailable/);

    mockListModels.mockResolvedValueOnce(lists("Opus 5.5"));
    await expect(getCloudModelLists()).resolves.toEqual(lists("Opus 5.5"));

    vi.advanceTimersByTime(6 * MINUTE);
    mockListModels.mockRejectedValueOnce(new Error("platform unavailable"));
    await expect(getCloudModelLists()).resolves.toEqual(lists("Opus 5.5"));
  });
});
