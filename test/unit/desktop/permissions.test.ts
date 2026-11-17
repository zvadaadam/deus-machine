import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ net: {}, protocol: {} }));

import { allowsPermission } from "../../../apps/desktop/main/permissions";

const windowOrigin = "app://deus";
const guest = (permission: string) =>
  allowsPermission(permission, { guest: true, origin: "https://example.com", windowOrigin });
const window = (permission: string, origin: string | null = windowOrigin) =>
  allowsPermission(permission, { guest: false, origin, windowOrigin });

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

  it("lets the window copy and notify, and nothing else", () => {
    expect(window("clipboard-sanitized-write")).toBe(true);
    expect(window("notifications")).toBe(true);
    for (const permission of ["media", "clipboard-read", "geolocation", "openExternal"]) {
      expect(window(permission)).toBe(false);
    }
  });

  it("refuses a frame of another origin inside the window", () => {
    expect(window("notifications", "https://stream.example.com")).toBe(false);
    expect(window("clipboard-sanitized-write", null)).toBe(false);
  });
});
