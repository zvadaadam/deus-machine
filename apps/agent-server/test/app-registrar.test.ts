// Tests for agent-server/src/app-registrar.ts — the AAP MCP registrar.
//
// The registrar holds a module-scope `Map<serverName, { type:"http", url }>`
// and broadcasts the FULL map to every active Claude Query via
// `query.setMcpServers(...)` on every register/unregister call. This matches
// the SDK contract: setMcpServers REPLACES the dynamic-server map, so we must
// pass the complete current state each time.

import { describe, it, expect, beforeEach, vi } from "vitest";
import type { Query } from "@anthropic-ai/claude-agent-sdk";

// Use the real SessionStore so tests reflect production semantics.
import { claudeQueries } from "../agents/claude/claude-session";
import {
  registerAppMcp,
  unregisterAppMcp,
  attachQuery,
  detachQuery,
  __clearRegistrarForTests,
} from "../app-registrar";

// Minimal Query mock — only setMcpServers is exercised by the registrar.
function makeFakeQuery(): Query & { setMcpServers: ReturnType<typeof vi.fn> } {
  return {
    setMcpServers: vi.fn(async () => ({ added: [], removed: [], errors: {} })),
  } as unknown as Query & { setMcpServers: ReturnType<typeof vi.fn> };
}

describe("app-registrar", () => {
  beforeEach(() => {
    __clearRegistrarForTests();
    claudeQueries.clear();
  });

  it("registerAppMcp adds the server and broadcasts the full map to every active Query", async () => {
    const q1 = makeFakeQuery();
    const q2 = makeFakeQuery();
    claudeQueries.set("session-1", q1);
    claudeQueries.set("session-2", q2);

    await registerAppMcp("deus_mobile_use", "http://127.0.0.1:1234/mcp");

    expect(q1.setMcpServers).toHaveBeenCalledTimes(1);
    expect(q1.setMcpServers).toHaveBeenCalledWith({
      deus_mobile_use: { type: "http", url: "http://127.0.0.1:1234/mcp" },
    });
    expect(q2.setMcpServers).toHaveBeenCalledTimes(1);
    expect(q2.setMcpServers).toHaveBeenCalledWith({
      deus_mobile_use: { type: "http", url: "http://127.0.0.1:1234/mcp" },
    });
  });

  it("registerAppMcp a SECOND app passes BOTH entries — setMcpServers replaces not appends", async () => {
    const q1 = makeFakeQuery();
    claudeQueries.set("session-1", q1);

    await registerAppMcp("app_one", "http://127.0.0.1:1111/mcp");
    await registerAppMcp("app_two", "http://127.0.0.1:2222/mcp");

    // First call: only app_one
    expect(q1.setMcpServers).toHaveBeenNthCalledWith(1, {
      app_one: { type: "http", url: "http://127.0.0.1:1111/mcp" },
    });
    // Second call: FULL map — app_one AND app_two together
    expect(q1.setMcpServers).toHaveBeenNthCalledWith(2, {
      app_one: { type: "http", url: "http://127.0.0.1:1111/mcp" },
      app_two: { type: "http", url: "http://127.0.0.1:2222/mcp" },
    });
  });

  it("unregisterAppMcp removes the entry and broadcasts the remaining map", async () => {
    const q1 = makeFakeQuery();
    claudeQueries.set("session-1", q1);

    await registerAppMcp("app_one", "http://127.0.0.1:1111/mcp");
    await registerAppMcp("app_two", "http://127.0.0.1:2222/mcp");

    q1.setMcpServers.mockClear();
    await unregisterAppMcp("app_one");

    expect(q1.setMcpServers).toHaveBeenCalledTimes(1);
    expect(q1.setMcpServers).toHaveBeenCalledWith({
      app_two: { type: "http", url: "http://127.0.0.1:2222/mcp" },
    });
  });

  it("unregisterAppMcp the last entry broadcasts an empty map (clears dynamic servers)", async () => {
    const q1 = makeFakeQuery();
    claudeQueries.set("session-1", q1);

    await registerAppMcp("app_one", "http://127.0.0.1:1111/mcp");
    q1.setMcpServers.mockClear();

    await unregisterAppMcp("app_one");

    expect(q1.setMcpServers).toHaveBeenCalledTimes(1);
    expect(q1.setMcpServers).toHaveBeenCalledWith({});
  });

  it("unregister an unknown server is a silent no-op — no broadcast", async () => {
    const q1 = makeFakeQuery();
    claudeQueries.set("session-1", q1);

    await unregisterAppMcp("never_registered");

    // No entry was removed, so we don't broadcast at all (prevents thrashing
    // the SDK for no reason).
    expect(q1.setMcpServers).not.toHaveBeenCalled();
  });

  it("register when no sessions exist records state for LATER broadcasts", async () => {
    // No sessions yet — nothing to broadcast now.
    await registerAppMcp("app_one", "http://127.0.0.1:1111/mcp");

    const q1 = makeFakeQuery();
    claudeQueries.set("session-1", q1);

    // Registering a second one should broadcast BOTH entries (including the
    // one from before any session existed).
    await registerAppMcp("app_two", "http://127.0.0.1:2222/mcp");

    expect(q1.setMcpServers).toHaveBeenCalledTimes(1);
    expect(q1.setMcpServers).toHaveBeenCalledWith({
      app_one: { type: "http", url: "http://127.0.0.1:1111/mcp" },
      app_two: { type: "http", url: "http://127.0.0.1:2222/mcp" },
    });
  });

  it("setMcpServers throwing on one query does NOT block the broadcast to others", async () => {
    const qBad = makeFakeQuery();
    const qGood = makeFakeQuery();
    qBad.setMcpServers.mockRejectedValueOnce(new Error("query closed"));
    claudeQueries.set("bad", qBad);
    claudeQueries.set("good", qGood);

    // Must not throw — the registrar swallows per-query errors.
    await expect(registerAppMcp("app_one", "http://127.0.0.1:1111/mcp")).resolves.toBeUndefined();

    expect(qBad.setMcpServers).toHaveBeenCalled();
    expect(qGood.setMcpServers).toHaveBeenCalled();
  });

  it("broadcast preserves the query's protected SDK servers in every setMcpServers call", async () => {
    // Regression: without this, the SDK's setMcpServers disconnects any SDK
    // server not in its input — which includes `deus`, the transport whose
    // tool handler is calling registerAppMcp in the first place. Mid-flight
    // `launch_app` invocations hang forever on a severed transport.
    const q1 = makeFakeQuery();
    const fakeDeusInstance = { __tag: "fake-deus" };
    const deusCfg = { type: "sdk" as const, name: "deus", instance: fakeDeusInstance } as any;
    claudeQueries.set("session-1", q1);
    attachQuery(q1, { deus: deusCfg });

    await registerAppMcp("deus_mobile_use", "http://127.0.0.1:1234/mcp");

    expect(q1.setMcpServers).toHaveBeenCalledWith({
      deus: deusCfg,
      deus_mobile_use: { type: "http", url: "http://127.0.0.1:1234/mcp" },
    });
  });

  it("attachQuery after a register catches the new query up to the current dynamic state", async () => {
    // Regression: a new chat starting AFTER an app was launched used to never
    // receive the AAP server until some later register/unregister event fired.
    // attachQuery now syncs the current map to the joining query.
    await registerAppMcp("app_one", "http://127.0.0.1:1111/mcp");

    const q1 = makeFakeQuery();
    const deusCfg = { type: "sdk" as const, name: "deus", instance: {} } as any;
    claudeQueries.set("session-1", q1);
    attachQuery(q1, { deus: deusCfg });

    // attachQuery's catch-up runs through the same update chain — wait for it.
    await registerAppMcp("__sync__", "http://0.0.0.0:0/").catch(() => {});
    await unregisterAppMcp("__sync__");

    expect(q1.setMcpServers).toHaveBeenCalledWith({
      deus: deusCfg,
      app_one: { type: "http", url: "http://127.0.0.1:1111/mcp" },
    });
  });

  it("attachQuery is a no-op (no setMcpServers) when nothing is registered yet", async () => {
    // The SDK was constructed with the deus server already in mcpServers, so
    // an empty registry means there's nothing to catch up — calling
    // setMcpServers redundantly would just thrash the SDK's transport.
    const q1 = makeFakeQuery();
    const deusCfg = { type: "sdk" as const, name: "deus", instance: {} } as any;
    claudeQueries.set("session-1", q1);
    attachQuery(q1, { deus: deusCfg });

    // Drain the chain just in case.
    await registerAppMcp("__sync__", "http://0.0.0.0:0/").catch(() => {});
    await unregisterAppMcp("__sync__");

    // Only the two __sync__ ops should have hit setMcpServers — never the
    // attachQuery path.
    expect(q1.setMcpServers).toHaveBeenCalledTimes(2);
  });

  it("serializes concurrent register/unregister in FIFO order", async () => {
    // Without serialization, broadcasts can finish out-of-order and the
    // SDK ends up with a stale snapshot. Each call enqueues onto a single
    // promise chain so Nth setMcpServers always reflects the Nth mutation.
    const q1 = makeFakeQuery();
    claudeQueries.set("session-1", q1);

    // Fire all three without awaiting in between — they MUST hit the SDK
    // in submission order (register A, register B, unregister A).
    const p1 = registerAppMcp("app_a", "http://127.0.0.1:1111/mcp");
    const p2 = registerAppMcp("app_b", "http://127.0.0.1:2222/mcp");
    const p3 = unregisterAppMcp("app_a");
    await Promise.all([p1, p2, p3]);

    expect(q1.setMcpServers).toHaveBeenNthCalledWith(1, {
      app_a: { type: "http", url: "http://127.0.0.1:1111/mcp" },
    });
    expect(q1.setMcpServers).toHaveBeenNthCalledWith(2, {
      app_a: { type: "http", url: "http://127.0.0.1:1111/mcp" },
      app_b: { type: "http", url: "http://127.0.0.1:2222/mcp" },
    });
    expect(q1.setMcpServers).toHaveBeenNthCalledWith(3, {
      app_b: { type: "http", url: "http://127.0.0.1:2222/mcp" },
    });
  });

  it("detachQuery removes the protection — later broadcasts no longer include the SDK server", async () => {
    const q1 = makeFakeQuery();
    const deusCfg = { type: "sdk" as const, name: "deus", instance: {} } as any;
    claudeQueries.set("session-1", q1);
    attachQuery(q1, { deus: deusCfg });

    await registerAppMcp("app_one", "http://127.0.0.1:1111/mcp");
    expect(q1.setMcpServers).toHaveBeenLastCalledWith({
      deus: deusCfg,
      app_one: { type: "http", url: "http://127.0.0.1:1111/mcp" },
    });

    // After detach, the query still lives in claudeQueries (simulating the
    // brief window between detachQuery and claudeQueries.delete), but its
    // protected servers are cleared — the next broadcast sends only the
    // dynamic map.
    detachQuery(q1);
    await registerAppMcp("app_two", "http://127.0.0.1:2222/mcp");
    expect(q1.setMcpServers).toHaveBeenLastCalledWith({
      app_one: { type: "http", url: "http://127.0.0.1:1111/mcp" },
      app_two: { type: "http", url: "http://127.0.0.1:2222/mcp" },
    });
  });
});
