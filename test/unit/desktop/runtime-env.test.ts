import { describe, expect, it } from "vitest";
import { configurePackagedMainRuntimeEnv } from "../../../apps/desktop/main/runtime-env";

describe("desktop packaged runtime environment", () => {
  it("leaves development env untouched", () => {
    const env: NodeJS.ProcessEnv = {
      PATH: "/opt/homebrew/bin:/usr/bin",
    };

    configurePackagedMainRuntimeEnv({
      isPackaged: false,
      platform: "darwin",
      resourcesPath: "/Applications/Deus.app/Contents/Resources",
      env,
    });

    expect(env).toEqual({
      PATH: "/opt/homebrew/bin:/usr/bin",
    });
  });

  it.each(["darwin", "linux"] as const)(
    "marks packaged %s main and pins PATH to bundled bin plus system tools",
    (platform) => {
      const env: NodeJS.ProcessEnv = {
        PATH: "/opt/homebrew/bin:/usr/local/bin:/usr/bin",
      };

      configurePackagedMainRuntimeEnv({
        isPackaged: true,
        platform,
        resourcesPath: "/Applications/Deus.app/Contents/Resources",
        env,
      });

      expect(env.DEUS_PACKAGED).toBe("1");
      expect(env.NODE_ENV).toBe("production");
      expect(env.DEUS_RESOURCES_PATH).toBe("/Applications/Deus.app/Contents/Resources");
      expect(env.DEUS_BUNDLED_BIN_DIR).toBe("/Applications/Deus.app/Contents/Resources/bin");
      expect(env.PATH).toBe(
        "/Applications/Deus.app/Contents/Resources/bin:/usr/bin:/bin:/usr/sbin:/sbin"
      );
    }
  );

  it("removes inherited dev runtime variables from packaged main", () => {
    const env: NodeJS.ProcessEnv = {
      AGENT_SERVER_CWD: "/repo/apps/agent-server",
      AGENT_SERVER_ENTRY: "/repo/apps/agent-server/dist/index.bundled.cjs",
      AUTH_TOKEN: "stale-auth-token",
      DATABASE_PATH: "/tmp/stale.db",
      DEUS_AUTH_TOKEN: "stale-main-auth-token",
      DEUS_BUNDLED_BIN_DIR: "/tmp/stale-bin",
      DEUS_BACKEND_PORT: "45678",
      DEUS_DATA_DIR: "/tmp/stale-data",
      DEUS_PACKAGED: "stale-packaged",
      DEUS_RESOURCES_PATH: "/tmp/stale-resources",
      DEUS_RUNTIME: "1",
      DEUS_RUNTIME_COMMAND: "backend",
      DEUS_RUNTIME_EXECUTABLE: "/tmp/deus-runtime",
      ELECTRON_RUN_AS_NODE: "1",
      NODE_PATH: "/repo/node_modules",
      PATH: "/opt/homebrew/bin:/usr/bin",
      PORT: "45678",
    };

    configurePackagedMainRuntimeEnv({
      isPackaged: true,
      platform: "darwin",
      resourcesPath: "/Applications/Deus.app/Contents/Resources",
      env,
    });

    expect(env.AGENT_SERVER_CWD).toBeUndefined();
    expect(env.AGENT_SERVER_ENTRY).toBeUndefined();
    expect(env.AUTH_TOKEN).toBeUndefined();
    expect(env.DATABASE_PATH).toBeUndefined();
    expect(env.DEUS_AUTH_TOKEN).toBeUndefined();
    expect(env.DEUS_BUNDLED_BIN_DIR).toBe("/Applications/Deus.app/Contents/Resources/bin");
    expect(env.DEUS_BACKEND_PORT).toBeUndefined();
    expect(env.DEUS_DATA_DIR).toBeUndefined();
    expect(env.DEUS_RUNTIME).toBeUndefined();
    expect(env.DEUS_RUNTIME_COMMAND).toBeUndefined();
    expect(env.DEUS_RUNTIME_EXECUTABLE).toBeUndefined();
    expect(env.ELECTRON_RUN_AS_NODE).toBeUndefined();
    expect(env.NODE_PATH).toBeUndefined();
    expect(env.PORT).toBeUndefined();
    expect(env.DEUS_PACKAGED).toBe("1");
  });
});
