import { expect, it } from "vitest";
import { describeDevice, deviceDisplayName } from "@/features/auth/lib/device-name";

const IPHONE_SAFARI =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 26_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.6 Mobile/15E148 Safari/604.1";
const IPHONE_CHROME =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 26_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/156.0 Mobile/15E148 Safari/604.1";
const MAC_SAFARI =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.6 Safari/605.1.15";
const MAC_CHROME =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36";
const ANDROID_CHROME =
  "Mozilla/5.0 (Linux; Android 16; Pixel 10) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Mobile Safari/537.36";
const WINDOWS_EDGE =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36 Edg/156.0.0.0";

it("names phones, tablets and computers by device and browser", () => {
  expect(describeDevice(IPHONE_SAFARI)).toBe("iPhone · Safari");
  expect(describeDevice(IPHONE_CHROME)).toBe("iPhone · Chrome");
  expect(describeDevice(ANDROID_CHROME)).toBe("Android phone · Chrome");
  expect(describeDevice(MAC_CHROME)).toBe("Mac · Chrome");
  expect(describeDevice(WINDOWS_EDGE)).toBe("Windows PC · Edge");
});

it("tells an iPad apart from a Mac by its touch screen", () => {
  expect(describeDevice(MAC_SAFARI)).toBe("Mac · Safari");
  expect(describeDevice(MAC_SAFARI, { touch: true })).toBe("iPad · Safari");
});

it("falls back to a generic name for an unknown browser", () => {
  expect(describeDevice("SomeBot/1.0")).toBe("Web browser");
});

it("improves the generic names older builds stored, when a user agent is known", () => {
  expect(deviceDisplayName({ name: "Mobile Browser", user_agent: IPHONE_SAFARI })).toBe(
    "iPhone · Safari"
  );
  expect(deviceDisplayName({ name: "Mobile Browser", user_agent: null })).toBe("Mobile Browser");
  expect(deviceDisplayName({ name: "Adam's iPhone", user_agent: IPHONE_SAFARI })).toBe(
    "Adam's iPhone"
  );
  expect(deviceDisplayName({ name: "Web Portal", user_agent: MAC_CHROME })).toBe("Mac · Chrome");
  // A relay pairing stores a marker, not the browser's user agent: keep the name it has.
  expect(deviceDisplayName({ name: "Mobile Browser", user_agent: "relay-paired" })).toBe(
    "Mobile Browser"
  );
});
