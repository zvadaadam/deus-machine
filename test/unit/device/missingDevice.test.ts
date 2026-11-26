import { expect, it } from "vitest";
import { canClearMissingDevice } from "@/features/device/devices";

it.each([
  ["ios:A0-B0", null, null, true],
  ["ios:A0-B0", "simctl timed out", null, false],
  ["ios:A0-B0", null, "SDK missing", true],
  ["ios:A0-B0", "simctl timed out", "SDK missing", false],
  ["android:Pixel", null, null, true],
  ["android:Pixel", "simctl timed out", null, true],
  ["android:Pixel", null, "SDK missing", false],
  ["android:Pixel", "simctl timed out", "SDK missing", false],
] as const)(
  "can clear %s with iOS detail %s and Android detail %s → %s",
  (key, ios, android, clear) => {
    expect(canClearMissingDevice(key, { ios, android })).toBe(clear);
  }
);
