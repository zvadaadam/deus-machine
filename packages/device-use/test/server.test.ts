// Integration tests for the server — drive invokeTool directly with a
// mocked executor and a temp-dir state store. Exercises the full tool
// registry, the invoker's event emission, and state persistence.

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { RefMap } from "../src/engine/snapshot/refs.js";
import type { CommandExecutor, ExecResult } from "../src/engine/types.js";
import { EventBus } from "../src/server/events.js";
import { invokeTool } from "../src/server/invoker.js";
import { StateStore } from "../src/server/state.js";
import { findTool, TOOLS, type Context } from "../src/server/tools.js";

const STORAGE_DIRS: string[] = [];

async function makeStorage(): Promise<StateStore> {
  const dir = await mkdtemp(path.join(tmpdir(), "device-use-test-"));
  STORAGE_DIRS.push(dir);
  const store = new StateStore(dir);
  await store.load();
  return store;
}

afterAll(async () => {
  for (const dir of STORAGE_DIRS) {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

function mockExecutor(responses: Record<string, ExecResult>): CommandExecutor {
  return async (command: string[]): Promise<ExecResult> => {
    for (const [prefix, res] of Object.entries(responses)) {
      if (command.join(" ").startsWith(prefix)) return res;
    }
    return { success: false, output: "", error: `unmocked: ${command.join(" ")}`, exitCode: 99 };
  };
}

async function makeCtx(overrides?: Partial<Context>): Promise<Context> {
  const state = overrides?.state ?? (await makeStorage());
  return {
    executor: overrides?.executor ?? mockExecutor({}),
    state,
    stream: {
      start: async () => ({ udid: "U", port: 9999, url: "http://127.0.0.1:9999" }),
      stop: async () => {},
      getInfo: () => undefined,
      proxyStream: async () => new Response("", { status: 404 }),
    } as any,
    events: new EventBus(),
    refMap: new RefMap(),
  };
}

describe("tool registry", () => {
  test("registers exactly 24 tools", () => {
    expect(TOOLS.length).toBe(24);
  });

  test("every tool has a unique name", () => {
    const names = TOOLS.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
  });

  test("findTool finds each registered tool", () => {
    for (const t of TOOLS) {
      expect(findTool(t.name)).toBe(t);
    }
  });

  test("findTool returns undefined for unknown names", () => {
    expect(findTool("bogus")).toBeUndefined();
  });
});

describe("invokeTool — event emission", () => {
  test("emits started + completed on success", async () => {
    const ctx = await makeCtx();
    const events: any[] = [];
    ctx.events.subscribe((e) => events.push(e));

    const result = await invokeTool(ctx, "get_state", {});
    expect(result.success).toBe(true);

    const toolEvents = events.filter((e) => e.type === "tool-event");
    expect(toolEvents).toHaveLength(2);
    expect(toolEvents[0].status).toBe("started");
    expect(toolEvents[1].status).toBe("completed");
    expect(toolEvents[0].id).toBe(toolEvents[1].id);
  });

  test("emits started + failed on unknown tool", async () => {
    const ctx = await makeCtx();
    const events: any[] = [];
    ctx.events.subscribe((e) => events.push(e));

    const result = await invokeTool(ctx, "nope", {});
    expect(result.success).toBe(false);
    expect(result.error).toContain("unknown tool");

    const toolEvents = events.filter((e) => e.type === "tool-event");
    expect(toolEvents).toHaveLength(1);
    expect(toolEvents[0].status).toBe("failed");
  });

  test("emits failed with error when params fail validation", async () => {
    const ctx = await makeCtx();
    const events: any[] = [];
    ctx.events.subscribe((e) => events.push(e));

    const result = await invokeTool(ctx, "boot", {}); // missing udid
    expect(result.success).toBe(false);
    expect(result.error).toContain("invalid params");
  });
});

describe("set_active_simulator + get_state", () => {
  test("persists UDID to state.json", async () => {
    const ctx = await makeCtx();
    const set = await invokeTool(ctx, "set_active_simulator", { udid: "ABCD-1234" });
    expect(set.success).toBe(true);

    const get = await invokeTool(ctx, "get_state", {});
    expect(get.success).toBe(true);
    expect((get.result as any).simulator.udid).toBe("ABCD-1234");
  });
});

describe("set_active_project + get_state", () => {
  test("persists project path + scheme to state", async () => {
    const ctx = await makeCtx();
    await invokeTool(ctx, "set_active_project", {
      path: "/tmp/MyApp.xcodeproj",
      scheme: "MyApp-Dev",
    });
    const result = await invokeTool(ctx, "get_state", {});
    expect((result.result as any).project.path).toBe("/tmp/MyApp.xcodeproj");
    expect((result.result as any).project.scheme).toBe("MyApp-Dev");
  });
});

describe("list_devices", () => {
  test("returns parsed simctl list output", async () => {
    const executor = mockExecutor({
      "xcrun simctl list devices available -j": {
        success: true,
        output: JSON.stringify({
          devices: {
            "com.apple.CoreSimulator.SimRuntime.iOS-18-0": [
              { udid: "DEVICE-1", name: "iPhone 16 Pro", state: "Booted", isAvailable: true },
            ],
          },
        }),
        exitCode: 0,
      },
    });
    const ctx = await makeCtx({ executor });
    const result = await invokeTool(ctx, "list_devices", {});
    expect(result.success).toBe(true);
    const { devices } = result.result as { devices: any[] };
    expect(devices).toHaveLength(1);
    expect(devices[0].udid).toBe("DEVICE-1");
  });
});

describe("get_project_info", () => {
  test("parses xcodebuild -list -json output", async () => {
    const executor = mockExecutor({
      "xcodebuild -list -json -project": {
        success: true,
        output: JSON.stringify({
          project: {
            name: "MyApp",
            schemes: ["MyApp", "MyApp-Dev"],
            targets: ["MyApp", "MyAppTests"],
            configurations: ["Debug", "Release"],
          },
        }),
        exitCode: 0,
      },
    });
    const ctx = await makeCtx({ executor });
    const result = await invokeTool(ctx, "get_project_info", { path: "/tmp/MyApp.xcodeproj" });
    expect(result.success).toBe(true);
    const info = result.result as any;
    expect(info.schemes).toEqual(["MyApp", "MyApp-Dev"]);
    expect(info.kind).toBe("xcodeproj");
  });
});

describe("tap — missing snapshot", () => {
  test("fails clearly when ref is unknown", async () => {
    const ctx = await makeCtx();
    await ctx.state.update({ simulator: { udid: "UDID-1" } });
    const result = await invokeTool(ctx, "tap", { ref: "@e42", udid: "UDID-1" });
    expect(result.success).toBe(false);
    expect(result.error).toContain("@e42");
  });
});

describe("StateStore persistence", () => {
  test("survives a reload", async () => {
    const state1 = await makeStorage();
    await state1.update({ simulator: { udid: "ABCD" } });

    // New instance pointing at the same dir
    const state2 = new StateStore((state1 as any).storageDir);
    await state2.load();
    expect(state2.get().simulator?.udid).toBe("ABCD");
  });
});

describe("EventBus", () => {
  test("delivers events to subscribers and keeps history", () => {
    const bus = new EventBus(3);
    const seen: any[] = [];
    const unsub = bus.subscribe((e) => seen.push(e));
    bus.emit({ type: "tool-event", id: "1", at: 0, tool: "a", params: {}, status: "started" });
    bus.emit({ type: "tool-event", id: "2", at: 0, tool: "b", params: {}, status: "started" });
    bus.emit({ type: "tool-event", id: "3", at: 0, tool: "c", params: {}, status: "started" });
    bus.emit({ type: "tool-event", id: "4", at: 0, tool: "d", params: {}, status: "started" });

    expect(seen).toHaveLength(4);
    const history = bus.snapshot();
    // maxHistory = 3 → first event dropped
    expect(history.map((e) => (e as any).id)).toEqual(["2", "3", "4"]);

    unsub();
    bus.emit({ type: "tool-event", id: "5", at: 0, tool: "e", params: {}, status: "started" });
    expect(seen).toHaveLength(4); // subscriber unsubscribed
  });
});
