import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";

// A stream start whose helper says it is ready and then exits before the
// session is registered: the start fails, and nothing announces the stream.

const helper = vi.hoisted(() => ({
  child: null as null | (EventEmitter & { kill: ReturnType<typeof vi.fn> }),
  onConnect: () => {},
}));

vi.mock("device-use/engine", () => ({
  simulatorEnv: (base: NodeJS.ProcessEnv) => base,
  findBridgePath: () => "/bin/simbridge",
}));

vi.mock("child_process", async () => {
  const { EventEmitter } = await import("node:events");
  return {
    execFile: (_file: string, args: string[], ...rest: unknown[]) => {
      const done = rest.pop() as (err: Error | null, out: unknown) => void;
      const stdout = args.includes("list") ? JSON.stringify({ devices: {} }) : "";
      done(null, { stdout, stderr: "" });
    },
    spawn: () => {
      const child = Object.assign(new EventEmitter(), {
        stdout: new EventEmitter(),
        stderr: new EventEmitter(),
        kill: vi.fn(),
      });
      helper.child = child;
      setImmediate(() =>
        child.stdout.emit("data", Buffer.from('{"status":"streaming","port":4000}\n'))
      );
      return child;
    },
  };
});

// The helper exits while the backend connects its input socket.
vi.mock("ws", async () => {
  const { EventEmitter } = await import("node:events");
  class FakeSocket extends EventEmitter {
    static OPEN = 1;
    close() {}
    constructor() {
      super();
      setImmediate(() => {
        helper.onConnect();
        this.emit("open");
      });
    }
  }
  return { default: FakeSocket };
});

const published = vi.hoisted(() => [] as unknown[]);
vi.mock("../../../src/services/streams", () => ({
  publish: (_stream: unknown, _scope: unknown, event: unknown) => published.push(event),
}));

import {
  getContextForWorkspace,
  startStream,
  stopStream,
} from "../../../src/services/simulator-context";

describe("a stream whose helper exits between ready and registration", () => {
  it("fails the start and never announces the stream", async () => {
    helper.onConnect = () => {
      helper.child!.emit("exit", 1);
    };
    await expect(startStream("ws-1", "UDID-1", true)).rejects.toThrow(
      "stopped while it was starting"
    );
    expect(published).not.toContainEqual(expect.objectContaining({ type: "streamReady" }));
    expect(getContextForWorkspace("ws-1")).toBeNull();
  });
});

it("lets an archive stop a simulator before its session is registered", async () => {
  helper.onConnect = () => stopStream("archived");
  await expect(startStream("archived", "UDID-2", true)).rejects.toThrow(
    "stopped while it was starting"
  );
  expect(getContextForWorkspace("archived")).toBeNull();
  expect(published).not.toContainEqual(expect.objectContaining({ type: "streamReady" }));
  expect(helper.child!.kill).toHaveBeenCalledWith("SIGTERM");
  helper.onConnect = () => {};
  await startStream("other", "UDID-2", true);
  expect(getContextForWorkspace("other")?.udid).toBe("UDID-2");
  stopStream("other");
});
