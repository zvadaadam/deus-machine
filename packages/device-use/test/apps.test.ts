import { describe, expect, test } from "bun:test";
import { listApps } from "../src/engine/simctl.js";
import type { CommandExecutor, ExecResult } from "../src/engine/types.js";

function mockExecutor(
  responses: Array<
    | { match: (cmd: string[]) => boolean; result: ExecResult }
    | { match: (cmd: string[]) => boolean; fail: string }
  >
): CommandExecutor & { calls: string[][] } {
  const calls: string[][] = [];
  const fn = async (cmd: string[]): Promise<ExecResult> => {
    calls.push(cmd);
    for (const r of responses) {
      if (r.match(cmd)) {
        if ("fail" in r) {
          return { success: false, output: "", error: r.fail, exitCode: 1 };
        }
        return r.result;
      }
    }
    return { success: false, output: "", error: `unexpected: ${cmd.join(" ")}`, exitCode: 99 };
  };
  Object.defineProperty(fn, "calls", { value: calls });
  return fn as CommandExecutor & { calls: string[][] };
}

const UDID = "AAAA-BBBB";

describe("listApps", () => {
  test("parses plist-converted JSON", async () => {
    const payload = JSON.stringify({
      "com.example.a": {
        ApplicationType: "User",
        CFBundleIdentifier: "com.example.a",
        CFBundleDisplayName: "A",
        CFBundleShortVersionString: "1.2",
        Path: "/path/A.app",
      },
      "com.apple.maps": {
        ApplicationType: "System",
        CFBundleIdentifier: "com.apple.maps",
        CFBundleDisplayName: "Maps",
        CFBundleVersion: "1",
      },
    });

    const exec = mockExecutor([
      {
        match: (cmd) => cmd[0] === "sh" && cmd.includes("-c"),
        result: { success: true, output: payload, exitCode: 0 },
      },
    ]);

    const apps = await listApps(exec, UDID);
    expect(apps).toHaveLength(2);
    // sorted by display name: "A", "Maps"
    expect(apps[0]!.name).toBe("A");
    expect(apps[0]!.bundleId).toBe("com.example.a");
    expect(apps[0]!.type).toBe("User");
    expect(apps[0]!.version).toBe("1.2");
    expect(apps[1]!.type).toBe("System");
  });

  test("filters by type=User", async () => {
    const payload = JSON.stringify({
      u: { ApplicationType: "User", CFBundleDisplayName: "U" },
      s: { ApplicationType: "System", CFBundleDisplayName: "S" },
    });
    const exec = mockExecutor([
      { match: () => true, result: { success: true, output: payload, exitCode: 0 } },
    ]);
    const apps = await listApps(exec, UDID, { type: "User" });
    expect(apps).toHaveLength(1);
    expect(apps[0]!.bundleId).toBe("u");
  });

  test("throws SimctlError when the pipeline fails", async () => {
    const exec = mockExecutor([{ match: () => true, fail: "boom" }]);
    await expect(listApps(exec, UDID)).rejects.toThrow(/Failed to list apps/);
  });

  test("throws on malformed JSON", async () => {
    const exec = mockExecutor([
      { match: () => true, result: { success: true, output: "not json {", exitCode: 0 } },
    ]);
    await expect(listApps(exec, UDID)).rejects.toThrow(/Unexpected listapps output/);
  });
});
