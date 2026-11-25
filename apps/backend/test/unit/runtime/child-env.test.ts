import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { clearInheritedPackagedEnv, createBackendChildEnv } from "@shared/lib/child-env";
import { resolveDefaultDatabasePath } from "@shared/runtime";

const originalEnv = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnv };
});

describe("backend child process environment", () => {
  it("drops dotted and symlinked spellings of the installed database, and keeps a custom file", () => {
    const home = mkdtempSync(join(tmpdir(), "deus-legacy-env-"));
    try {
      const installed = resolveDefaultDatabasePath({
        platform: process.platform,
        homeDir: home,
        xdgDataHome: home,
      });
      function fromLegacyShell(path: string) {
        const env = { HOME: home, XDG_DATA_HOME: home, DEUS_PACKAGED: "1", DATABASE_PATH: path };
        clearInheritedPackagedEnv(env);
        return env.DATABASE_PATH;
      }
      expect(fromLegacyShell(`${dirname(installed)}/./${basename(installed)}`)).toBeUndefined();
      mkdirSync(dirname(installed), { recursive: true });
      writeFileSync(installed, "");
      const alias = join(home, "alias.db");
      symlinkSync(installed, alias);
      expect(fromLegacyShell(alias)).toBeUndefined();
      const custom = join(home, "custom.db");
      writeFileSync(custom, "");
      expect(fromLegacyShell(custom)).toBe(custom);
      const child = join(home, "custom/subdir");
      mkdirSync(child, { recursive: true });
      writeFileSync(join(home, "custom", basename(installed)), "");
      const link = join(dirname(installed), "link");
      symlinkSync(child, link);
      const throughParent = `${link}/../${basename(installed)}`;
      expect(fromLegacyShell(throughParent)).toBe(throughParent);
    } finally {
      rmSync(home, { recursive: true, force: true });
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
