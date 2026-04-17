// backend/src/services/simulator-context.ts
//
// Simulator service — owns ALL simulator operations. Both the agent-server
// (via RPC) and the Simulator Panel (via q:command) talk to this service.
//
// Follows the PTY pattern: q:command for actions, q:event for push updates.
// Works identically in desktop (WS to localhost) and relay/web mode.
//
// TODO(relay-streaming): Add MJPEG frame proxy for web/relay mode.

import { execFile, spawn } from "child_process";
import { promisify } from "util";
import { existsSync } from "fs";
import { readdir } from "fs/promises";
import { createServer } from "net";
import { tmpdir } from "os";
import { dirname, join } from "path";
import WebSocket from "ws";
import { getDatabase } from "../lib/database";
import { getSessionRaw } from "../db/queries";
import { broadcast } from "./ws.service";

const execFileAsync = promisify(execFile);

const SIM_ENV: Record<string, string> = {
  ...(process.env as Record<string, string>),
  DEVELOPER_DIR: process.env["DEVELOPER_DIR"] ?? "/Applications/Xcode.app/Contents/Developer",
};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SimulatorContext {
  udid: string;
  port?: number;
  streaming: boolean;
}

export interface SimulatorInfo {
  name: string;
  udid: string;
  state: string;
  runtime: string;
  device_type: string;
  is_available: boolean;
}

interface SimulatorSession {
  workspaceId: string;
  udid: string;
  deviceName: string;
  runtime: string;
  streaming: boolean;
  streamPid: number | null;
  streamPort: number | null;
  hidWs: WebSocket | null;
  hidConnected: boolean;
  appBundleId: string | null;
  appName: string | null;
  bootedAt: number;
  streamStartedAt: number | null;
}

// ---------------------------------------------------------------------------
// In-memory sessions: workspaceId → SimulatorSession
// ---------------------------------------------------------------------------

const sessions = new Map<string, SimulatorSession>();

// ---------------------------------------------------------------------------
// Event pushing (q:event broadcast to all WS clients)
// ---------------------------------------------------------------------------

function pushEvent(event: string, data: unknown): void {
  broadcast(JSON.stringify({ type: "q:event", event, data }));
}

// ---------------------------------------------------------------------------
// simbridge binary resolution (from device-use workspace package)
// ---------------------------------------------------------------------------

let cachedBridgePath: string | null | undefined;

/**
 * Walk up from startDir looking for a relative file. Returns the first match
 * or null. Used to find workspace files regardless of cwd.
 */
function findUpwards(startDir: string, rel: string): string | null {
  let dir = startDir;
  while (true) {
    const candidate = join(dir, rel);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function findSimBridgePath(): string | null {
  if (cachedBridgePath !== undefined) return cachedBridgePath;

  // 1. Explicit override (set by the Electron main process when packaged,
  //    or by developers for ad-hoc testing).
  const envOverride = process.env["DEVICE_USE_SIMBRIDGE"];
  if (envOverride && existsSync(envOverride)) {
    cachedBridgePath = envOverride;
    return envOverride;
  }

  // 2. Packaged Electron app — extraResources copies simbridge here.
  //    resourcesPath is Electron-only, not in NodeJS.Process types.
  const resourcesPath = (process as { resourcesPath?: string }).resourcesPath;
  if (resourcesPath) {
    const packaged = join(resourcesPath, "simulator", "simbridge");
    if (existsSync(packaged)) {
      cachedBridgePath = packaged;
      return packaged;
    }
  }

  // 3. Dev mode — walk up from cwd to find the workspace copy. Backend runs
  //    with cwd=apps/backend, so a plain join(process.cwd(), ...) misses it.
  const devCandidates = [
    "packages/device-use/bin/simbridge",
    "node_modules/device-use/bin/simbridge",
    "packages/device-use/native/.build/release/simbridge",
    "packages/device-use/native/.build/arm64-apple-macosx/release/simbridge",
  ];

  for (const rel of devCandidates) {
    const found = findUpwards(process.cwd(), rel);
    if (found) {
      cachedBridgePath = found;
      return found;
    }
  }

  cachedBridgePath = null;
  return null;
}

// ---------------------------------------------------------------------------
// Port reservation
// ---------------------------------------------------------------------------

async function reservePort(preferred: number): Promise<number> {
  const canBind = await new Promise<boolean>((resolve) => {
    const server = createServer();
    server.unref();
    server.once("error", () => resolve(false));
    server.listen(preferred, () => {
      server.close(() => resolve(true));
    });
  });

  if (canBind) return preferred;

  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      server.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}

// ---------------------------------------------------------------------------
// Stream lifecycle — spawn simbridge for MJPEG + HID
// ---------------------------------------------------------------------------

/** Active stream processes keyed by UDID (multiple sims can stream simultaneously). */
const activeStreams = new Map<string, { pid: number; port: number; udid: string }>();

async function spawnStream(
  udid: string,
  port: number
): Promise<{ port: number; url: string; pid: number }> {
  // Check if this UDID already has a stream
  const existing = activeStreams.get(udid);
  if (existing) {
    try {
      process.kill(existing.pid, 0);
      return { port: existing.port, url: `http://localhost:${existing.port}`, pid: existing.pid };
    } catch {
      activeStreams.delete(udid);
    }
  }

  const helperPath = findSimBridgePath();
  if (!helperPath) {
    throw new Error("simbridge binary not found. Run `bun install` in repo root to build it.");
  }

  return new Promise((resolve, reject) => {
    const child = spawn(helperPath, ["--stream", "--udid", udid, "--port", String(port)], {
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
      env: SIM_ENV,
    });

    let stdout = "";
    let stderr = "";
    let resolved = false;

    const timeout = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        try {
          child.kill("SIGTERM");
        } catch {
          /* */
        }
        reject(
          new Error(
            `Stream server failed to start within 10s${stderr ? `: ${stderr.slice(-200)}` : ""}`
          )
        );
      }
    }, 10_000);

    child.stdout?.on("data", (data: Buffer) => {
      stdout += data.toString();
      if (!resolved && stdout.includes('"status"')) {
        try {
          const lines = stdout.trim().split("\n");
          const info = JSON.parse(lines[lines.length - 1]!) as { port: number; url: string };
          resolved = true;
          clearTimeout(timeout);

          activeStreams.set(udid, { pid: child.pid!, port: info.port, udid });

          child.stdout?.destroy();
          child.unref();

          resolve({ port: info.port, url: info.url, pid: child.pid! });
        } catch {
          resolved = true;
          clearTimeout(timeout);
          reject(new Error(`Failed to parse stream info: ${stdout}`));
        }
      }
    });

    child.stderr?.on("data", (data: Buffer) => {
      if (!resolved) stderr = `${stderr}${data.toString()}`.slice(-4000);
    });

    child.on("error", (err) => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timeout);
        reject(err);
      }
    });
    child.on("exit", (code) => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timeout);
        reject(new Error(`Stream exited with code ${code}`));
      }
    });
  });
}

function killStream(udid: string): void {
  const stream = activeStreams.get(udid);
  if (stream) {
    try {
      process.kill(stream.pid, "SIGTERM");
    } catch {
      /* */
    }
    activeStreams.delete(udid);
  }
}

// ---------------------------------------------------------------------------
// HID WebSocket connection to simbridge
// ---------------------------------------------------------------------------

function connectHidWs(port: number): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${port}/ws`);
    const timeout = setTimeout(() => {
      ws.close();
      reject(new Error("HID WS timeout"));
    }, 5_000);
    ws.on("open", () => {
      clearTimeout(timeout);
      resolve(ws);
    });
    ws.on("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}

function sendTouchWs(ws: WebSocket, x: number, y: number, touchType: string): void {
  const typeMap: Record<string, string> = { began: "begin", moved: "move", ended: "end" };
  const payload = JSON.stringify({ type: typeMap[touchType] ?? touchType, x, y });
  ws.send(Buffer.concat([Buffer.from([0x03]), Buffer.from(payload)]));
}

function sendButtonWs(ws: WebSocket, button: string): void {
  const payload = JSON.stringify({ button });
  ws.send(Buffer.concat([Buffer.from([0x04]), Buffer.from(payload)]));
}

// ---------------------------------------------------------------------------
// Public API — context queries (used by agent-server RPC)
// ---------------------------------------------------------------------------

export function getContextForWorkspace(workspaceId: string): SimulatorContext | null {
  const session = sessions.get(workspaceId);
  if (!session) return null;
  return {
    udid: session.udid,
    port: session.streamPort ?? undefined,
    streaming: session.streaming,
  };
}

export function getContextForSession(sessionId: string): SimulatorContext | null {
  const db = getDatabase();
  const session = getSessionRaw(db, sessionId);
  if (!session?.workspace_id) return null;
  return getContextForWorkspace(session.workspace_id);
}

// ---------------------------------------------------------------------------
// Public API — device listing
// ---------------------------------------------------------------------------

export async function listDevices(): Promise<SimulatorInfo[]> {
  const { stdout } = await execFileAsync(
    "xcrun",
    ["simctl", "list", "devices", "available", "-j"],
    { env: SIM_ENV, timeout: 10_000 }
  );
  const parsed = JSON.parse(stdout) as {
    devices: Record<
      string,
      Array<{
        udid: string;
        name: string;
        state: string;
        isAvailable: boolean;
        deviceTypeIdentifier?: string;
      }>
    >;
  };

  const results: SimulatorInfo[] = [];
  for (const [runtimeId, devices] of Object.entries(parsed.devices)) {
    const runtime = runtimeId
      .replace("com.apple.CoreSimulator.SimRuntime.", "")
      .replace(/-/g, ".")
      .replace(/\.(\d)/, " $1");

    for (const d of devices) {
      if (!d.isAvailable) continue;
      results.push({
        name: d.name,
        udid: d.udid,
        state: d.state,
        runtime,
        device_type: (d.deviceTypeIdentifier ?? "")
          .replace("com.apple.CoreSimulator.SimDeviceType.", "")
          .replace(/-/g, " "),
        is_available: d.isAvailable,
      });
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// Public API — stream lifecycle (replaces Electron IPC handlers)
// ---------------------------------------------------------------------------

export async function startStream(
  workspaceId: string,
  udid: string,
  skipBootCheck = false
): Promise<void> {
  // Boot if needed
  if (!skipBootCheck) {
    try {
      await execFileAsync("xcrun", ["simctl", "boot", udid], { env: SIM_ENV });
    } catch (err: any) {
      if (!err?.stderr?.includes("Booted") && !err?.message?.includes("Booted")) {
        throw new Error(`Failed to boot simulator: ${err?.message ?? err}`);
      }
    }
  }

  // Open Simulator.app for framebuffer access
  try {
    await execFileAsync("open", ["-a", "Simulator", "--args", "-CurrentDeviceUDID", udid], {
      env: SIM_ENV,
    });
    await new Promise((r) => setTimeout(r, 1500));
  } catch {
    /* */
  }

  // Start MJPEG stream
  const port = await reservePort(3100 + sessions.size);
  const streamInfo = await spawnStream(udid, port);

  // Connect HID WebSocket
  let hidWs: WebSocket | null = null;
  let hidConnected = false;
  try {
    hidWs = await connectHidWs(streamInfo.port);
    hidConnected = true;
  } catch {
    console.warn("[Simulator] HID WebSocket unavailable for", udid);
  }

  // Get device info for display
  const devices = await listDevices();
  const deviceInfo = devices.find((d) => d.udid === udid);

  // Track session
  sessions.set(workspaceId, {
    workspaceId,
    udid,
    deviceName: deviceInfo?.name ?? udid,
    runtime: deviceInfo?.runtime ?? "",
    streaming: true,
    streamPid: streamInfo.pid,
    streamPort: streamInfo.port,
    hidWs,
    hidConnected,
    appBundleId: null,
    appName: null,
    bootedAt: Date.now(),
    streamStartedAt: Date.now(),
  });

  // Release any previous claim on this UDID by other workspaces.
  // Close their HID WebSocket (the stream process is shared since we look it
  // up by UDID, so we don't kill the stream — just release the other claim).
  for (const [wsId, s] of sessions.entries()) {
    if (s.udid === udid && wsId !== workspaceId) {
      if (s.hidWs) {
        try {
          s.hidWs.close();
        } catch {
          /* already closed */
        }
      }
      sessions.delete(wsId);
      pushEvent("sim:stopped", { workspaceId: wsId });
    }
  }

  // Push stream ready event to frontend
  const streamReadyPayload = {
    workspaceId,
    url: `http://localhost:${streamInfo.port}/stream.mjpeg`,
    port: streamInfo.port,
    hidAvailable: hidConnected,
    deviceName: deviceInfo?.name ?? udid,
    udid,
  };
  pushEvent("sim:streamReady", streamReadyPayload);
}

export function stopStream(workspaceId: string): void {
  const session = sessions.get(workspaceId);
  if (!session) return;

  if (session.hidWs) {
    try {
      session.hidWs.close();
    } catch {
      /* */
    }
  }

  const udid = session.udid;
  sessions.delete(workspaceId);

  // Only kill the stream process if no other workspace uses this UDID
  const udidStillInUse = Array.from(sessions.values()).some((s) => s.udid === udid);
  if (!udidStillInUse) {
    killStream(udid);
  }

  pushEvent("sim:stopped", { workspaceId });
}

// ---------------------------------------------------------------------------
// Public API — HID input relay
// ---------------------------------------------------------------------------

export function sendTouch(workspaceId: string, x: number, y: number, touchType: string): void {
  const session = sessions.get(workspaceId);
  if (!session?.hidWs || session.hidWs.readyState !== WebSocket.OPEN) {
    throw new Error("No HID connection available");
  }
  sendTouchWs(session.hidWs, x, y, touchType);
}

export function sendKey(workspaceId: string, keycode: number, direction: string): void {
  const session = sessions.get(workspaceId);
  if (!session) throw new Error("No active simulator session");

  const helperPath = findSimBridgePath();
  if (!helperPath) throw new Error("simbridge not found");

  execFile(
    helperPath,
    [
      JSON.stringify({
        command: "key",
        udid: session.udid,
        keyCode: keycode,
        direction,
      }),
    ],
    { timeout: 5_000, env: SIM_ENV },
    () => {
      /* fire-and-forget */
    }
  );
}

export function sendScroll(
  workspaceId: string,
  x: number,
  y: number,
  dx: number,
  dy: number
): void {
  const session = sessions.get(workspaceId);
  if (!session?.hidWs || session.hidWs.readyState !== WebSocket.OPEN) {
    throw new Error("No HID connection available");
  }
  const endX = Math.max(0, Math.min(1, x + dx * 0.002));
  const endY = Math.max(0, Math.min(1, y + dy * 0.002));
  sendTouchWs(session.hidWs, x, y, "began");
  sendTouchWs(session.hidWs, endX, endY, "moved");
  sendTouchWs(session.hidWs, endX, endY, "ended");
}

export function sendButton(workspaceId: string, buttonType: string): void {
  const session = sessions.get(workspaceId);
  if (session?.hidWs && session.hidWs.readyState === WebSocket.OPEN) {
    sendButtonWs(session.hidWs, buttonType);
  } else if (session?.udid) {
    execFileAsync("xcrun", ["simctl", "io", session.udid, "send", "home"], { env: SIM_ENV }).catch(
      () => {}
    );
  }
}

// ---------------------------------------------------------------------------
// Public API — screenshot
// ---------------------------------------------------------------------------

export async function takeScreenshot(workspaceId: string): Promise<number[]> {
  const session = sessions.get(workspaceId);
  if (!session) throw new Error("No active simulator session");

  const outputPath = join(tmpdir(), `deus-sim-screenshot-${Date.now()}.jpeg`);
  await execFileAsync(
    "xcrun",
    ["simctl", "io", session.udid, "screenshot", "--type", "jpeg", outputPath],
    { env: SIM_ENV }
  );

  const { readFile, unlink } = await import("fs/promises");
  const buf = await readFile(outputPath);
  await unlink(outputPath).catch(() => {});
  return Array.from(buf);
}

// ---------------------------------------------------------------------------
// Public API — Xcode project detection
// ---------------------------------------------------------------------------

export async function hasXcodeProject(workspacePath: string): Promise<boolean> {
  try {
    const entries = await readdir(workspacePath);
    return entries.some((e) => e.endsWith(".xcodeproj") || e.endsWith(".xcworkspace"));
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Public API — build & run
// ---------------------------------------------------------------------------

export async function buildAndRun(
  workspaceId: string,
  workspacePath: string,
  scheme?: string
): Promise<{ bundle_id: string; name: string; app_path: string }> {
  const session = sessions.get(workspaceId);
  if (!session) throw new Error("No active simulator session");

  const entries = await readdir(workspacePath);
  const xcworkspace = entries.find((e) => e.endsWith(".xcworkspace"));
  const xcodeproj = entries.find((e) => e.endsWith(".xcodeproj"));
  const projectArg = xcworkspace
    ? ["-workspace", join(workspacePath, xcworkspace)]
    : xcodeproj
      ? ["-project", join(workspacePath, xcodeproj)]
      : null;

  if (!projectArg) throw new Error("No Xcode project found in workspace");

  // Resolve scheme: explicit wins, else use the single shared scheme.
  // Multiple schemes without an explicit choice is an error — don't guess.
  let schemeName = scheme;
  if (!schemeName) {
    const { stdout: listOut } = await execFileAsync(
      "xcodebuild",
      [...projectArg, "-list", "-json"],
      { cwd: workspacePath, timeout: 30_000, env: SIM_ENV }
    );
    const parsed = JSON.parse(listOut) as {
      workspace?: { schemes?: string[] };
      project?: { schemes?: string[] };
    };
    const schemes = parsed.workspace?.schemes ?? parsed.project?.schemes ?? [];
    if (schemes.length === 1) {
      schemeName = schemes[0];
    } else if (schemes.length === 0) {
      throw new Error("No schemes found in Xcode project");
    } else {
      throw new Error(`Multiple schemes found (${schemes.join(", ")}). Specify one explicitly.`);
    }
  }

  const destination = `platform=iOS Simulator,id=${session.udid}`;
  const derivedData = join(workspacePath, "build");
  const buildArgs = [
    ...projectArg,
    "-scheme",
    schemeName,
    "-destination",
    destination,
    "-derivedDataPath",
    derivedData,
    "build",
  ];

  // Stream build logs line by line. Chunk boundaries are arbitrary, so we
  // keep a carry buffer per stream and only emit completed lines — avoids
  // truncated or merged log lines in the frontend.
  await new Promise<void>((resolve, reject) => {
    const child = spawn("xcodebuild", buildArgs, {
      cwd: workspacePath,
      env: SIM_ENV,
    });

    const makeLineBuffer = () => {
      let buffer = "";
      return (data: Buffer) => {
        buffer += data.toString();
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? ""; // keep incomplete trailing line
        for (const line of lines) {
          if (line) pushEvent("sim:buildLog", { workspaceId, line });
        }
      };
    };

    child.stdout?.on("data", makeLineBuffer());
    child.stderr?.on("data", makeLineBuffer());

    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`xcodebuild exited with code ${code}`));
    });
    child.on("error", reject);
  });

  // Find built .app via xcodebuild's TARGET_BUILD_DIR + FULL_PRODUCT_NAME —
  // more reliable than `find` which can pick the wrong bundle.
  const { stdout: settingsOut } = await execFileAsync(
    "xcodebuild",
    [
      ...projectArg,
      "-scheme",
      schemeName!,
      "-destination",
      destination,
      "-derivedDataPath",
      derivedData,
      "-showBuildSettings",
      "-json",
    ],
    { cwd: workspacePath, timeout: 60_000, env: SIM_ENV, maxBuffer: 20 * 1024 * 1024 }
  );
  const settings = JSON.parse(settingsOut) as Array<{ buildSettings?: Record<string, string> }>;
  const s = settings[0]?.buildSettings ?? {};
  const targetDir = s.TARGET_BUILD_DIR;
  const productName = s.FULL_PRODUCT_NAME;
  if (!targetDir || !productName) {
    throw new Error("Could not determine built .app path from xcodebuild settings");
  }
  const appPath = join(targetDir, productName);
  if (!existsSync(appPath)) {
    throw new Error(`Built .app bundle not found at ${appPath}`);
  }

  // Extract bundle ID — required for launch
  const { stdout: plistOut } = await execFileAsync("/usr/libexec/PlistBuddy", [
    "-c",
    "Print :CFBundleIdentifier",
    join(appPath, "Info.plist"),
  ]).catch((err) => {
    throw new Error(`Failed to read CFBundleIdentifier from ${appPath}: ${err.message}`);
  });
  const bundleId = plistOut.trim();
  if (!bundleId) throw new Error(`Empty CFBundleIdentifier in ${appPath}/Info.plist`);

  // Install and launch
  await execFileAsync("xcrun", ["simctl", "install", session.udid, appPath], {
    env: SIM_ENV,
    timeout: 60_000,
  });
  await execFileAsync("xcrun", ["simctl", "launch", session.udid, bundleId], { env: SIM_ENV });

  const appName = appPath.split("/").pop()?.replace(".app", "") ?? "App";

  // Update session
  session.appBundleId = bundleId;
  session.appName = appName;

  pushEvent("sim:buildComplete", { workspaceId, bundleId, appName, appPath });

  return { bundle_id: bundleId, name: appName, app_path: appPath };
}

// ---------------------------------------------------------------------------
// Startup reconciliation
// ---------------------------------------------------------------------------

export async function reconcile(): Promise<void> {
  try {
    const { stdout } = await execFileAsync(
      "xcrun",
      ["simctl", "list", "devices", "available", "-j"],
      { env: SIM_ENV, timeout: 10_000 }
    );
    const parsed = JSON.parse(stdout) as {
      devices: Record<string, Array<{ udid: string; state: string }>>;
    };
    let bootedCount = 0;
    for (const devices of Object.values(parsed.devices)) {
      for (const d of devices) {
        if (d.state === "Booted") bootedCount++;
      }
    }
    if (bootedCount > 0) {
      console.log(`[Simulator] Reconciled: ${bootedCount} booted simulator(s)`);
    }
  } catch {
    console.log("[Simulator] simctl not available, skipping reconciliation");
  }
}

export function destroyAll(): void {
  for (const session of sessions.values()) {
    if (session.hidWs)
      try {
        session.hidWs.close();
      } catch {
        /* */
      }
  }
  for (const stream of activeStreams.values()) {
    try {
      process.kill(stream.pid, "SIGTERM");
    } catch {
      /* */
    }
  }
  sessions.clear();
  activeStreams.clear();
}
