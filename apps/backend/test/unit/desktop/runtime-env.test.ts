import { describe, expect, it } from "vitest";
import { configurePackagedMainRuntimeEnv } from "../../../../desktop/main/runtime-env";

describe("packaged main runtime environment", () => {
  it("strips stale runtime state and points macOS PATH at Resources/bin", () => {
    const env: NodeJS.ProcessEnv = {
      AGENT_SERVER_CWD: "/tmp/dev-agent-cwd",
      AGENT_SERVER_ENTRY: "/tmp/dev-agent.cjs",
      ELECTRON_RUN_AS_NODE: "1",
      DEUS_RUNTIME: "1",
      DEUS_RUNTIME_COMMAND: "backend",
      DEUS_RUNTIME_EXECUTABLE: "/tmp/old-runtime",
      NODE_PATH: "/tmp/node_modules",
      PATH: "/opt/homebrew/bin:/usr/local/bin:/usr/bin",
    };

    configurePackagedMainRuntimeEnv({
      isPackaged: true,
      platform: "darwin",
      resourcesPath: "/Applications/Deus.app/Contents/Resources",
      env,
    });

    expect(env.DEUS_PACKAGED).toBe("1");
    expect(env.DEUS_RESOURCES_PATH).toBe("/Applications/Deus.app/Contents/Resources");
    expect(env.DEUS_BUNDLED_BIN_DIR).toBe("/Applications/Deus.app/Contents/Resources/bin");
    expect(env.PATH).toBe(
      "/Applications/Deus.app/Contents/Resources/bin:/usr/bin:/bin:/usr/sbin:/sbin"
    );
    expect(env.AGENT_SERVER_CWD).toBeUndefined();
    expect(env.AGENT_SERVER_ENTRY).toBeUndefined();
    expect(env.ELECTRON_RUN_AS_NODE).toBeUndefined();
    expect(env.DEUS_RUNTIME).toBeUndefined();
    expect(env.DEUS_RUNTIME_COMMAND).toBeUndefined();
    expect(env.DEUS_RUNTIME_EXECUTABLE).toBeUndefined();
    expect(env.NODE_PATH).toBeUndefined();
  });

  it("leaves development environment untouched", () => {
    const env: NodeJS.ProcessEnv = {
      ELECTRON_RUN_AS_NODE: "1",
      PATH: "/opt/homebrew/bin:/usr/bin",
    };

    configurePackagedMainRuntimeEnv({
      isPackaged: false,
      platform: "darwin",
      resourcesPath: "/Applications/Deus.app/Contents/Resources",
      env,
    });

    expect(env).toEqual({
      ELECTRON_RUN_AS_NODE: "1",
      PATH: "/opt/homebrew/bin:/usr/bin",
    });
  });
});
