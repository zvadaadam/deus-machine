import { vi, describe, it, expect, beforeEach } from "vitest";

const mockFs = vi.hoisted(() => ({
  existsSync: vi.fn(() => false),
  readFileSync: vi.fn(() => "{}"),
  writeFileSync: vi.fn(),
  renameSync: vi.fn(),
  mkdirSync: vi.fn(),
}));

vi.mock("fs", () => ({ default: mockFs }));

vi.mock("../../../src/lib/database", () => ({
  DB_PATH: "/tmp/test-deus/deus.db",
}));

import {
  getAllSettings,
  removeSettings,
  saveSetting,
} from "../../../src/services/settings.service";

const EXPECTED_PREFS_PATH = "/tmp/test-deus/preferences.json";
const EXPECTED_TMP_PATH = "/tmp/test-deus/preferences.json.tmp";

beforeEach(() => {
  vi.clearAllMocks();
  mockFs.existsSync.mockReturnValue(false);
});

describe("getAllSettings", () => {
  it("returns empty object when file does not exist and no DB", () => {
    mockFs.existsSync.mockReturnValue(false);
    const result = getAllSettings();
    expect(result).toEqual({});
  });

  it("returns parsed settings when file exists", () => {
    mockFs.existsSync.mockReturnValue(true);
    mockFs.readFileSync.mockReturnValue(
      JSON.stringify({ theme: "dark", onboarding_completed: true })
    );
    const result = getAllSettings();
    expect(result).toEqual({ theme: "dark", onboarding_completed: true });
  });

  it("returns empty object when file contains invalid JSON", () => {
    mockFs.existsSync.mockReturnValue(true);
    mockFs.readFileSync.mockImplementation(() => {
      throw new Error("bad JSON");
    });
    const result = getAllSettings();
    expect(result).toEqual({});
  });

  it("returns raw object on Zod validation failure (graceful fallback)", () => {
    mockFs.existsSync.mockReturnValue(true);
    mockFs.readFileSync.mockReturnValue(JSON.stringify({ theme: 123 }));
    const result = getAllSettings();
    expect(result).toEqual({ theme: 123 });
  });

  it("preserves unknown keys via passthrough (forward compat)", () => {
    mockFs.existsSync.mockReturnValue(true);
    mockFs.readFileSync.mockReturnValue(JSON.stringify({ theme: "dark", future_key: "value" }));
    const result = getAllSettings();
    expect(result.theme).toBe("dark");
    expect(result.future_key).toBe("value");
  });
});

describe("saveSetting", () => {
  it("reads existing file, merges key, and writes atomically", () => {
    mockFs.existsSync.mockReturnValue(true);
    mockFs.readFileSync.mockReturnValue(JSON.stringify({ theme: "dark" }));

    saveSetting("user_name", "Alice");

    expect(mockFs.writeFileSync).toHaveBeenCalledWith(
      EXPECTED_TMP_PATH,
      JSON.stringify({ theme: "dark", user_name: "Alice" }, null, 2)
    );
    expect(mockFs.renameSync).toHaveBeenCalledWith(EXPECTED_TMP_PATH, EXPECTED_PREFS_PATH);
  });

  it("overwrites existing key", () => {
    mockFs.existsSync.mockReturnValue(true);
    mockFs.readFileSync.mockReturnValue(JSON.stringify({ theme: "light" }));

    saveSetting("theme", "dark");

    const written = JSON.parse(mockFs.writeFileSync.mock.calls[0][1]);
    expect(written.theme).toBe("dark");
  });

  it("creates directory if missing", () => {
    // First existsSync call: prefs file doesn't exist (triggers migration)
    // Second existsSync call: directory doesn't exist
    mockFs.existsSync.mockReturnValue(false);

    saveSetting("theme", "dark");

    expect(mockFs.mkdirSync).toHaveBeenCalledWith("/tmp/test-deus", { recursive: true });
  });

  it("preserves existing keys on partial update", () => {
    mockFs.existsSync.mockReturnValue(true);
    mockFs.readFileSync.mockReturnValue(JSON.stringify({ theme: "light", user_name: "alice" }));

    saveSetting("onboarding_completed", true);

    const written = JSON.parse(mockFs.writeFileSync.mock.calls[0][1]);
    expect(written.theme).toBe("light");
    expect(written.user_name).toBe("alice");
    expect(written.onboarding_completed).toBe(true);
  });
});

describe("removeSettings", () => {
  it("deletes only the named keys and writes once", () => {
    mockFs.existsSync.mockReturnValue(true);
    mockFs.readFileSync.mockReturnValue(
      JSON.stringify({ theme: "dark", relay_token: "old", relay_server_id: "abcd1234" })
    );
    expect(removeSettings(["relay_token", "relay_server_id"])).toBe(true);
    expect(mockFs.writeFileSync).toHaveBeenCalledOnce();
    expect(JSON.parse(mockFs.writeFileSync.mock.calls[0][1] as string)).toEqual({ theme: "dark" });
  });

  it("writes nothing when none of the keys exist", () => {
    mockFs.existsSync.mockReturnValue(true);
    mockFs.readFileSync.mockReturnValue(JSON.stringify({ theme: "dark" }));
    expect(removeSettings(["relay_token"])).toBe(false);
    expect(mockFs.writeFileSync).not.toHaveBeenCalled();
  });

  it("keeps machine secrets out of the settings API", () => {
    mockFs.existsSync.mockReturnValue(true);
    mockFs.readFileSync.mockReturnValue(
      JSON.stringify({ theme: "dark", relay_machines: { user_a: { secret: "s" } } })
    );
    expect(getAllSettings()).toEqual({ theme: "dark" });
  });
});
