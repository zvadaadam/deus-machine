import { describe, expect, it } from "vitest";
import { buildCodexAppServerSpawnCommand } from "../agents/codex-server/codex-server-client";

describe("buildCodexAppServerSpawnCommand", () => {
  it("spawns native Codex binaries directly", () => {
    expect(buildCodexAppServerSpawnCommand("/repo/vendor/codex")).toEqual({
      command: "/repo/vendor/codex",
      args: ["app-server", "--listen", "stdio://"],
    });
  });

  it("treats custom paths as executable commands without resolving a JS runtime", () => {
    expect(buildCodexAppServerSpawnCommand("/custom/bin/codex")).toEqual({
      command: "/custom/bin/codex",
      args: ["app-server", "--listen", "stdio://"],
    });
  });
});
