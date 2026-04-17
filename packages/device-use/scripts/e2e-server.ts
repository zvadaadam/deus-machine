#!/usr/bin/env bun
/**
 * End-to-end test against a live device-use server + real iOS simulator.
 *
 * Exercises the full data flow that the AAP host relies on:
 *   spawn server → WS subscribe → REST tool invocations →
 *   tool-event broadcast → tool-log streaming (for build) →
 *   MCP HTTP transport → state persistence → graceful shutdown.
 *
 * Run: bun scripts/e2e-server.ts
 * Requires: Xcode installed, an iPhone simulator available.
 * Honors $E2E_SIM_UDID to target a specific UDID (used by CI).
 */

import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readdirSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

// -------------------------------------------------------------------------
// Setup

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 3199;
const BASE = `http://127.0.0.1:${PORT}`;
const STORAGE = mkdtempSync(path.join(tmpdir(), "device-use-e2e-"));
const TEST_APP_PROJECT = path.join(ROOT, "test-apps/swift/TestApp.xcodeproj");
const TEST_APP_SCHEME = "TestApp";
const TEST_APP_BUNDLE = "com.agentsimulator.TestApp";

type WsFrame = { type: string; [k: string]: unknown };

const wsFrames: WsFrame[] = [];
let serverProc: ChildProcess | undefined;
let ws: WebSocket | undefined;

// -------------------------------------------------------------------------
// Utilities

function log(label: string, msg?: string): void {
  const ts = new Date().toISOString().slice(11, 23);
  process.stdout.write(`[${ts}] ${label}${msg ? " " + msg : ""}\n`);
}

class TestError extends Error {}

function fail(step: string, reason: string): never {
  throw new TestError(`FAIL · ${step}: ${reason}`);
}

async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitForHealth(timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/health`);
      if (res.ok) return;
    } catch {
      // not up yet
    }
    await sleep(200);
  }
  fail("wait-for-health", `server did not respond to /health within ${timeoutMs}ms`);
}

async function invoke<T = unknown>(
  tool: string,
  params: Record<string, unknown> = {},
  opts: { timeoutMs?: number } = {}
): Promise<T> {
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${BASE}/api/tools/${tool}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(params),
      signal: controller.signal,
    });
    const json = (await res.json()) as {
      success: boolean;
      result?: T;
      error?: string;
    };
    if (!json.success) fail(tool, json.error ?? `http ${res.status}`);
    return json.result as T;
  } finally {
    clearTimeout(timer);
  }
}

async function mcp(method: string, params: unknown = {}): Promise<unknown> {
  const body = { jsonrpc: "2.0", id: Math.random().toString(36).slice(2), method, params };
  const res = await fetch(`${BASE}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) fail(`mcp:${method}`, `http ${res.status}`);
  const raw = await res.text();
  // Server replies as SSE: lines of `data: {...}`
  const dataLine = raw
    .split("\n")
    .find((l) => l.startsWith("data: "))
    ?.slice(6);
  if (!dataLine) fail(`mcp:${method}`, `no data line in SSE response: ${raw.slice(0, 200)}`);
  const msg = JSON.parse(dataLine) as { result?: unknown; error?: { message: string } };
  if (msg.error) fail(`mcp:${method}`, msg.error.message);
  return msg.result;
}

function openWs(): Promise<void> {
  return new Promise((resolve, reject) => {
    ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
    const timer = setTimeout(() => reject(new Error("ws open timeout")), 5000);
    ws.addEventListener("open", () => {
      clearTimeout(timer);
      resolve();
    });
    ws.addEventListener("message", (ev) => {
      const raw = typeof ev.data === "string" ? ev.data : ev.data.toString();
      try {
        const frame = JSON.parse(raw) as WsFrame;
        wsFrames.push(frame);
      } catch {
        // ignore malformed
      }
    });
    ws.addEventListener("error", (ev) => {
      clearTimeout(timer);
      reject(new Error(`ws error: ${String(ev)}`));
    });
  });
}

async function startServer(): Promise<void> {
  log("server-start", `PORT=${PORT} STORAGE=${STORAGE}`);
  serverProc = spawn(process.argv0, [path.join(ROOT, "src/server/index.ts")], {
    env: {
      ...process.env,
      PORT: String(PORT),
      HOST: "127.0.0.1",
      DEUS_STORAGE: STORAGE,
      NODE_ENV: "development",
    },
    stdio: ["ignore", "pipe", "pipe"],
    cwd: ROOT,
  });
  serverProc.stdout?.on("data", (buf) => process.stdout.write(`[server] ${buf}`));
  serverProc.stderr?.on("data", (buf) => process.stderr.write(`[server-err] ${buf}`));
  await waitForHealth();
}

async function stopServer(): Promise<void> {
  if (ws) {
    ws.close();
    ws = undefined;
  }
  if (!serverProc) return;
  return new Promise<void>((resolve) => {
    serverProc!.once("exit", () => resolve());
    serverProc!.kill("SIGTERM");
    setTimeout(() => {
      if (!serverProc!.killed) serverProc!.kill("SIGKILL");
    }, 3000);
  });
}

function countEvents(tool: string, status: string): number {
  return wsFrames.filter((f) => f.type === "tool-event" && f.tool === tool && f.status === status)
    .length;
}

// -------------------------------------------------------------------------
// Test steps

async function run(): Promise<void> {
  log("==============================================");
  log("device-use v2 end-to-end test");
  log("==============================================");
  log("test-app", TEST_APP_PROJECT);
  log("storage", STORAGE);
  log("");

  await startServer();
  await openWs();
  log("ws-open", "subscribed to /ws");

  // ---- Step 1: health + tool registry -----------------------------------
  log("\nSTEP 1 · tool registry");
  const toolsRes = await fetch(`${BASE}/api/tools`).then((r) => r.json());
  const toolCount = (toolsRes as { tools: unknown[] }).tools.length;
  log("  /api/tools", `${toolCount} tools registered`);
  if (toolCount !== 24) fail("tool-count", `expected 24, got ${toolCount}`);

  // ---- Step 2: MCP HTTP transport ---------------------------------------
  log("\nSTEP 2 · MCP HTTP — initialize + tools/list + tools/call");
  const initRes = (await mcp("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "e2e", version: "1" },
  })) as { serverInfo: { name: string; version: string } };
  log("  mcp initialize", `→ ${initRes.serverInfo.name}@${initRes.serverInfo.version}`);
  const listRes = (await mcp("tools/list")) as { tools: unknown[] };
  log("  mcp tools/list", `→ ${listRes.tools.length} tools`);
  if (listRes.tools.length !== 24)
    fail("mcp-tool-count", `expected 24, got ${listRes.tools.length}`);
  const callRes = (await mcp("tools/call", { name: "get_state", arguments: {} })) as {
    structuredContent: { version: number };
  };
  log("  mcp tools/call get_state", `→ version=${callRes.structuredContent.version}`);

  // ---- Step 3: list + pin simulator -------------------------------------
  log("\nSTEP 3 · list + pin simulator");
  const listDev = await invoke<{ devices: Array<{ udid: string; name: string; state: string }> }>(
    "list_devices"
  );
  // Honor $E2E_SIM_UDID when set (CI); else prefer a booted iPhone; else
  // any iPhone. Excludes leftover test-pool names (e.g. "radon-…").
  const envUdid = process.env.E2E_SIM_UDID;
  const iphone =
    (envUdid && listDev.devices.find((d) => d.udid === envUdid)) ||
    listDev.devices.find(
      (d) => d.name.startsWith("iPhone") && d.state === "Booted" && !d.name.includes("radon")
    ) ||
    listDev.devices.find((d) => d.name.startsWith("iPhone") && !d.name.includes("radon"));
  if (!iphone) {
    fail(
      "pick-sim",
      envUdid
        ? `E2E_SIM_UDID ${envUdid} not found among ${listDev.devices.length} devices`
        : `no iPhone found among ${listDev.devices.length} devices`
    );
  }
  log("  pick", `${iphone.name} ${iphone.udid} (state: ${iphone.state})`);
  await invoke("set_active_simulator", { udid: iphone.udid });
  log("  set_active_simulator", "ok");

  // ---- Step 4: boot sim -------------------------------------------------
  log("\nSTEP 4 · boot simulator");
  if (iphone.state !== "Booted") {
    await invoke("boot", { udid: iphone.udid }, { timeoutMs: 60_000 });
    log("  boot", "ok (was Shutdown)");
  } else {
    log("  boot", "already booted");
  }

  // ---- Step 5: set active project ---------------------------------------
  log("\nSTEP 5 · set active project + introspect");
  await invoke("set_active_project", {
    path: TEST_APP_PROJECT,
    scheme: TEST_APP_SCHEME,
    configuration: "Debug",
  });
  const info = await invoke<{ schemes: string[]; targets: string[] }>("get_project_info", {
    path: TEST_APP_PROJECT,
  });
  log("  schemes", info.schemes.join(", "));
  log("  targets", info.targets.join(", "));
  if (!info.schemes.includes(TEST_APP_SCHEME))
    fail("schemes", `${TEST_APP_SCHEME} not in ${info.schemes.join(",")}`);

  // ---- Step 6: run composite (build + install + launch) -----------------
  log("\nSTEP 6 · run composite (xcodebuild → install → launch) ...");
  const t0 = Date.now();
  const runRes = await invoke<{ bundleId: string; pid: number; appPath: string }>(
    "run",
    {},
    { timeoutMs: 300_000 } // 5 min cap for first-time build
  );
  log("  build+install+launch", `${Math.round((Date.now() - t0) / 1000)}s`);
  log("  bundleId", runRes.bundleId);
  log("  pid", String(runRes.pid));
  if (runRes.bundleId !== TEST_APP_BUNDLE)
    fail("bundle-id", `expected ${TEST_APP_BUNDLE}, got ${runRes.bundleId}`);

  // ---- Step 7: wait for UI, snapshot ------------------------------------
  await sleep(1500); // let the app draw
  log("\nSTEP 7 · snapshot");
  const snap = await invoke<{
    counts: { total: number; interactive: number };
    refs: Array<{ ref: string; label?: string; type?: string }>;
  }>("snapshot", { format: "compact", interactiveOnly: true });
  log("  counts", JSON.stringify(snap.counts));
  log("  refs", String(snap.refs.length));
  if (snap.refs.length === 0) fail("snapshot-refs", "no interactive refs");

  // ---- Step 8: tap something --------------------------------------------
  const firstRef = snap.refs[0];
  if (!firstRef) fail("first-ref", "no first ref");
  log("\nSTEP 8 · tap", `${firstRef.ref} (${firstRef.label ?? "?"} · ${firstRef.type ?? "?"})`);
  await invoke("tap", { ref: firstRef.ref, udid: iphone.udid });

  // Give WS a tick to flush.
  await sleep(300);

  // ---- Step 9: verify state persisted -----------------------------------
  log("\nSTEP 9 · verify state.json written");
  const stateFiles = readdirSync(STORAGE);
  if (!stateFiles.includes("state.json"))
    fail("state-file", `no state.json in ${STORAGE} (found: ${stateFiles.join(",")})`);
  const state = (await invoke("get_state")) as {
    simulator?: { udid: string };
    project?: { path: string };
  };
  if (state.simulator?.udid !== iphone.udid)
    fail("state-udid", `expected ${iphone.udid}, got ${state.simulator?.udid}`);
  if (state.project?.path !== TEST_APP_PROJECT)
    fail("state-project", `expected ${TEST_APP_PROJECT}, got ${state.project?.path}`);
  log("  state.simulator.udid", state.simulator?.udid ?? "null");
  log("  state.project.path", state.project?.path ?? "null");

  // ---- Step 10: WS event assertions -------------------------------------
  log("\nSTEP 10 · WS event flow");
  const toolEvents = wsFrames.filter((f) => f.type === "tool-event");
  const toolLogs = wsFrames.filter((f) => f.type === "tool-log");
  log("  tool-event frames", String(toolEvents.length));
  log("  tool-log frames", String(toolLogs.length));

  for (const tool of ["set_active_simulator", "set_active_project", "run", "snapshot", "tap"]) {
    const started = countEvents(tool, "started");
    const completed = countEvents(tool, "completed");
    const failed = countEvents(tool, "failed");
    log(`  ${tool}`, `started=${started} completed=${completed} failed=${failed}`);
    if (started < 1) fail(`ws:${tool}:started`, `missing started event`);
    if (completed < 1) fail(`ws:${tool}:completed`, `missing completed event`);
    if (failed > 0) fail(`ws:${tool}:failed`, `saw ${failed} failure(s)`);
  }

  if (toolLogs.length === 0) fail("ws:tool-log", "expected at least one tool-log frame from build");

  // ---- Cleanup ----------------------------------------------------------
  log("\nSTEP 11 · cleanup");
  await invoke("terminate_app", { bundleId: TEST_APP_BUNDLE, udid: iphone.udid });
  log("  terminate_app", "ok");

  log("\n==============================================");
  log(
    "PASS · device-use v2 end-to-end",
    `${toolEvents.length} tool events + ${toolLogs.length} tool-log frames`
  );
  log("==============================================");
}

// -------------------------------------------------------------------------

let exitCode = 0;
try {
  await run();
} catch (err) {
  exitCode = 1;
  if (err instanceof TestError) {
    console.error(`\n❌ ${err.message}`);
  } else {
    console.error("\n❌ UNCAUGHT", err);
  }
  // Dump last 20 WS frames for debugging.
  console.error("\nLast WS frames:");
  for (const f of wsFrames.slice(-20)) {
    console.error(`  ${JSON.stringify(f).slice(0, 220)}`);
  }
} finally {
  await stopServer();
}
process.exit(exitCode);
