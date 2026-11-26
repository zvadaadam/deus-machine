import { tmpdir } from "node:os";
import { basename, dirname, join, relative } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { clearInheritedPackagedEnv, createBackendChildEnv } from "@shared/lib/child-env";
import { resolveDefaultDatabasePath } from "@shared/runtime";

const originalEnv = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnv };
});

describe("backend child process environment", () => {
  const home = join(tmpdir(), "deus-legacy-env");
  const backendCwd = join(home, "apps", "backend");
  const installed = resolveDefaultDatabasePath({
    platform: process.platform,
    homeDir: home,
    xdgDataHome: home,
  });
  const relativeInstalled = relative(backendCwd, installed);

  it.each([
    ["1", installed, undefined],
    ["1", `${dirname(installed)}/./${basename(installed)}`, undefined],
    ["1", relativeInstalled, undefined],
    ["1", "custom.db", join(backendCwd, "custom.db")],
    [undefined, relativeInstalled, relativeInstalled],
    [undefined, "link/../deus.db", "link/../deus.db"],
    [undefined, " custom.db ", " custom.db "],
  ])("handles DATABASE_PATH with DEUS_PACKAGED=%s and path %s", (packaged, value, expected) => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const env = { HOME: home, XDG_DATA_HOME: home, DEUS_PACKAGED: packaged, DATABASE_PATH: value };
    clearInheritedPackagedEnv(env, backendCwd);
    expect(env.DATABASE_PATH).toBe(expected);
    if (expected === undefined) {
      expect(warn).toHaveBeenCalledExactlyOnceWith(
        expect.stringMatching(/dropped.*DATABASE_PATH.*installed/i)
      );
    } else {
      expect(warn).not.toHaveBeenCalled();
    }
  });

  it("scrubs packaged runtime internals while preserving caller overrides", () => {
    process.env.DEUS_PACKAGED = "1";
    process.env.DEUS_RUNTIME_EXECUTABLE =
      "/Applications/Deus.app/Contents/Resources/bin/deus-runtime";
    process.env.DEUS_BUNDLED_BIN_DIR = "/Applications/Deus.app/Contents/Resources/bin";
    process.env.DEUS_RESOURCES_PATH = "/Applications/Deus.app/Contents/Resources";
    process.env.ELECTRON_RUN_AS_NODE = "1";
    process.env.NODE_PATH =
      "/Applications/Deus.app/Contents/Resources/app.asar.unpacked/node_modules";
    process.env.DATABASE_PATH = "/tmp/deus.db";
    process.env.NODE_ENV = "production";
    process.env.PORT = "1234";
    process.env.PATH = "/Applications/Deus.app/Contents/Resources/bin:/usr/bin:/bin";

    const env = createBackendChildEnv({
      CI: "1",
      DEUS_APP_ID: "app-1",
      DEUS_PORT: "9000",
    });

    expect(env.CI).toBe("1");
    expect(env.DEUS_APP_ID).toBe("app-1");
    expect(env.DEUS_PORT).toBe("9000");
    expect(env.PATH).toBe("/Applications/Deus.app/Contents/Resources/bin:/usr/bin:/bin");
    expect(env.DEUS_PACKAGED).toBeUndefined();
    expect(env.DEUS_RUNTIME_EXECUTABLE).toBeUndefined();
    expect(env.DEUS_BUNDLED_BIN_DIR).toBeUndefined();
    expect(env.DEUS_RESOURCES_PATH).toBeUndefined();
    expect(env.ELECTRON_RUN_AS_NODE).toBeUndefined();
    expect(env.NODE_PATH).toBeUndefined();
    expect(env.DATABASE_PATH).toBeUndefined();
    expect(env.NODE_ENV).toBeUndefined();
    expect(env.PORT).toBeUndefined();
  });
});
