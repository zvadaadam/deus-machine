import { afterEach, describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { build, BuildError } from "../src/engine/xcodebuild.js";

// Fake ChildProcess for injecting into `build()`.
class FakeChild extends EventEmitter {
  stdout = new Readable({ read() {} });
  stderr = new Readable({ read() {} });
  killed = false;
  kill(_signal?: NodeJS.Signals | number): boolean {
    this.killed = true;
    // Simulate process exit with SIGTERM.
    queueMicrotask(() => this.emit("close", 143));
    return true;
  }
}

type SpawnerCall = { bin: string; args: string[] };

function makeSpawner(onChild: (child: FakeChild) => void) {
  const calls: SpawnerCall[] = [];
  const spawner = ((bin: string, args: string[]) => {
    calls.push({ bin, args });
    const child = new FakeChild();
    queueMicrotask(() => onChild(child));
    return child as unknown as ReturnType<typeof import("node:child_process").spawn>;
  }) as unknown as typeof import("node:child_process").spawn;
  return { spawner, calls };
}

const STARTED: FakeChild[] = [];

afterEach(() => {
  // Guard: don't leave fake children emitting after a test ends.
  STARTED.length = 0;
});

describe("build", () => {
  test("passes project/scheme/destination/configuration to xcodebuild", async () => {
    const { spawner, calls } = makeSpawner((child) => {
      child.emit("close", 0);
    });

    const result = await build(
      {
        project: "/tmp/MyApp.xcodeproj",
        scheme: "MyApp",
        destination: "platform=iOS Simulator,id=ABCD",
        configuration: "Release",
      },
      spawner
    );

    expect(result.success).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(calls[0]?.bin).toBe("xcodebuild");
    const args = calls[0]!.args;
    expect(args).toContain("-project");
    expect(args).toContain("/tmp/MyApp.xcodeproj");
    expect(args).toContain("-scheme");
    expect(args).toContain("MyApp");
    expect(args).toContain("-destination");
    expect(args).toContain("platform=iOS Simulator,id=ABCD");
    expect(args).toContain("-configuration");
    expect(args).toContain("Release");
    expect(args).toContain("build");
  });

  test("uses -workspace for .xcworkspace paths", async () => {
    const { spawner, calls } = makeSpawner((child) => {
      child.emit("close", 0);
    });

    await build(
      {
        project: "/tmp/MyApp.xcworkspace",
        scheme: "MyApp",
        destination: "platform=iOS Simulator,id=ABCD",
      },
      spawner
    );

    expect(calls[0]!.args).toContain("-workspace");
    expect(calls[0]!.args).not.toContain("-project");
  });

  test("streams stdout/stderr lines via onLog", async () => {
    const lines: Array<{ line: string; stream: string }> = [];
    const { spawner } = makeSpawner((child) => {
      child.stdout.push("compiling Foo.swift\n");
      child.stderr.push("warning: deprecated API\n");
      child.stdout.push("compiling Bar.swift\n");
      child.stdout.push(null);
      child.stderr.push(null);
      queueMicrotask(() => child.emit("close", 0));
    });

    await build(
      {
        project: "/tmp/MyApp.xcodeproj",
        scheme: "MyApp",
        destination: "platform=iOS Simulator,id=ABCD",
        onLog: (line, stream) => lines.push({ line, stream }),
      },
      spawner
    );

    expect(lines).toEqual([
      { line: "compiling Foo.swift", stream: "stdout" },
      { line: "warning: deprecated API", stream: "stderr" },
      { line: "compiling Bar.swift", stream: "stdout" },
    ]);
  });

  test("returns failure with tailed stderr on non-zero exit", async () => {
    const { spawner } = makeSpawner((child) => {
      child.stderr.push("error: something broke\n");
      child.stdout.push(null);
      child.stderr.push(null);
      queueMicrotask(() => child.emit("close", 65));
    });

    const result = await build(
      {
        project: "/tmp/MyApp.xcodeproj",
        scheme: "MyApp",
        destination: "platform=iOS Simulator,id=ABCD",
      },
      spawner
    );

    expect(result.success).toBe(false);
    expect(result.exitCode).toBe(65);
    expect(result.stderrTail).toContain("error: something broke");
  });

  test("rejects with BuildError on spawn error", async () => {
    const { spawner } = makeSpawner((child) => {
      child.emit("error", new Error("ENOENT"));
    });

    await expect(
      build(
        {
          project: "/tmp/MyApp.xcodeproj",
          scheme: "MyApp",
          destination: "platform=iOS Simulator,id=ABCD",
        },
        spawner
      )
    ).rejects.toBeInstanceOf(BuildError);
  });

  test("passes derivedDataPath through to xcodebuild", async () => {
    const { spawner, calls } = makeSpawner((child) => {
      child.emit("close", 0);
    });
    await build(
      {
        project: "/tmp/MyApp.xcodeproj",
        scheme: "MyApp",
        destination: "platform=iOS Simulator,id=ABCD",
        derivedDataPath: "/tmp/DerivedData/MyApp",
      },
      spawner
    );
    expect(calls[0]!.args).toContain("-derivedDataPath");
    expect(calls[0]!.args).toContain("/tmp/DerivedData/MyApp");
  });

  test("honors AbortSignal — sends SIGTERM when aborted", async () => {
    const controller = new AbortController();
    let spawnedChild: FakeChild | undefined;
    const { spawner } = makeSpawner((child) => {
      spawnedChild = child;
    });

    const buildPromise = build(
      {
        project: "/tmp/MyApp.xcodeproj",
        scheme: "MyApp",
        destination: "platform=iOS Simulator,id=ABCD",
        signal: controller.signal,
      },
      spawner
    );

    // Wait for spawn, then abort.
    await new Promise((r) => setTimeout(r, 10));
    controller.abort();

    const result = await buildPromise;
    expect(spawnedChild?.killed).toBe(true);
    expect(result.exitCode).toBe(143); // our fake emits 143 on kill
  });
});
