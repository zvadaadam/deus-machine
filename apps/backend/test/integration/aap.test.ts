// Integration test for apps.service — real end-to-end.
//
// No DB to mock (state lives in a module Map since the in-memory refactor).
// We vi.mock only `../query-engine` + `../ws.service` so that importing
// apps.service doesn't transitively load better-sqlite3 (whose Electron-Node
// ABI mismatch blocks vitest-under-bun from opening the real DB).
//
// Each test spawns a tiny Bun HTTP server as the "fake AAP app", lets
// apps.service drive the full launch → probe → ready → stop cycle against
// it, then asserts on the Map's observable state via getRunningApps.

import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// ---- mocks (hoisted above imports) ----

const invalidate = vi.fn();
const broadcast = vi.fn();

// Mock the agent facade so the mcp-bridge can fire aap/register-mcp and
// aap/unregister-mcp without a real agent-server. We assert against
// sendRequestToAgent to verify the bridge wires state transitions correctly.
const sendRequestToAgent = vi.fn().mockResolvedValue({ added: ["test_fake_app"], errors: {} });
const isAgentConnected = vi.fn().mockReturnValue(true);

vi.mock("../../src/services/query-engine", () => ({
  invalidate: (...args: unknown[]) => invalidate(...args),
}));

vi.mock("../../src/services/ws.service", () => ({
  broadcast: (...args: unknown[]) => broadcast(...args),
}));

vi.mock("../../src/services/agent", () => ({
  sendRequestToAgent: (...args: unknown[]) => sendRequestToAgent(...args),
  isConnected: () => isAgentConnected(),
}));

// Build a fake AAP app on disk: a tiny Bun server that serves /health.
// Register it as the only installed app by replacing the manifest list.
const fakeAppDir = mkdtempSync(join(tmpdir(), "aap-integration-"));
const fakeAppServer = join(fakeAppDir, "server.js");
writeFileSync(
  fakeAppServer,
  `
const port = Number(process.env.DEUS_PORT);
Bun.serve({
  port,
  fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/health") return new Response("ok");
    if (url.pathname === "/mcp") return new Response(JSON.stringify({ ok: true }));
    return new Response("root");
  },
});
console.log("fake app on " + port);
`,
  "utf8"
);

const fakeManifest = {
  $schema: "https://agenticapps.dev/schema/v1.json",
  protocolVersion: "1",
  id: "test.fake-app",
  name: "Fake App",
  description: "Integration-test app that serves /health.",
  version: "0.0.1",
  launch: {
    command: "bun",
    args: ["run", fakeAppServer],
    env: {},
    ready: { type: "http", path: "/health", timeoutMs: 10_000 },
  },
  ui: { url: "http://127.0.0.1:{port}/" },
  agent: { tools: { type: "mcp-http", url: "http://127.0.0.1:{port}/mcp" } },
  storage: {},
  lifecycle: { scope: "workspace", stopTimeoutMs: 2_000 },
  requires: [],
};
const fakeManifestPath = join(fakeAppDir, "agentic-app.json");
writeFileSync(fakeManifestPath, JSON.stringify(fakeManifest, null, 2), "utf8");

// Second manifest for the ENOENT test — a command that doesn't exist on PATH.
const bogusManifest = {
  ...fakeManifest,
  id: "test.bogus-command",
  launch: { ...fakeManifest.launch, command: "this-binary-does-not-exist-xyz123" },
};
const bogusManifestPath = join(fakeAppDir, "bogus-manifest.json");
writeFileSync(bogusManifestPath, JSON.stringify(bogusManifest, null, 2), "utf8");

// Third manifest for the cli-requires test — declares a missing CLI with an
// install hint. Validated BEFORE spawn so the hint reaches the user.
const needsCliManifest = {
  ...fakeManifest,
  id: "test.needs-missing-cli",
  requires: [
    {
      type: "cli",
      name: "this-is-not-a-real-cli-xyz",
      install: "Run `brew install fake-tool`.",
    },
  ],
};
const needsCliManifestPath = join(fakeAppDir, "needs-cli-manifest.json");
writeFileSync(needsCliManifestPath, JSON.stringify(needsCliManifest, null, 2), "utf8");

vi.mock("../../src/config/installed-apps", () => ({
  INSTALLED_APP_MANIFESTS: [fakeManifestPath, bogusManifestPath, needsCliManifestPath],
}));

// Point the PID journal at a per-run tmp file so tests don't stomp on
// the user's real ~/Library/Application Support/com.deus.app/aap-pids.txt.
const journalPath = join(fakeAppDir, "aap-pids.txt");
process.env.DEUS_AAP_PID_JOURNAL = journalPath;

// Now import the service under test.
const {
  getRunningApps,
  launchApp,
  listApps,
  stopApp,
  stopAppsForWorkspace,
  stopAllApps,
  sweepOrphanApps,
} = await import("../../src/services/aap");
const { __clearRegistryCacheForTests } = await import("../../src/services/aap/registry");

// ---- helpers ----

async function waitForCondition<T>(
  fn: () => T,
  predicate: (v: T) => boolean,
  timeoutMs = 2_000,
  intervalMs = 25
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const v = fn();
    if (predicate(v)) return v;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error("waitForCondition: timed out");
}

// ---- tests ----

describe("aap/apps.service (integration, in-memory)", () => {
  beforeAll(() => {
    __clearRegistryCacheForTests();
  });

  beforeEach(() => {
    invalidate.mockClear();
    broadcast.mockClear();
    sendRequestToAgent.mockClear();
    isAgentConnected.mockReturnValue(true);
  });

  afterAll(() => {
    rmSync(fakeAppDir, { recursive: true, force: true });
  });

  it("listApps returns the installed apps", () => {
    const apps = listApps();
    expect(apps.map((a) => a.id).sort()).toEqual([
      "test.bogus-command",
      "test.fake-app",
      "test.needs-missing-cli",
    ]);
  });

  it("launches, becomes ready, and is reachable on /health", async () => {
    const result = await launchApp({
      appId: "test.fake-app",
      workspaceId: "ws-ready",
      workspacePath: fakeAppDir,
      userDataDir: fakeAppDir,
    });

    expect(result.runningAppId).toBeTruthy();
    expect(result.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);

    const rows = getRunningApps("ws-ready");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("ready");

    const res = await fetch(`http://127.0.0.1:${rows[0]!.port}/health`);
    expect(res.ok).toBe(true);
    expect(await res.text()).toBe("ok");

    // invalidate fired at least twice (starting, ready)
    const invocations = invalidate.mock.calls.length;
    expect(invocations).toBeGreaterThanOrEqual(2);

    // apps:launched q:event broadcast, once, with the right shape
    const launchEvents = broadcast.mock.calls
      .map((c) => JSON.parse(c[0] as string))
      .filter((p) => p.type === "q:event" && p.event === "apps:launched");
    expect(launchEvents).toHaveLength(1);
    expect(launchEvents[0].data).toEqual({
      appId: "test.fake-app",
      workspaceId: "ws-ready",
      runningAppId: result.runningAppId,
      url: result.url,
    });

    await stopApp(result.runningAppId);
  });

  // --------------------------------------------------------------------------
  // MCP-bridge wiring — verifies that the Phase 3 bridge fires register on
  // ready and unregister on exit. The real broadcast to the agent-server is
  // stubbed by the `../../src/services/agent` mock at the top of this file.
  // --------------------------------------------------------------------------

  it("mcp-bridge: fires aap/register-mcp on ready with the normalized server name + mcpUrl", async () => {
    const result = await launchApp({
      appId: "test.fake-app",
      workspaceId: "ws-bridge-register",
      workspacePath: fakeAppDir,
      userDataDir: fakeAppDir,
    });

    // Register fires after "ready". Expect exactly one register call, with
    // serverName = "test_fake_app" (dashes+dots → underscores) and url =
    // manifest's agent.tools.url substituted.
    const registerCalls = sendRequestToAgent.mock.calls.filter((c) => c[0] === "aap/register-mcp");
    expect(registerCalls).toHaveLength(1);
    const [, params] = registerCalls[0] as [string, { serverName: string; url: string }];
    expect(params.serverName).toBe("test_fake_app");
    expect(params.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);

    await stopApp(result.runningAppId);
  });

  it("mcp-bridge: fires aap/unregister-mcp on exit (fire-and-forget, awaited via waitForCondition)", async () => {
    const result = await launchApp({
      appId: "test.fake-app",
      workspaceId: "ws-bridge-unregister",
      workspacePath: fakeAppDir,
      userDataDir: fakeAppDir,
    });
    sendRequestToAgent.mockClear();

    await stopApp(result.runningAppId);

    // handleChildExit fires async via child.on('exit') — wait for the entry
    // to disappear, which proves onExit ran (and thus the bridge was fired).
    await waitForCondition(
      () => getRunningApps("ws-bridge-unregister"),
      (rows) => rows.length === 0
    );

    // unregister is fire-and-forget (void-awaited), so it may arrive on the
    // microtask queue right after the entry is removed. Give it a brief
    // window, then assert.
    await waitForCondition(
      () => sendRequestToAgent.mock.calls.filter((c) => c[0] === "aap/unregister-mcp"),
      (calls) => calls.length >= 1
    );
    const unregister = sendRequestToAgent.mock.calls.find((c) => c[0] === "aap/unregister-mcp");
    expect(unregister).toBeDefined();
    expect(unregister![1]).toEqual({ serverName: "test_fake_app" });
  });

  it("mcp-bridge: launch succeeds even when agent-server is NOT connected", async () => {
    // Reproduces the "agent-server unreachable at launch time" case. The
    // bridge should log a warning and return normally — the app is already
    // running; we don't rollback just because MCP registration couldn't
    // reach the agent.
    isAgentConnected.mockReturnValue(false);

    const result = await launchApp({
      appId: "test.fake-app",
      workspaceId: "ws-bridge-disconnected",
      workspacePath: fakeAppDir,
      userDataDir: fakeAppDir,
    });

    expect(result.runningAppId).toBeTruthy();
    expect(getRunningApps("ws-bridge-disconnected")).toHaveLength(1);
    // sendRequestToAgent never called — the bridge early-returned on
    // !isConnected() before attempting the RPC.
    expect(sendRequestToAgent).not.toHaveBeenCalled();

    await stopApp(result.runningAppId);
  });

  it("mcp-bridge: launch returns fast even if aap/register-mcp is slow (fire-and-forget)", async () => {
    // Pins the fire-and-forget contract in apps.service.doLaunch. If
    // someone re-introduces `await registerMcpForRunningApp(...)` here,
    // this test fails because launchApp waits for the slow mock.
    //
    // Why it matters end-to-end: when the agent initiates the launch via
    // its `mcp__deus__launch_app` tool, this very call chain is resolving
    // the tool's pending result. Awaiting register → CLI cross-process
    // control request → CLI waits for tool_result → tool_result waits for
    // register → deadlock. Fire-and-forget breaks the cycle.
    sendRequestToAgent.mockClear();
    let resolveRegister!: () => void;
    const registerGate = new Promise<void>((r) => {
      resolveRegister = r;
    });
    sendRequestToAgent.mockImplementation(async (method: string) => {
      if (method === "aap/register-mcp") {
        await registerGate;
        return { added: ["test_fake_app"], errors: {} };
      }
      return { removed: ["test_fake_app"] };
    });

    const start = Date.now();
    const result = await launchApp({
      appId: "test.fake-app",
      workspaceId: "ws-bridge-slow-register",
      workspacePath: fakeAppDir,
      userDataDir: fakeAppDir,
    });
    const elapsed = Date.now() - start;

    // 1s ceiling: spawn + 200ms probe interval cap the happy path at ~600ms
    // locally. A regression that re-adds await would block on registerGate
    // indefinitely — the test fails at its outer vitest timeout, not here,
    // but this bound gives a sharper diagnosis on the common case.
    expect(elapsed).toBeLessThan(1_000);
    expect(result.runningAppId).toBeTruthy();

    // Register was SYNCHRONOUSLY invoked (before returning) — fire-and-
    // forget means the call is made, just not awaited.
    const registerCalls = sendRequestToAgent.mock.calls.filter((c) => c[0] === "aap/register-mcp");
    expect(registerCalls).toHaveLength(1);

    resolveRegister();
    await stopApp(result.runningAppId);
  });

  it("dedupes concurrent launches: two parallel calls with same key get one spawn", async () => {
    // The TOCTOU race: both callers pass the "no existing entry" check
    // before either has inserted its own. The in-flight promise map must
    // merge them to a single spawn.
    const [a, b] = await Promise.all([
      launchApp({
        appId: "test.fake-app",
        workspaceId: "ws-race",
        workspacePath: fakeAppDir,
        userDataDir: fakeAppDir,
      }),
      launchApp({
        appId: "test.fake-app",
        workspaceId: "ws-race",
        workspacePath: fakeAppDir,
        userDataDir: fakeAppDir,
      }),
    ]);

    expect(a.runningAppId).toBe(b.runningAppId);
    expect(a.url).toBe(b.url);
    expect(getRunningApps("ws-race")).toHaveLength(1);

    await stopApp(a.runningAppId);
  });

  it("dedupes: a second launch for same (appId, workspaceId) returns the existing url", async () => {
    const first = await launchApp({
      appId: "test.fake-app",
      workspaceId: "ws-dedupe",
      workspacePath: fakeAppDir,
      userDataDir: fakeAppDir,
    });
    const second = await launchApp({
      appId: "test.fake-app",
      workspaceId: "ws-dedupe",
      workspacePath: fakeAppDir,
      userDataDir: fakeAppDir,
    });

    expect(second.runningAppId).toBe(first.runningAppId);
    expect(second.url).toBe(first.url);
    expect(getRunningApps("ws-dedupe")).toHaveLength(1);

    await stopApp(first.runningAppId);
  });

  it("different workspaces each get their own instance", async () => {
    const a = await launchApp({
      appId: "test.fake-app",
      workspaceId: "ws-alpha",
      workspacePath: fakeAppDir,
      userDataDir: fakeAppDir,
    });
    const b = await launchApp({
      appId: "test.fake-app",
      workspaceId: "ws-beta",
      workspacePath: fakeAppDir,
      userDataDir: fakeAppDir,
    });

    expect(a.runningAppId).not.toBe(b.runningAppId);
    expect(a.url).not.toBe(b.url);
    expect(getRunningApps("ws-alpha")).toHaveLength(1);
    expect(getRunningApps("ws-beta")).toHaveLength(1);

    await Promise.all([stopApp(a.runningAppId), stopApp(b.runningAppId)]);
  });

  it("stopApp removes the entry and kills the child process", async () => {
    const result = await launchApp({
      appId: "test.fake-app",
      workspaceId: "ws-stop",
      workspacePath: fakeAppDir,
      userDataDir: fakeAppDir,
    });
    const pid = getRunningApps("ws-stop")[0]!.pid;

    await stopApp(result.runningAppId);

    // onExit fires async after stopChild; wait for the entry to disappear.
    await waitForCondition(
      () => getRunningApps("ws-stop"),
      (rows) => rows.length === 0
    );

    // Process really dead.
    expect(() => process.kill(pid, 0)).toThrow();
  });

  it("stopAppsForWorkspace stops every running app in that workspace", async () => {
    await launchApp({
      appId: "test.fake-app",
      workspaceId: "ws-sweep",
      workspacePath: fakeAppDir,
      userDataDir: fakeAppDir,
    });
    expect(getRunningApps("ws-sweep")).toHaveLength(1);

    await stopAppsForWorkspace("ws-sweep");
    await waitForCondition(
      () => getRunningApps("ws-sweep"),
      (rows) => rows.length === 0
    );
  });

  it("getRunningApps() with no arg returns every workspace's apps", async () => {
    const a = await launchApp({
      appId: "test.fake-app",
      workspaceId: "ws-all-1",
      workspacePath: fakeAppDir,
      userDataDir: fakeAppDir,
    });
    const b = await launchApp({
      appId: "test.fake-app",
      workspaceId: "ws-all-2",
      workspacePath: fakeAppDir,
      userDataDir: fakeAppDir,
    });

    const all = getRunningApps();
    const forTest = all.filter((r) => r.workspaceId === "ws-all-1" || r.workspaceId === "ws-all-2");
    expect(forTest).toHaveLength(2);

    await Promise.all([stopApp(a.runningAppId), stopApp(b.runningAppId)]);
  });

  describe("restart resilience", () => {
    it("launchApp records the pid in the journal file", async () => {
      const result = await launchApp({
        appId: "test.fake-app",
        workspaceId: "ws-journal",
        workspacePath: fakeAppDir,
        userDataDir: fakeAppDir,
      });
      const pid = getRunningApps("ws-journal")[0]!.pid;

      const journalContents = readFileSync(journalPath, "utf8");
      const pidsInJournal = journalContents
        .split("\n")
        .map((s) => parseInt(s.trim(), 10))
        .filter(Number.isFinite);
      expect(pidsInJournal).toContain(pid);

      await stopApp(result.runningAppId);
    });

    it("sweepOrphanApps kills a stale pid left over from a previous run", async () => {
      // Simulate the "ungraceful restart" case: spawn a long-lived child
      // OUTSIDE the app.service flow (as if a previous backend had spawned it
      // and then died without cleanup), write its pid to the journal, then
      // call sweepOrphanApps.
      const orphan = spawn("sh", ["-c", "sleep 30"], {
        stdio: "ignore",
        detached: false,
      });
      expect(orphan.pid).toBeGreaterThan(0);
      // Give the child a beat to actually be running.
      await new Promise((r) => setTimeout(r, 50));
      expect(() => process.kill(orphan.pid!, 0)).not.toThrow();

      // Write the pid to the journal (simulating persistence from a prior boot).
      writeFileSync(journalPath, `${orphan.pid}\n`, "utf8");

      sweepOrphanApps();

      // Give SIGKILL a beat to take effect.
      await new Promise((r) => setTimeout(r, 100));

      // Orphan must be dead now.
      expect(() => process.kill(orphan.pid!, 0)).toThrow();

      // Journal must be cleared.
      expect(readFileSync(journalPath, "utf8")).toBe("");
    });

    it("sweepOrphanApps is a safe no-op when the journal has only dead pids", async () => {
      // PID unlikely to be alive (large random). Writing a plausibly-dead
      // pid to the journal.
      writeFileSync(journalPath, "2147483646\n", "utf8");
      sweepOrphanApps();
      // Journal cleared even though nothing was killed.
      expect(readFileSync(journalPath, "utf8")).toBe("");
    });

    it("sweepOrphanApps is a safe no-op when the journal is missing", () => {
      rmSync(journalPath, { force: true });
      expect(() => sweepOrphanApps()).not.toThrow();
    });

    it("fails with the manifest's install hint when a `cli` requirement is missing", async () => {
      // The manifest declares `requires: [{ type: "cli", name: "...not real...",
      // install: "Run brew install ..." }]`. validateRequires must surface the
      // install hint — not the kernel's generic "spawn ENOENT".
      await expect(
        launchApp({
          appId: "test.needs-missing-cli",
          workspaceId: "ws-cli",
          workspacePath: fakeAppDir,
          userDataDir: fakeAppDir,
        })
      ).rejects.toThrow(/requires CLI.*brew install fake-tool/);
      // No child was spawned, no Map entry created.
      expect(getRunningApps("ws-cli")).toEqual([]);
    });

    it("surfaces a clear spawn error (ENOENT) instead of crashing the backend", async () => {
      // `test.bogus-command` manifest points at a non-existent binary.
      // Node emits "error" asynchronously on the ChildProcess; without our
      // onError handler this would crash the backend (unhandled EE error).
      await expect(
        launchApp({
          appId: "test.bogus-command",
          workspaceId: "ws-bogus",
          workspacePath: fakeAppDir,
          userDataDir: fakeAppDir,
        })
      ).rejects.toThrow(/failed to spawn.*ENOENT/);
      // Map must be empty — failed launches must not leak entries.
      expect(getRunningApps("ws-bogus")).toEqual([]);
    });

    it("stopAllApps SIGTERMs every live entry", async () => {
      const a = await launchApp({
        appId: "test.fake-app",
        workspaceId: "ws-stopall-1",
        workspacePath: fakeAppDir,
        userDataDir: fakeAppDir,
      });
      const b = await launchApp({
        appId: "test.fake-app",
        workspaceId: "ws-stopall-2",
        workspacePath: fakeAppDir,
        userDataDir: fakeAppDir,
      });
      const pidA = getRunningApps("ws-stopall-1")[0]!.pid;
      const pidB = getRunningApps("ws-stopall-2")[0]!.pid;

      stopAllApps();

      // Give SIGTERM + onExit a beat.
      await new Promise((r) => setTimeout(r, 200));

      // Both entries removed via onExit.
      expect(getRunningApps("ws-stopall-1")).toEqual([]);
      expect(getRunningApps("ws-stopall-2")).toEqual([]);

      // Both children dead.
      expect(() => process.kill(pidA, 0)).toThrow();
      expect(() => process.kill(pidB, 0)).toThrow();

      // Prevent stopApp cleanup in afterAll.
      void a;
      void b;
    });
  });
});
