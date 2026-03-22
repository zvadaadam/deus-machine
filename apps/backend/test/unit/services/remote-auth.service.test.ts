import { vi, describe, it, expect, beforeEach } from "vitest";
import { createHash } from "crypto";

const mockStmt = {
  all: vi.fn(() => []),
  get: vi.fn(),
  run: vi.fn(() => ({ changes: 1 })),
};
const mockDb = {
  prepare: vi.fn(() => mockStmt),
};

vi.mock("../../../src/lib/database", () => ({
  getDatabase: vi.fn(() => mockDb),
  DB_PATH: "/tmp/opendevs-test-unit-auth/opendevs.db",
}));

import {
  generatePairCode,
  validatePairCode,
  getActiveCodeCount,
  createDeviceToken,
  validateDeviceToken,
  listDevices,
  revokeDevice,
  updateLastSeen,
  checkRateLimit,
  recordFailure,
  resetRateLimit,
  _clearAll,
} from "../../../src/services/remote-auth.service";

beforeEach(() => {
  vi.clearAllMocks();
  mockDb.prepare.mockReturnValue(mockStmt);
  _clearAll();
});

// ---- Pairing Codes (two-word format: "WORD WORD") ----

describe("generatePairCode", () => {
  it("returns a TWO WORD uppercase format", () => {
    const { code } = generatePairCode();
    expect(code).toMatch(/^[A-Z]+ [A-Z]+$/);
  });

  it("uses two different words", () => {
    // Generate many codes and verify words differ in each
    for (let i = 0; i < 20; i++) {
      const { code } = generatePairCode();
      const [word1, word2] = code.split(" ");
      expect(word1).not.toBe(word2);
    }
  });

  it("returns a future expiry timestamp", () => {
    const { expiresAt } = generatePairCode();
    expect(expiresAt).toBeGreaterThan(Date.now());
  });

  it("generates unique codes", () => {
    const codes = new Set<string>();
    for (let i = 0; i < 20; i++) {
      const { code } = generatePairCode();
      codes.add(code);
    }
    // With ~250 words, 250*249 = 62250 combos — collisions in 20 tries are near-zero
    expect(codes.size).toBeGreaterThan(10);
  });

  it("enforces max 5 active codes by evicting oldest", () => {
    for (let i = 0; i < 6; i++) {
      generatePairCode();
    }
    expect(getActiveCodeCount()).toBeLessThanOrEqual(5);
  });
});

describe("validatePairCode", () => {
  it("accepts a valid code and allows reuse within TTL", () => {
    const { code } = generatePairCode();
    expect(validatePairCode(code)).toBe(true);
    // Reuse within TTL succeeds (multi-device pairing)
    expect(validatePairCode(code)).toBe(true);
  });

  it("rejects unknown code", () => {
    expect(validatePairCode("NONEXISTENT UNKNOWN")).toBe(false);
  });

  it("is case-insensitive", () => {
    const { code } = generatePairCode();
    expect(validatePairCode(code.toLowerCase())).toBe(true);
  });

  it("trims whitespace", () => {
    const { code } = generatePairCode();
    expect(validatePairCode(`  ${code}  `)).toBe(true);
  });

  it("normalizes dashes to spaces", () => {
    const { code } = generatePairCode();
    const dashed = code.replace(" ", "-");
    expect(validatePairCode(dashed)).toBe(true);
  });

  it("normalizes underscores to spaces", () => {
    const { code } = generatePairCode();
    const underscored = code.replace(" ", "_");
    expect(validatePairCode(underscored)).toBe(true);
  });

  it("collapses multiple spaces", () => {
    const { code } = generatePairCode();
    const extraSpaces = code.replace(" ", "   ");
    expect(validatePairCode(extraSpaces)).toBe(true);
  });

  it("handles mixed separators and case", () => {
    const { code } = generatePairCode();
    const [w1, w2] = code.split(" ");
    // e.g. "soft-tiger" from "SOFT TIGER"
    const mangled = `${w1.toLowerCase()}-${w2.toLowerCase()}`;
    expect(validatePairCode(mangled)).toBe(true);
  });

  it("handles URL-encoded plus sign as space", () => {
    const { code } = generatePairCode();
    const plusSeparated = code.replace(" ", "+");
    expect(validatePairCode(plusSeparated)).toBe(true);
  });
});

// ---- Device Tokens ----

describe("createDeviceToken", () => {
  it("inserts a device row with hashed token", () => {
    mockStmt.get.mockReturnValue({
      id: "abc",
      name: "My Phone",
      token_hash: "hash",
      ip_address: "192.168.1.5",
      user_agent: "Mozilla/5.0",
      last_seen_at: "2025-01-01T00:00:00",
      created_at: "2025-01-01T00:00:00",
    });

    const { token, device } = createDeviceToken("My Phone", "192.168.1.5", "Mozilla/5.0");

    expect(token).toHaveLength(64); // 32 bytes hex
    expect(device.name).toBe("My Phone");

    // Verify INSERT was called with hashed token, not raw
    const insertCall = mockStmt.run.mock.calls[0];
    const storedHash = insertCall[2]; // 3rd arg = token_hash
    expect(storedHash).toBe(createHash("sha256").update(token).digest("hex"));
  });
});

describe("validateDeviceToken", () => {
  it("returns device for valid token", () => {
    const fakeDevice = {
      id: "dev1",
      name: "Phone",
      token_hash: "abc",
      ip_address: null,
      user_agent: null,
      last_seen_at: "2025-01-01",
      created_at: "2025-01-01",
    };
    mockStmt.get.mockReturnValue(fakeDevice);

    const result = validateDeviceToken("some-token");
    expect(result).toEqual(fakeDevice);

    // Verify it queries by SHA-256 hash
    const queryHash = mockStmt.get.mock.calls[0][0];
    expect(queryHash).toBe(createHash("sha256").update("some-token").digest("hex"));
  });

  it("returns null for unknown token", () => {
    mockStmt.get.mockReturnValue(undefined);
    expect(validateDeviceToken("invalid")).toBeNull();
  });
});

describe("listDevices", () => {
  it("returns devices without token_hash", () => {
    mockStmt.all.mockReturnValue([
      {
        id: "1",
        name: "Phone",
        ip_address: null,
        user_agent: null,
        last_seen_at: "2025-01-01",
        created_at: "2025-01-01",
      },
    ]);
    const devices = listDevices();
    expect(devices).toHaveLength(1);
    expect(devices[0]).not.toHaveProperty("token_hash");
  });
});

describe("revokeDevice", () => {
  it("returns true when device was deleted", () => {
    mockStmt.run.mockReturnValue({ changes: 1 });
    expect(revokeDevice("dev1")).toBe(true);
  });

  it("returns false when no device found", () => {
    mockStmt.run.mockReturnValue({ changes: 0 });
    expect(revokeDevice("nonexistent")).toBe(false);
  });
});

describe("updateLastSeen", () => {
  it("updates last_seen_at by token hash", () => {
    updateLastSeen("some-hash");
    expect(mockDb.prepare).toHaveBeenCalled();
    expect(mockStmt.run).toHaveBeenCalledWith("some-hash");
  });
});

// ---- Rate Limiting ----

describe("rate limiting", () => {
  it("returns 0 for unknown IP", () => {
    expect(checkRateLimit("1.2.3.4")).toBe(0);
  });

  it("locks out after 10 failures", () => {
    for (let i = 0; i < 10; i++) {
      recordFailure("1.2.3.4");
    }
    const lockout = checkRateLimit("1.2.3.4");
    expect(lockout).toBeGreaterThan(0);
  });

  it("does not lock out before 10 failures", () => {
    for (let i = 0; i < 9; i++) {
      recordFailure("1.2.3.4");
    }
    expect(checkRateLimit("1.2.3.4")).toBe(0);
  });

  it("resets rate limit on success", () => {
    for (let i = 0; i < 10; i++) {
      recordFailure("1.2.3.4");
    }
    resetRateLimit("1.2.3.4");
    expect(checkRateLimit("1.2.3.4")).toBe(0);
  });
});
