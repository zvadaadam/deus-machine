import { vi, describe, it, expect, beforeEach } from "vitest";

const mockFs = vi.hoisted(() => ({
  existsSync: vi.fn(() => false),
  readFileSync: vi.fn(() => "{}"),
  writeFileSync: vi.fn(),
  renameSync: vi.fn(),
  mkdirSync: vi.fn(),
}));

vi.mock("fs", () => ({ default: mockFs }));
const { invalidate } = vi.hoisted(() => ({ invalidate: vi.fn() }));
vi.mock("../../../src/services/query-engine", () => ({ invalidate }));

vi.mock("../../../src/lib/database", () => ({
  DB_PATH: "/tmp/test-deus/deus.db",
}));

// The service keeps what it read; each test reads its own file afresh.
let getAllSettings: typeof import("../../../src/services/settings.service").getAllSettings;
let saveSetting: typeof import("../../../src/services/settings.service").saveSetting;

const EXPECTED_PREFS_PATH = "/tmp/test-deus/preferences.json";
const EXPECTED_TMP_PATH = "/tmp/test-deus/preferences.json.tmp";

beforeEach(async () => {
  vi.clearAllMocks();
  mockFs.existsSync.mockReturnValue(false);
  vi.resetModules();
  ({ getAllSettings, saveSetting } = await import("../../../src/services/settings.service"));
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
      JSON.stringify({ chat_view: "full", onboarding_completed: true })
    );
    const result = getAllSettings();
    expect(result).toEqual({ chat_view: "full", onboarding_completed: true });
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
    mockFs.readFileSync.mockReturnValue(JSON.stringify({ chat_view: 123 }));
    const result = getAllSettings();
    expect(result).toEqual({ chat_view: 123 });
  });

  it("returns only public preferences from a file with unknown keys", () => {
    mockFs.existsSync.mockReturnValue(true);
    mockFs.readFileSync.mockReturnValue(JSON.stringify({ chat_view: "full", future_key: "value" }));
    const result = getAllSettings();
    expect(result).toEqual({ chat_view: "full" });
  });
});

describe("saveSetting", () => {
  it("reads existing file, merges key, and writes atomically", () => {
    mockFs.existsSync.mockReturnValue(true);
    mockFs.readFileSync.mockReturnValue(JSON.stringify({ chat_view: "full" }));

    saveSetting("server_name", "Studio");

    expect(mockFs.writeFileSync).toHaveBeenCalledWith(
      EXPECTED_TMP_PATH,
      JSON.stringify({ chat_view: "full", server_name: "Studio" }, null, 2)
    );
    expect(mockFs.renameSync).toHaveBeenCalledWith(EXPECTED_TMP_PATH, EXPECTED_PREFS_PATH);
    expect(invalidate).toHaveBeenCalledExactlyOnceWith(["settings", "relayStatus"]);
  });

  it("overwrites existing key", () => {
    mockFs.existsSync.mockReturnValue(true);
    mockFs.readFileSync.mockReturnValue(JSON.stringify({ chat_view: "bubbles" }));

    saveSetting("chat_view", "full");

    const written = JSON.parse(mockFs.writeFileSync.mock.calls[0][1]);
    expect(written.chat_view).toBe("full");
    expect(invalidate).toHaveBeenCalledExactlyOnceWith(["settings"]);
  });

  it("creates directory if missing", () => {
    // First existsSync call: prefs file doesn't exist (triggers migration)
    // Second existsSync call: directory doesn't exist
    mockFs.existsSync.mockReturnValue(false);

    saveSetting("chat_view", "full");

    expect(mockFs.mkdirSync).toHaveBeenCalledWith("/tmp/test-deus", { recursive: true });
  });

  it("preserves existing keys on partial update", () => {
    mockFs.existsSync.mockReturnValue(true);
    mockFs.readFileSync.mockReturnValue(
      JSON.stringify({ chat_view: "bubbles", user_name: "alice" })
    );

    saveSetting("onboarding_completed", true);

    const written = JSON.parse(mockFs.writeFileSync.mock.calls[0][1]);
    expect(written.chat_view).toBe("bubbles");
    expect(written.user_name).toBe("alice");
    expect(written.onboarding_completed).toBe(true);
  });
});

describe("private settings", () => {
  it("publishes a renamed server to settings and relay followers, and keeps private writes quiet", () => {
    saveSetting("server_name", "Studio");
    saveSetting("relay_machines", {});
    expect(invalidate).toHaveBeenCalledExactlyOnceWith(["settings", "relayStatus"]);
  });

  it("keeps stored provider keys and machine secrets out of the settings API", () => {
    mockFs.existsSync.mockReturnValue(true);
    mockFs.readFileSync.mockReturnValue(
      JSON.stringify({
        chat_view: "bubbles",
        anthropic_api_key: "old-a",
        openai_api_key: "old-b",
        relay_machines: { user_a: { secret: "s" } },
      })
    );
    expect(getAllSettings()).toEqual({ chat_view: "bubbles" });
  });
});
