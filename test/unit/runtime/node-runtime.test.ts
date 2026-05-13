import { describe, expect, it } from "vitest";
import { resolveNodeRuntimeCommand } from "../../../scripts/runtime/node-runtime";

describe("resolveNodeRuntimeCommand", () => {
  it("uses the current executable when already running under Node", () => {
    expect(
      resolveNodeRuntimeCommand({
        execPath: "/usr/local/bin/node",
        versions: { node: "24.3.0" } as NodeJS.ProcessVersions,
        env: {},
      })
    ).toBe("/usr/local/bin/node");
  });

  it("uses node from PATH when the launcher is running under Bun", () => {
    expect(
      resolveNodeRuntimeCommand({
        execPath: "/opt/homebrew/bin/bun",
        versions: { node: "24.3.0", bun: "1.2.19" } as unknown as NodeJS.ProcessVersions,
        env: {},
      })
    ).toBe("node");
  });

  it("allows callers to provide an explicit Node binary", () => {
    expect(
      resolveNodeRuntimeCommand({
        execPath: "/opt/homebrew/bin/bun",
        versions: { node: "24.3.0", bun: "1.2.19" } as unknown as NodeJS.ProcessVersions,
        env: { DEUS_NODE_BINARY: "/custom/node" },
      })
    ).toBe("/custom/node");
  });
});
