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
});
