import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ net: {}, protocol: {} }));

import { allowsPermission } from "../../../apps/desktop/main/permissions";

const app = "app://deus";
const site = "https://stream.example.com";
const guest = (permission: string) => allowsPermission(permission, { requesting: site, top: site });
const window = (permission: string) =>
  allowsPermission(permission, { requesting: app, top: app }, app);
const frame = (permission: string, top: string | null = app) =>
  allowsPermission(permission, { requesting: site, top }, app);

describe("allowsPermission", () => {
  it("lets a Browser-tab page go fullscreen, lock the pointer and copy, and nothing else", () => {
    for (const permission of ["fullscreen", "pointerLock", "clipboard-sanitized-write"]) {
      expect(guest(permission)).toBe(true);
    }
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

  it("lets the window's own page copy and notify, and nothing else", () => {
    expect(window("clipboard-sanitized-write")).toBe(true);
    expect(window("notifications")).toBe(true);
    for (const permission of ["clipboard-read", "media", "geolocation", "openExternal"]) {
      expect(window(permission)).toBe(false);
    }
  });

  it("lets a frame inside the window use the clipboard it was handed, and nothing else", () => {
    expect(frame("clipboard-read")).toBe(true);
    expect(frame("clipboard-sanitized-write")).toBe(true);
    for (const permission of ["notifications", "media", "geolocation", "fullscreen"]) {
      expect(frame(permission)).toBe(false);
    }
  });

  it("refuses everything when the window's page on top is not the app's", () => {
    expect(frame("clipboard-read", site)).toBe(false);
    expect(frame("clipboard-sanitized-write", null)).toBe(false);
  });
});
