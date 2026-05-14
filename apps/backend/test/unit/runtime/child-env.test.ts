import { afterEach, describe, expect, it } from "vitest";
import { createBackendChildEnv } from "../../../src/runtime/child-env";

const originalEnv = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnv };
});

describe("backend child process environment", () => {
  it("scrubs packaged runtime internals while preserving caller overrides", () => {
    process.env.DEUS_RUNTIME = "1";
    process.env.DEUS_RUNTIME_COMMAND = "backend";
    process.env.DEUS_RUNTIME_EXECUTABLE =
      "/Applications/Deus.app/Contents/Resources/bin/deus-runtime";
    process.env.DEUS_BUNDLED_BIN_DIR = "/Applications/Deus.app/Contents/Resources/bin";
    process.env.DEUS_RESOURCES_PATH = "/Applications/Deus.app/Contents/Resources";
    process.env.ELECTRON_RUN_AS_NODE = "1";
    process.env.NODE_PATH =
      "/Applications/Deus.app/Contents/Resources/app.asar.unpacked/node_modules";
    process.env.DATABASE_PATH = "/tmp/deus.db";
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
    expect(env.DEUS_RUNTIME).toBeUndefined();
    expect(env.DEUS_RUNTIME_COMMAND).toBeUndefined();
    expect(env.DEUS_RUNTIME_EXECUTABLE).toBeUndefined();
    expect(env.DEUS_BUNDLED_BIN_DIR).toBeUndefined();
    expect(env.DEUS_RESOURCES_PATH).toBeUndefined();
    expect(env.ELECTRON_RUN_AS_NODE).toBeUndefined();
    expect(env.NODE_PATH).toBeUndefined();
    expect(env.DATABASE_PATH).toBeUndefined();
    expect(env.PORT).toBeUndefined();
  });
});
