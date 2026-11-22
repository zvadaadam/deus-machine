import { EventEmitter } from "node:events";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { simStart } from "@shared/api/simulator";
import { SCHEMA_SQL } from "@shared/schema";
import type { SimulatorCapabilities } from "@shared/types/simulator";
import { operations } from "../../helpers";
import simulatorOperations from "../../../src/api/simulator";
import * as simulator from "../../../src/services/simulator-context";
import { archiveWorkspace } from "../../../src/services/workspace-archive.service";

// A stream start whose helper says it is ready and then exits before the
// session is registered: the start fails, and nothing announces the stream.

const helper = vi.hoisted(() => ({
  child: null as null | (EventEmitter & { kill: ReturnType<typeof vi.fn> }),
  onConnect: () => {},
}));

let db: Database.Database;
vi.mock("../../../src/lib/database", () => ({ getDatabase: () => db }));

vi.mock("device-use/engine", () => ({
  simulatorEnv: (base: NodeJS.ProcessEnv) => base,
  findBridgePath: () => "/bin/simbridge",
}));

vi.mock("child_process", async (original) => {
  const { EventEmitter } = await import("node:events");
  return {
    ...(await original<typeof import("child_process")>()),
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

beforeEach(() => {
  db = new Database(":memory:");
  db.exec(SCHEMA_SQL);
  db.exec("INSERT INTO repositories (id, name) VALUES ('r', 'test')");
  const insert = db.prepare(
    "INSERT INTO workspaces (id, repository_id, slug, state) VALUES (?, 'r', ?, 'ready')"
  );
  for (const id of ["ws-1", "archived", "other"]) insert.run(id, id);
  published.length = 0;
  helper.child = null;
  helper.onConnect = () => {};
});
afterEach(() => db.close());

describe("a stream whose helper exits between ready and registration", () => {
  it("fails the start and never announces the stream", async () => {
    helper.onConnect = () => {
      helper.child!.emit("exit", 1);
    };
    await expect(simulator.startStream("ws-1", "UDID-1", true)).rejects.toThrow(
      "stopped while it was starting"
    );
    expect(published).not.toContainEqual(expect.objectContaining({ type: "streamReady" }));
    expect(simulator.getContextForWorkspace("ws-1")).toBeNull();
  });
});

it("lets an archive stop a simulator before its session is registered", async () => {
  helper.onConnect = () => simulator.stopStream("archived");
  await expect(simulator.startStream("archived", "UDID-2", true)).rejects.toThrow(
    "stopped while it was starting"
  );
  expect(simulator.getContextForWorkspace("archived")).toBeNull();
  expect(published).not.toContainEqual(expect.objectContaining({ type: "streamReady" }));
  expect(helper.child!.kill).toHaveBeenCalledWith("SIGTERM");
  helper.onConnect = () => {};
  await simulator.startStream("other", "UDID-2", true);
  expect(simulator.getContextForWorkspace("other")?.udid).toBe("UDID-2");
  simulator.stopStream("other");
});

it("refuses a simulator start when the workspace was archived during the capability check", async () => {
  const capability = Promise.withResolvers<SimulatorCapabilities>();
  const checked = vi
    .spyOn(simulator, "getSimulatorCapabilities")
    .mockReturnValueOnce(capability.promise);
  const stream = vi.spyOn(simulator, "startStream");
  const request = operations(simulatorOperations)(simStart, {
    workspaceId: "archived",
    udid: "UDID-3",
    skipBootCheck: true,
  });
  expect(checked).toHaveBeenCalledOnce();
  expect(stream).not.toHaveBeenCalled();
  await archiveWorkspace("archived");
  capability.resolve({ available: true, unavailableReason: null });
  await request;

  try {
    await expect(stream.mock.results[0].value).rejects.toThrow(/archived/i);
    expect(published).toContainEqual({
      type: "streamFailed",
      error: expect.stringMatching(/archived/i),
    });
    expect(simulator.getContextForWorkspace("archived")).toBeNull();
    expect(helper.child).toBeNull();
    await simulator.startStream("other", "UDID-3", true);
    expect(simulator.getContextForWorkspace("other")?.udid).toBe("UDID-3");
  } finally {
    simulator.stopStream("other");
    simulator.stopStream("archived");
  }
});
