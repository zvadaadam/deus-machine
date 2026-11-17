import { describe, expect, it } from "vitest";
import {
  DEUS_APP_ID,
  DEUS_DB_FILENAME,
  resolveDefaultDataDir,
  resolveDefaultDatabasePath,
} from "@shared/runtime";

describe("runtime contract", () => {
  it("resolves the canonical macOS data directory", () => {
    expect(resolveDefaultDataDir({ platform: "darwin", homeDir: "/Users/deus" })).toBe(
      "/Users/deus/Library/Application Support/com.deus.app"
    );
    expect(resolveDefaultDatabasePath({ platform: "darwin", homeDir: "/Users/deus" })).toBe(
      `/Users/deus/Library/Application Support/${DEUS_APP_ID}/${DEUS_DB_FILENAME}`
    );
  });

  it("resolves the canonical Linux data directory", () => {
    expect(
      resolveDefaultDataDir({
        platform: "linux",
        homeDir: "/home/deus",
        xdgDataHome: "/var/lib/deus",
      })
    ).toBe("/var/lib/deus/deus");

    expect(resolveDefaultDataDir({ platform: "linux", homeDir: "/home/deus" })).toBe(
      "/home/deus/.local/share/deus"
    );
  });
});
