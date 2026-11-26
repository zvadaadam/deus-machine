import { expect, it } from "vitest";
import { canClearMissingDevice, needsRecoveryPoll } from "@/features/device/devices";

it.each([
  ["ios:A0-B0", true, true, null, null, true],
  ["ios:A0-B0", true, true, "simctl timed out", null, false],
  ["ios:A0-B0", true, false, null, "SDK missing", true],
  ["ios:A0-B0", true, true, "simctl timed out", "SDK missing", false],
  ["ios:A0-B0", false, true, null, "Xcode probe failed", false],
  ["ios:A0-B0", false, false, null, null, false],
  ["android:Pixel", true, true, null, null, true],
  ["android:Pixel", false, true, "simctl timed out", null, true],
  ["android:Pixel", true, true, null, "SDK missing", false],
  ["android:Pixel", true, true, "simctl timed out", "SDK missing", false],
  ["android:Pixel", true, false, null, null, false],
] as const)(
  "%s with iOS/Android available %s/%s and detail %s/%s → clear %s",
  (key, iosAvailable, androidAvailable, ios, android, clear) => {
    const inventory = {
      devices: [],
      available: { ios: iosAvailable, android: androidAvailable },
      detail: { ios, android },
    };
    expect(canClearMissingDevice(key, inventory)).toBe(clear);
    expect(needsRecoveryPoll(key, inventory)).toBe(!clear);
  }
);

it.each([true, false])("polls for a listed device only until it boots (booted %s)", (booted) => {
  const device = { platform: "ios", id: "A0-B0", name: "iPhone", version: "27", booted } as const;
  expect(
    needsRecoveryPoll("ios:A0-B0", {
      devices: [device],
      available: { ios: true, android: false },
      detail: { ios: null, android: null },
    })
  ).toBe(!booted);
});
