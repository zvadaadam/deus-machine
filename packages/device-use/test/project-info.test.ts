import { describe, expect, test } from "bun:test";
import { getProjectInfo, XcodebuildError } from "../src/engine/project-info.js";
import type { CommandExecutor, ExecResult } from "../src/engine/types.js";

function executorReturning(result: Partial<ExecResult> = {}): CommandExecutor & {
  calls: string[][];
} {
  const calls: string[][] = [];
  const fn = async (cmd: string[]): Promise<ExecResult> => {
    calls.push(cmd);
    return {
      success: true,
      output: "",
      exitCode: 0,
      ...result,
    };
  };
  Object.defineProperty(fn, "calls", { value: calls });
  return fn as CommandExecutor & { calls: string[][] };
}

describe("getProjectInfo", () => {
  test("parses xcodebuild -list -json for an .xcodeproj", async () => {
    const output = JSON.stringify({
      project: {
        name: "MyApp",
        schemes: ["MyApp", "MyApp-Dev"],
        targets: ["MyApp", "MyAppTests"],
        configurations: ["Debug", "Release"],
      },
    });
    const executor = executorReturning({ output });
    const info = await getProjectInfo(executor, "/tmp/MyApp.xcodeproj");

    expect(info.name).toBe("MyApp");
    expect(info.schemes).toEqual(["MyApp", "MyApp-Dev"]);
    expect(info.targets).toEqual(["MyApp", "MyAppTests"]);
    expect(info.configurations).toEqual(["Debug", "Release"]);
    expect(info.kind).toBe("xcodeproj");
    expect(info.path).toBe("/tmp/MyApp.xcodeproj");

    expect(executor.calls[0]).toEqual([
      "xcodebuild",
      "-list",
      "-json",
      "-project",
      "/tmp/MyApp.xcodeproj",
    ]);
  });

  test("uses -workspace flag for .xcworkspace paths", async () => {
    const output = JSON.stringify({
      workspace: { name: "MyApp", schemes: ["MyApp", "Pods-MyApp"] },
    });
    const executor = executorReturning({ output });
    const info = await getProjectInfo(executor, "/tmp/MyApp.xcworkspace");

    expect(info.kind).toBe("workspace");
    expect(info.schemes).toEqual(["MyApp", "Pods-MyApp"]);
    expect(executor.calls[0]?.[3]).toBe("-workspace");
  });

  test("throws XcodebuildError when xcodebuild fails", async () => {
    const executor = executorReturning({
      success: false,
      exitCode: 65,
      error: "xcodebuild: error: The project cannot be opened",
    });
    await expect(getProjectInfo(executor, "/missing.xcodeproj")).rejects.toBeInstanceOf(
      XcodebuildError
    );
  });

  test("throws on malformed JSON output", async () => {
    const executor = executorReturning({ output: "not-json" });
    await expect(getProjectInfo(executor, "/tmp/MyApp.xcodeproj")).rejects.toBeInstanceOf(
      XcodebuildError
    );
  });

  test("handles workspace with no schemes array", async () => {
    const executor = executorReturning({
      output: JSON.stringify({ workspace: { name: "Empty" } }),
    });
    const info = await getProjectInfo(executor, "/tmp/Empty.xcworkspace");
    expect(info.schemes).toEqual([]);
    expect(info.targets).toEqual([]);
  });
});
