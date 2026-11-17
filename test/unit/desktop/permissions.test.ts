import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ net: {}, protocol: {} }));

import { allowsPermission } from "../../../apps/desktop/main/permissions";

const windowOrigin = "app://deus";
const guest = (permission: string) => allowsPermission(permission, "https://example.com");
const window = (permission: string, topOrigin: string | null = windowOrigin) =>
  allowsPermission(permission, topOrigin, windowOrigin);

describe("allowsPermission", () => {
  it("lets a Browser-tab page go fullscreen, lock the pointer and copy", () => {
    for (const permission of ["fullscreen", "pointerLock", "clipboard-sanitized-write"]) {
      expect(guest(permission)).toBe(true);
    }
  });

  it("refuses a Browser-tab page everything else", () => {
    for (const permission of [
      "media",
      "display-capture",
      "geolocation",
      "notifications",
      "midi",
      "midiSysex",
      "hid",
      "serial",
      "usb",
      "clipboard-read",
      "openExternal",
      "unknown",
    ]) {
      expect(guest(permission)).toBe(false);
    }
  });

  it("lets the window copy, paste and notify, and nothing else", () => {
    for (const permission of ["clipboard-sanitized-write", "clipboard-read", "notifications"]) {
      expect(window(permission)).toBe(true);
    }
    for (const permission of ["media", "geolocation", "openExternal", "fullscreen"]) {
      expect(window(permission)).toBe(false);
    }
  });

  it("refuses everything when the window's page on top is not the app's", () => {
    expect(window("notifications", "https://example.com")).toBe(false);
    expect(window("clipboard-sanitized-write", null)).toBe(false);
  });
});
