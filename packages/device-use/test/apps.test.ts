import { describe, expect, test } from "bun:test";
import { getAppState, listApps, setPermission } from "../src/engine/simctl.js";
import { ValidationError } from "../src/engine/errors.js";
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

describe("getAppState", () => {
  function launchctlMock(runningBundles: Record<string, number | "-">): string {
    const lines = Object.entries(runningBundles).map(
      ([bundle, pid]) => `${pid}\t0\tUIKitApplication:${bundle}[aaaa][rb-legacy]`
    );
    lines.push("-\t0\tcom.apple.mdworker_shared[bbbb]");
    return lines.join("\n");
  }

  test("installed + running → pid present", async () => {
    const exec = mockExecutor([
      {
        match: (cmd) => cmd.includes("get_app_container"),
        result: { success: true, output: "/some/path", exitCode: 0 },
      },
      {
        match: (cmd) => cmd.includes("launchctl"),
        result: {
          success: true,
          output: launchctlMock({ "com.apple.Preferences": 42 }),
          exitCode: 0,
        },
      },
    ]);
    const state = await getAppState(exec, UDID, "com.apple.Preferences");
    expect(state).toEqual({
      bundleId: "com.apple.Preferences",
      installed: true,
      running: true,
      pid: 42,
    });
  });

  test("installed but not running → pid missing", async () => {
    const exec = mockExecutor([
      {
        match: (cmd) => cmd.includes("get_app_container"),
        result: { success: true, output: "/x", exitCode: 0 },
      },
      {
        match: (cmd) => cmd.includes("launchctl"),
        result: { success: true, output: launchctlMock({ "com.apple.Other": 1 }), exitCode: 0 },
      },
    ]);
    const state = await getAppState(exec, UDID, "com.apple.Preferences");
    expect(state).toEqual({
      bundleId: "com.apple.Preferences",
      installed: true,
      running: false,
    });
  });

  test("not installed", async () => {
    const exec = mockExecutor([
      { match: (cmd) => cmd.includes("get_app_container"), fail: "not found" },
      {
        match: (cmd) => cmd.includes("launchctl"),
        result: { success: true, output: "", exitCode: 0 },
      },
    ]);
    const state = await getAppState(exec, UDID, "com.nope");
    expect(state.installed).toBe(false);
    expect(state.running).toBe(false);
  });

  test("launchctl entry with pid '-' does not count as running", async () => {
    const exec = mockExecutor([
      {
        match: (cmd) => cmd.includes("get_app_container"),
        result: { success: true, output: "/x", exitCode: 0 },
      },
      {
        match: (cmd) => cmd.includes("launchctl"),
        result: {
          success: true,
          output: launchctlMock({ "com.apple.Preferences": "-" }),
          exitCode: 0,
        },
      },
    ]);
    const state = await getAppState(exec, UDID, "com.apple.Preferences");
    expect(state.running).toBe(false);
    expect(state.pid).toBeUndefined();
  });
});

describe("setPermission", () => {
  test("builds the correct simctl privacy command", async () => {
    const exec = mockExecutor([
      { match: () => true, result: { success: true, output: "", exitCode: 0 } },
    ]);
    await setPermission(exec, UDID, "grant", "location", "com.apple.Maps");
    expect(exec.calls[0]).toEqual([
      "xcrun",
      "simctl",
      "privacy",
      UDID,
      "grant",
      "location",
      "com.apple.Maps",
    ]);
  });

  test("reset may omit bundleId", async () => {
    const exec = mockExecutor([
      { match: () => true, result: { success: true, output: "", exitCode: 0 } },
    ]);
    await setPermission(exec, UDID, "reset", "all");
    expect(exec.calls[0]).toEqual(["xcrun", "simctl", "privacy", UDID, "reset", "all"]);
  });

  test("grant without bundleId is a ValidationError", async () => {
    const exec = mockExecutor([]);
    await expect(setPermission(exec, UDID, "grant", "location")).rejects.toThrow(ValidationError);
  });
});
