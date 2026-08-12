import { vi, describe, it, expect, beforeEach } from "vitest";
import { pbkdf2Sync, createCipheriv } from "node:crypto";

const { mockReadFileSync, mockStatSync } = vi.hoisted(() => ({
  mockReadFileSync: vi.fn(),
  mockStatSync: vi.fn(),
}));

vi.mock("node:fs", () => ({
  default: {
    readFileSync: mockReadFileSync,
    statSync: mockStatSync,
    existsSync: vi.fn(() => false),
    copyFileSync: vi.fn(),
    mkdtempSync: vi.fn(),
    rmSync: vi.fn(),
  },
  readFileSync: mockReadFileSync,
  statSync: mockStatSync,
}));

import {
  decryptCookieValue,
  listBrowserProfiles,
} from "../../../src/services/browser-import.service";

// Reproduce the Chromium macOS encryption scheme so we can round-trip.
const KEY = pbkdf2Sync("test-keychain-password", "saltysalt", 1003, 16, "sha1");
function encryptV10(plaintext: Buffer): Buffer {
  const cipher = createCipheriv("aes-128-cbc", KEY, Buffer.alloc(16, 0x20));
  return Buffer.concat([Buffer.from("v10"), cipher.update(plaintext), cipher.final()]);
}

describe("browser-import.service — decryptCookieValue", () => {
  it("round-trips a classic v10 cookie value", () => {
    const encrypted = encryptV10(Buffer.from("session=abc123"));
    expect(decryptCookieValue(encrypted, KEY)).toBe("session=abc123");
  });

  it("strips the 32-byte SHA-256 domain-hash prefix (Chrome 130+)", () => {
    const prefixed = Buffer.concat([Buffer.alloc(32, 0), Buffer.from("real-token-value")]);
    const encrypted = encryptV10(prefixed);
    expect(decryptCookieValue(encrypted, KEY)).toBe("real-token-value");
  });

  it("does not strip a legit printable value that is >= 32 bytes", () => {
    const value = "a".repeat(40);
    expect(decryptCookieValue(encryptV10(Buffer.from(value)), KEY)).toBe(value);
  });

  it("returns null for an unknown encryption version", () => {
    expect(decryptCookieValue(Buffer.from("xyz-not-encrypted"), KEY)).toBeNull();
  });

  it("returns null for too-short input", () => {
    expect(decryptCookieValue(Buffer.from("v1"), KEY)).toBeNull();
  });
});

// Enumeration reads real macOS paths; only meaningful on darwin.
describe.skipIf(process.platform !== "darwin")("browser-import.service — listBrowserProfiles", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("parses Chrome profiles and skips System/Guest", () => {
    mockReadFileSync.mockImplementation((p: string) => {
      if (p.includes("Google/Chrome") && p.endsWith("Local State")) {
        return JSON.stringify({
          profile: {
            info_cache: {
              Default: { name: "Adam", user_name: "adam@example.com" },
              "Profile 1": { name: "Work" },
              "System Profile": {},
              "Guest Profile": {},
            },
          },
        });
      }
      throw new Error("ENOENT"); // other browsers not installed
    });
    mockStatSync.mockReturnValue({ mtimeMs: 1_700_000_000_000 });

    const profiles = listBrowserProfiles();

    expect(profiles).toHaveLength(2);
    expect(profiles.map((p) => p.profileDir).sort()).toEqual(["Default", "Profile 1"]);
    const adam = profiles.find((p) => p.profileDir === "Default");
    expect(adam).toMatchObject({
      browserId: "chrome",
      browserName: "Chrome",
      name: "Adam",
      email: "adam@example.com",
    });
  });

  it("returns empty when no browsers are installed", () => {
    mockReadFileSync.mockImplementation(() => {
      throw new Error("ENOENT");
    });
    expect(listBrowserProfiles()).toEqual([]);
  });
});
