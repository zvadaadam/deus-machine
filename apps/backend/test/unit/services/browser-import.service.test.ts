import { vi, describe, it, expect, beforeEach } from "vitest";
import { pbkdf2Sync, createCipheriv, createHash } from "node:crypto";

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

/** Encrypt a block-aligned plaintext with padding OFF, to craft invalid PKCS#7. */
function encryptRaw(aligned: Buffer): Buffer {
  const cipher = createCipheriv("aes-128-cbc", KEY, Buffer.alloc(16, 0x20));
  cipher.setAutoPadding(false);
  return Buffer.concat([Buffer.from("v10"), cipher.update(aligned), cipher.final()]);
}

describe("browser-import.service — decryptCookieValue", () => {
  it("round-trips a classic v10 cookie value", () => {
    const encrypted = encryptV10(Buffer.from("session=abc123"));
    expect(decryptCookieValue(encrypted, KEY)).toBe("session=abc123");
  });

  it("strips the 32-byte prefix heuristically when host_key is absent", () => {
    const prefixed = Buffer.concat([Buffer.alloc(32, 0), Buffer.from("real-token-value")]);
    const encrypted = encryptV10(prefixed);
    expect(decryptCookieValue(encrypted, KEY)).toBe("real-token-value");
  });

  it("strips the domain-hash prefix deterministically via SHA-256(host_key)", () => {
    const host = "example.com";
    const hash = createHash("sha256").update(host).digest(); // random-looking, but exact
    const encrypted = encryptV10(Buffer.concat([hash, Buffer.from("real-token-value")]));
    expect(decryptCookieValue(encrypted, KEY, host)).toBe("real-token-value");
  });

  it("does not strip a legit printable value that is >= 32 bytes", () => {
    const value = "a".repeat(40);
    expect(decryptCookieValue(encryptV10(Buffer.from(value)), KEY)).toBe(value);
    // Even with a host_key, a value whose prefix isn't the domain hash is kept.
    expect(decryptCookieValue(encryptV10(Buffer.from(value)), KEY, "example.com")).toBe(value);
  });

  it("returns null for an empty decrypted body", () => {
    expect(decryptCookieValue(Buffer.from("v10"), KEY)).toBeNull();
  });

  it("returns null when PKCS#7 padding bytes don't all match", () => {
    // 16-byte block ending in 0x03 but without three trailing 0x03 bytes.
    const block = Buffer.concat([Buffer.from("hello"), Buffer.alloc(10, 0), Buffer.from([0x03])]);
    expect(block.length).toBe(16);
    expect(decryptCookieValue(encryptRaw(block), KEY)).toBeNull();
  });

  it("returns null for an unknown encryption version", () => {
    expect(decryptCookieValue(Buffer.from("xyz-not-encrypted"), KEY)).toBeNull();
  });

  it("returns null for too-short input", () => {
    expect(decryptCookieValue(Buffer.from("v1"), KEY)).toBeNull();
  });
});

// Enumeration reads real macOS paths; only meaningful on darwin.
describe.skipIf(process.platform !== "darwin")(
  "browser-import.service — listBrowserProfiles",
  () => {
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
  }
);
