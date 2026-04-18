import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { streamLogs } from "../src/engine/logs.js";

class FakeChild extends EventEmitter {
  stdout = new Readable({ read() {} });
  stderr = new Readable({ read() {} });
  killed = false;
  kill(_signal?: NodeJS.Signals | number): boolean {
    this.killed = true;
    queueMicrotask(() => this.emit("close", 143));
    return true;
  }
}

function makeSpawner(onChild: (child: FakeChild) => void) {
  const calls: Array<{ bin: string; args: string[] }> = [];
  const spawner = ((bin: string, args: string[]) => {
    calls.push({ bin, args });
    const child = new FakeChild();
    queueMicrotask(() => onChild(child));
    return child as unknown as ReturnType<typeof import("node:child_process").spawn>;
  }) as unknown as typeof import("node:child_process").spawn;
  return { spawner, calls };
}

describe("streamLogs", () => {
  test("invokes simctl spawn <udid> log stream with defaults", async () => {
    const lines: string[] = [];
    const { spawner, calls } = makeSpawner((child) => {
      child.stdout.push("first log line\n");
      child.stdout.push("second log line\n");
      child.stdout.push(null);
      queueMicrotask(() => child.emit("close", 0));
    });

    const handle = streamLogs(
      {
        udid: "ABCD-UDID",
        onLine: (line) => lines.push(line),
      },
      spawner
    );

    await new Promise((r) => setTimeout(r, 30));

    expect(calls[0]?.bin).toBe("xcrun");
    expect(calls[0]!.args.slice(0, 5)).toEqual(["simctl", "spawn", "ABCD-UDID", "log", "stream"]);
    expect(calls[0]!.args).toContain("--level");
    expect(calls[0]!.args).toContain("default");
    expect(calls[0]!.args).toContain("--style");
    expect(calls[0]!.args).toContain("compact");
    expect(lines).toEqual(["first log line", "second log line"]);
    expect(handle.stopped).toBe(true);
  });

  test("applies bundleId filter via --predicate", async () => {
    const { spawner, calls } = makeSpawner((child) => {
      queueMicrotask(() => child.emit("close", 0));
    });
    streamLogs(
      {
        udid: "ABCD",
        bundleId: "com.example.app",
        onLine: () => {},
      },
      spawner
    );
    await new Promise((r) => setTimeout(r, 10));

    const args = calls[0]!.args;
    const predicateIdx = args.indexOf("--predicate");
    expect(predicateIdx).toBeGreaterThanOrEqual(0);
    expect(args[predicateIdx + 1]).toContain('subsystem == "com.example.app"');
  });

  test("combines bundleId + pid filters with AND", async () => {
    const { spawner, calls } = makeSpawner((child) => {
      queueMicrotask(() => child.emit("close", 0));
    });
    streamLogs(
      {
        udid: "ABCD",
        bundleId: "com.example.app",
        pid: 1234,
        onLine: () => {},
      },
      spawner
    );
    await new Promise((r) => setTimeout(r, 10));

    const args = calls[0]!.args;
    const predicateIdx = args.indexOf("--predicate");
    expect(args[predicateIdx + 1]).toContain('subsystem == "com.example.app"');
    expect(args[predicateIdx + 1]).toContain("AND");
    expect(args[predicateIdx + 1]).toContain("processID == 1234");
  });

  test("stop() sends SIGTERM", async () => {
    let spawnedChild: FakeChild | undefined;
    const { spawner } = makeSpawner((child) => {
      spawnedChild = child;
    });

    const handle = streamLogs(
      {
        udid: "ABCD",
        onLine: () => {},
      },
      spawner
    );

    await new Promise((r) => setTimeout(r, 10));
    handle.stop();
    expect(spawnedChild?.killed).toBe(true);
  });

  test("calls onExit with exit code", async () => {
    const { spawner } = makeSpawner((child) => {
      queueMicrotask(() => child.emit("close", 7));
    });

    let exitCode: number | null | undefined;
    streamLogs(
      {
        udid: "ABCD",
        onLine: () => {},
        onExit: (code) => {
          exitCode = code;
        },
      },
      spawner
    );

    await new Promise((r) => setTimeout(r, 20));
    expect(exitCode).toBe(7);
  });

  test("handles partial lines across chunk boundaries", async () => {
    const lines: string[] = [];
    const { spawner } = makeSpawner((child) => {
      child.stdout.push("first ");
      child.stdout.push("part\nsecond line\n");
      child.stdout.push(null);
      queueMicrotask(() => child.emit("close", 0));
    });

    streamLogs(
      {
        udid: "ABCD",
        onLine: (line) => lines.push(line),
      },
      spawner
    );

    await new Promise((r) => setTimeout(r, 20));
    expect(lines).toEqual(["first part", "second line"]);
  });
});
