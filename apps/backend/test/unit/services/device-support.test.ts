import { expect, it, vi } from "vitest";
import { liveViewSupport, deviceToolchains } from "../../../src/services/device-hub/support";
import { deviceSupport, deviceHub } from "../../../src/services/device-hub";
import { readXcode } from "../../../src/services/device-hub/simctl";
import { hasAndroidToolchain } from "../../../src/services/device-hub/android-sdk";
vi.mock("../../../src/services/device-hub/simctl", () => ({ readXcode: vi.fn() }));
vi.mock("../../../src/services/device-hub/android-sdk", () => ({ hasAndroidToolchain: vi.fn() }));

it.each([
  ["darwin", "arm64", true, false, "available"],
  ["darwin", "x64", true, false, "unsupported"],
  ["linux", "arm64", true, false, "unsupported"],
  ["darwin", "arm64", false, false, "no-runtime"],
  ["darwin", "arm64", true, true, "remote"],
] as const)("checks %s/%s, runtime %s and remote %s", (platform, arch, runtime, remote, state) => {
  expect(liveViewSupport(platform, arch, runtime, remote)).toBe(state);
});
it("caches independent platform checks and reads setup without starting the hub", async () => {
  vi.useFakeTimers();
  try {
    for (const ios of [true, false])
      for (const android of [true, false]) {
        vi.setSystemTime(Date.now() + 60_001);
        vi.mocked(readXcode).mockResolvedValue({ available: ios, version: ios ? "27.1" : null });
        vi.mocked(hasAndroidToolchain).mockResolvedValue(android);
        const hits = vi.mocked(readXcode).mock.calls.length;
        const answer = await deviceSupport(false);
        expect(answer.xcode).toEqual({ available: ios, version: ios ? "27.1" : null });
        expect(answer.android).toBe(android);
        await deviceToolchains();
        expect(readXcode).toHaveBeenCalledTimes(hits + 1);
        expect(deviceHub.status.phase).toBe("idle");
      }
  } finally {
    vi.useRealTimers();
  }
});
