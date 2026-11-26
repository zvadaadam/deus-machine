import { expect, it, vi } from "vitest";
import { liveViewSupport, deviceToolchains } from "../../../src/services/device-hub/support";
import { deviceSupport, deviceHub } from "../../../src/services/device-hub";
import { readXcode } from "../../../src/services/device-hub/simctl";
import { findAndroidSdk } from "../../../src/services/device-hub/android-sdk";
vi.mock("../../../src/services/device-hub/simctl", () => ({ readXcode: vi.fn() }));
vi.mock("../../../src/services/device-hub/android-sdk", () => ({ findAndroidSdk: vi.fn() }));

it.each([
  ["darwin", "arm64", true, "available"],
  ["darwin", "x64", true, "unsupported"],
  ["linux", "arm64", true, "unsupported"],
  ["darwin", "arm64", false, "no-runtime"],
] as const)("checks %s/%s, runtime %s", (platform, arch, runtime, state) => {
  expect(liveViewSupport(platform, arch, runtime)).toBe(state);
});
it("answers remote Settings without probing SDKs or the local installation", async () => {
  const setup = vi.spyOn(deviceHub, "setupState");
  try {
    expect(await deviceSupport(true)).toEqual({ liveView: "remote" });
    expect(readXcode).not.toHaveBeenCalled();
    expect(findAndroidSdk).not.toHaveBeenCalled();
    expect(setup).not.toHaveBeenCalled();
  } finally {
    setup.mockRestore();
  }
});

it("caches independent platform checks without starting the hub", async () => {
  vi.useFakeTimers();
  try {
    for (const ios of [true, false])
      for (const android of [true, false]) {
        vi.setSystemTime(Date.now() + 60_001);
        vi.mocked(readXcode).mockResolvedValue({ available: ios, version: ios ? "27.1" : null });
        const sdk = android ? "/fixture/sdk" : null;
        vi.mocked(findAndroidSdk).mockResolvedValue(sdk);
        const hits = vi.mocked(readXcode).mock.calls.length;
        const answer = await deviceSupport(false);
        if (answer.liveView === "remote") throw new Error("Expected local readiness");
        expect(answer.xcode).toEqual({ available: ios, version: ios ? "27.1" : null });
        expect(answer.android).toBe(android);
        expect((await deviceToolchains()).androidSdk).toBe(sdk);
        expect(findAndroidSdk).toHaveBeenCalledTimes(hits + 1);
        expect(readXcode).toHaveBeenCalledTimes(hits + 1);
        expect(deviceHub.status.phase).toBe("idle");
      }
  } finally {
    vi.useRealTimers();
  }
});
