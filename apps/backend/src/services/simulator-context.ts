// backend/src/services/simulator-context.ts
//
// Simulator service — the Simulator tab's operations (api/simulator.ts).
// Agents drive simulators themselves, with the agent-device CLI; a turn names
// the tab's device to its agent (getContextForSession).
//
// Requests answer at once; what happens later is published on `simulatorEvents`.
// Works identically in desktop (WS to localhost) and relay/web mode.
//
// TODO(relay-streaming): Add MJPEG frame proxy for web/relay mode.

import { execFile, spawn, type ChildProcess } from "child_process";
import { promisify } from "util";
import { existsSync, unlinkSync } from "fs";
import { readdir } from "fs/promises";
import { createConnection } from "net";
import { tmpdir } from "os";
import { join } from "path";
import { createHash, randomBytes } from "crypto";
import WebSocket from "ws";
import { createBackendChildEnv } from "@shared/lib/child-env";
import { getDatabase } from "../lib/database";
import { ConflictError, NotFoundError, ValidationError } from "../lib/errors";
import { getSessionRaw } from "../db/queries";
import { simulatorEvents, type SimulatorEvent } from "@shared/api/simulator";
import { publish } from "./streams";
import type {
  InspectorNode,
  InspectorRect,
  InspectorSnapshot,
  SimulatorCapabilities,
  SimulatorInfo,
} from "@shared/types/simulator";

const execFileAsync = promisify(execFile);

/** The simulator engine: the helpers' paths and the environment Xcode's tools need. ESM, so loaded lazily. */
const engine = () => import("device-use/engine");

/** What Xcode's tools and the helpers run with: the backend's environment without its internals. */
async function simEnv(): Promise<NodeJS.ProcessEnv> {
  return (await engine()).simulatorEnv(createBackendChildEnv());
}

/** `xcrun simctl <args>`. */
export async function simctl(
  args: string[],
  options: { timeout?: number; env?: NodeJS.ProcessEnv } = {}
): Promise<{ stdout: string }> {
  return execFileAsync("xcrun", ["simctl", ...args], {
    timeout: options.timeout,
    env: { ...(await simEnv()), ...options.env },
  });
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SimulatorContext {
  udid: string;
  streaming: boolean;
}

interface AccessibilityNodeLike {
  role?: string;
  type?: string;
  label?: string;
  identifier?: string;
  value?: string;
  frame?: InspectorRect;
  center?: { x: number; y: number };
  enabled?: boolean;
  focused?: boolean;
  traits?: string[];
  children?: AccessibilityNodeLike[];
}

export interface SimulatorCapabilityInput {
  backendPlatform: NodeJS.Platform;
  relayClient: boolean;
  simctlAvailable: boolean;
  simbridgeAvailable: boolean;
}

interface SimulatorSession {
  workspaceId: string;
  udid: string;
  deviceName: string;
  runtime: string;
  streaming: boolean;
  hidWs: WebSocket | null;
  hidConnected: boolean;
  appBundleId: string | null;
  appName: string | null;
  inspectorSocketPath: string | null;
  inspectorPid: number | null;
  bootedAt: number;
  streamStartedAt: number | null;
}

// ---------------------------------------------------------------------------
// In-memory sessions: workspaceId → SimulatorSession
// ---------------------------------------------------------------------------

const sessions = new Map<string, SimulatorSession>();
const startingUdids = new Map<string, string>();

const MACOS_REQUIRED_REASON = "iOS Simulator requires a local macOS backend with Xcode.";
const SIMCTL_REQUIRED_REASON = "iOS Simulator requires Xcode simctl on the backend Mac.";
const SIMBRIDGE_REQUIRED_REASON =
  "iOS Simulator streaming requires the simbridge helper. Run `bun install` in repo root to build it.";
const RELAY_STREAM_UNAVAILABLE_REASON =
  "iOS Simulator streaming is unavailable over remote relay in this build.";

export function resolveSimulatorCapabilities({
  backendPlatform,
  relayClient,
  simctlAvailable,
  simbridgeAvailable,
}: SimulatorCapabilityInput): SimulatorCapabilities {
  if (backendPlatform !== "darwin") {
    return {
      available: false,
      unavailableReason: MACOS_REQUIRED_REASON,
    };
  }

  if (!simctlAvailable) {
    return {
      available: false,
      unavailableReason: SIMCTL_REQUIRED_REASON,
    };
  }

  if (relayClient) {
    return {
      available: false,
      unavailableReason: RELAY_STREAM_UNAVAILABLE_REASON,
    };
  }

  if (!simbridgeAvailable) {
    return {
      available: false,
      unavailableReason: SIMBRIDGE_REQUIRED_REASON,
    };
  }

  return {
    available: true,
    unavailableReason: null,
  };
}

/** Whether simctl resolves, asked at most once a minute (`simulatorCapabilities` asks on every read). */
const TOOLCHAIN_TTL_MS = 60_000;
let toolchain: { available: boolean; checkedAt: number } | null = null;

async function hasSimulatorToolchain(): Promise<boolean> {
  if (toolchain && Date.now() - toolchain.checkedAt < TOOLCHAIN_TTL_MS) return toolchain.available;
  let available = false;
  try {
    const { stdout } = await execFileAsync("xcrun", ["--find", "simctl"], {
      env: await simEnv(),
      timeout: 5000,
    });
    available = stdout.trim().length > 0;
  } catch {
    // No Xcode command-line tools.
  }
  toolchain = { available, checkedAt: Date.now() };
  return available;
}

export async function getSimulatorCapabilities(
  options: {
    relayClient?: boolean;
  } = {}
): Promise<SimulatorCapabilities> {
  return resolveSimulatorCapabilities({
    backendPlatform: process.platform,
    relayClient: options.relayClient === true,
    simctlAvailable: await hasSimulatorToolchain(),
    simbridgeAvailable: (await engine()).findBridgePath() !== null,
  });
}

/** Tell the clients following a workspace's simulator. */
function pushEvent(workspaceId: string, event: SimulatorEvent): void {
  publish(simulatorEvents, { workspaceId }, event);
}

function closeHidSocket(session: SimulatorSession): void {
  if (!session.hidWs) return;
  try {
    session.hidWs.close();
  } catch {
    /* already closed */
  }
}

function releaseWorkspaceSession(workspaceId: string, keepStreamForUdid?: string): void {
  const session = sessions.get(workspaceId);
  if (!session) return;

  closeHidSocket(session);
  sessions.delete(workspaceId);

  if (session.udid === keepStreamForUdid) return;

  const udidStillInUse = Array.from(sessions.values()).some((s) => s.udid === session.udid);
  if (!udidStillInUse) {
    killStream(session.udid);
  }
}

function getActiveUdidOwner(udid: string, requesterWorkspaceId: string): string | null {
  const owner = Array.from(sessions.values()).find(
    (session) => session.udid === udid && session.workspaceId !== requesterWorkspaceId
  );
  if (owner) return owner.workspaceId;

  const starterWorkspaceId = startingUdids.get(udid);
  if (starterWorkspaceId && starterWorkspaceId !== requesterWorkspaceId) {
    return starterWorkspaceId;
  }

  return null;
}

function claimStartingUdid(workspaceId: string, udid: string): void {
  const ownerWorkspaceId = getActiveUdidOwner(udid, workspaceId);
  if (ownerWorkspaceId) {
    throw new ConflictError("Simulator is already in use by another workspace");
  }
  startingUdids.set(udid, workspaceId);
}

function releaseStartingUdid(workspaceId: string, udid: string): void {
  if (startingUdids.get(udid) === workspaceId) {
    startingUdids.delete(udid);
  }
}

// ---------------------------------------------------------------------------
// Stream lifecycle — spawn simbridge for MJPEG + HID
// ---------------------------------------------------------------------------

/** A running stream helper: its server listens on 127.0.0.1:`port` and requires `token`. */
interface StreamHelper {
  child: ChildProcess;
  port: number;
  token: string;
}

/** Active stream helpers keyed by UDID (multiple sims can stream simultaneously). */
const activeStreams = new Map<string, StreamHelper>();

interface XcodeProjectRef {
  path: string;
  args: string[];
}

async function findXcodeProject(workspacePath: string): Promise<XcodeProjectRef | null> {
  const roots = [workspacePath, join(workspacePath, "ios")];
  for (const root of roots) {
    try {
      const entries = await readdir(root);
      const xcworkspace = entries.find((entry) => entry.endsWith(".xcworkspace"));
      if (xcworkspace) {
        const projectPath = join(root, xcworkspace);
        return { path: projectPath, args: ["-workspace", projectPath] };
      }

      const xcodeproj = entries.find((entry) => entry.endsWith(".xcodeproj"));
      if (xcodeproj) {
        const projectPath = join(root, xcodeproj);
        return { path: projectPath, args: ["-project", projectPath] };
      }
    } catch {
      // Try the next conventional location.
    }
  }
  return null;
}

async function spawnStream(udid: string): Promise<StreamHelper> {
  const existing = activeStreams.get(udid);
  if (existing) return existing;

  const helperPath = (await engine()).findBridgePath();
  if (!helperPath) {
    throw new Error("simbridge binary not found. Run `bun install` in repo root to build it.");
  }

  const token = randomBytes(32).toString("base64url");
  // stdin is a pipe this process holds and never writes to: the helper exits
  // when it ends, so it never outlives the backend, however the backend ends.
  const child = spawn(helperPath, ["--stream", "--udid", udid, "--port", "0"], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...(await simEnv()), SIMBRIDGE_STREAM_TOKEN: token },
  });

  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let started = false;
    const fail = (err: Error) => {
      if (started) return;
      started = true;
      clearTimeout(timeout);
      child.kill("SIGTERM");
      reject(err);
    };
    const timeout = setTimeout(
      () =>
        fail(
          new Error(
            `Stream server failed to start within 10s${stderr ? `: ${stderr.slice(-200)}` : ""}`
          )
        ),
      10_000
    );

    child.stdout?.on("data", (data: Buffer) => {
      stdout += data.toString();
      if (started || !stdout.includes("\n")) return;
      try {
        const { port } = JSON.parse(stdout.trim().split("\n").pop()!) as { port: number };
        started = true;
        clearTimeout(timeout);
        const stream = { child, port, token };
        activeStreams.set(udid, stream);
        resolve(stream);
      } catch {
        fail(new Error(`Failed to parse stream info: ${stdout}`));
      }
    });

    child.stderr?.on("data", (data: Buffer) => {
      if (!started) stderr = `${stderr}${data.toString()}`.slice(-4000);
    });

    child.on("error", fail);
    child.on("exit", (code) => {
      fail(new Error(`Stream exited with code ${code}${stderr ? `: ${stderr.slice(-200)}` : ""}`));
      // Stopped on purpose (killStream forgets it first), or a later stream's.
      if (activeStreams.get(udid)?.child !== child) return;
      activeStreams.delete(udid);
      for (const session of [...sessions.values()]) {
        if (session.udid !== udid) continue;
        releaseWorkspaceSession(session.workspaceId);
        pushEvent(session.workspaceId, {
          type: "streamFailed",
          error: `The simulator stream stopped (exit code ${code}).`,
        });
      }
    });
  });
}

function killStream(udid: string): void {
  const stream = activeStreams.get(udid);
  activeStreams.delete(udid);
  stream?.child.kill("SIGTERM");
}

// ---------------------------------------------------------------------------
// HID WebSocket connection to simbridge
// ---------------------------------------------------------------------------

function connectHidWs({ port, token }: StreamHelper): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?t=${token}`);
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

/** The workspace's HID socket, open; refuses when there is none. */
function hidSocket(workspaceId: string): WebSocket {
  const ws = sessions.get(workspaceId)?.hidWs;
  if (!ws || ws.readyState !== WebSocket.OPEN) throw new Error("No HID connection available");
  return ws;
}

// ---------------------------------------------------------------------------
// Public API — context queries
// ---------------------------------------------------------------------------

export function getContextForWorkspace(workspaceId: string): SimulatorContext | null {
  const session = sessions.get(workspaceId);
  if (!session) return null;
  return {
    udid: session.udid,
    streaming: session.streaming,
  };
}

/** The device a chat's workspace shows in its Simulator tab, which its turns name to the agent. */
export function getContextForSession(sessionId: string): SimulatorContext | null {
  const session = getSessionRaw(getDatabase(), sessionId);
  return session?.workspace_id ? getContextForWorkspace(session.workspace_id) : null;
}

// ---------------------------------------------------------------------------
// Public API — device listing
// ---------------------------------------------------------------------------

export async function listDevices(): Promise<SimulatorInfo[]> {
  // CoreSimulator initialization can exceed 10 seconds on a fresh macOS install.
  const { stdout } = await simctl(["list", "devices", "available", "-j"], { timeout: 30_000 });
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
  claimStartingUdid(workspaceId, udid);

  const previousSession = sessions.get(workspaceId);
  let hidWs: WebSocket | null = null;

  try {
    // Boot if needed
    if (!skipBootCheck) {
      try {
        await simctl(["boot", udid]);
      } catch (err: any) {
        if (!err?.stderr?.includes("Booted") && !err?.message?.includes("Booted")) {
          throw new Error(`Failed to boot simulator: ${err?.message ?? err}`);
        }
      }
    }

    // Start Simulator.app hidden so the private framebuffer pipeline exists
    // without placing native simulator windows over the user's desktop.
    try {
      await execFileAsync(
        "open",
        ["-j", "-g", "-a", "Simulator", "--args", "-CurrentDeviceUDID", udid],
        { env: await simEnv() }
      );
      await new Promise((r) => setTimeout(r, 1500));
    } catch {
      /* */
    }

    // Start MJPEG stream
    const stream = await spawnStream(udid);

    // Connect HID WebSocket
    let hidConnected = false;
    try {
      hidWs = await connectHidWs(stream);
      hidConnected = true;
    } catch {
      console.warn("[Simulator] HID WebSocket unavailable for", udid);
    }

    // Get device info for display
    const devices = await listDevices();
    const deviceInfo = devices.find((d) => d.udid === udid);

    // A helper that exited since it said it was ready found no session to fail.
    if (activeStreams.get(udid) !== stream) {
      throw new Error("The simulator stream stopped while it was starting.");
    }

    if (previousSession) {
      releaseWorkspaceSession(workspaceId, udid);
    }

    // Track session
    sessions.set(workspaceId, {
      workspaceId,
      udid,
      deviceName: deviceInfo?.name ?? udid,
      runtime: deviceInfo?.runtime ?? "",
      streaming: true,
      hidWs,
      hidConnected,
      appBundleId: null,
      appName: null,
      inspectorSocketPath: null,
      inspectorPid: null,
      bootedAt: Date.now(),
      streamStartedAt: Date.now(),
    });

    pushEvent(workspaceId, {
      type: "streamReady",
      url: `http://127.0.0.1:${stream.port}/stream.mjpeg?t=${stream.token}`,
      hidAvailable: hidConnected,
    });
  } catch (err) {
    if (hidWs) {
      try {
        hidWs.close();
      } catch {
        /* */
      }
    }
    throw err;
  } finally {
    releaseStartingUdid(workspaceId, udid);
  }
}

export function stopStream(workspaceId: string): void {
  const session = sessions.get(workspaceId);
  if (!session) return;

  releaseWorkspaceSession(workspaceId);
}

// ---------------------------------------------------------------------------
// Public API — HID input relay
// ---------------------------------------------------------------------------

export function sendTouch(workspaceId: string, x: number, y: number, touchType: string): void {
  sendTouchWs(hidSocket(workspaceId), x, y, touchType);
}

/** A key going down or up, as the client's keyboard reports it. */
export function sendKey(workspaceId: string, keyCode: number, direction: "down" | "up"): void {
  const payload = JSON.stringify({ keyCode, direction });
  hidSocket(workspaceId).send(Buffer.concat([Buffer.from([0x05]), Buffer.from(payload)]));
}

export function sendScroll(
  workspaceId: string,
  x: number,
  y: number,
  dx: number,
  dy: number
): void {
  const ws = hidSocket(workspaceId);
  const endX = Math.max(0, Math.min(1, x + dx * 0.002));
  const endY = Math.max(0, Math.min(1, y + dy * 0.002));
  sendTouchWs(ws, x, y, "began");
  sendTouchWs(ws, endX, endY, "moved");
  sendTouchWs(ws, endX, endY, "ended");
}

export function sendButton(workspaceId: string, buttonType: string): void {
  sendButtonWs(hidSocket(workspaceId), buttonType);
}

// ---------------------------------------------------------------------------
// Public API — native inspect mode
// ---------------------------------------------------------------------------

function inspectorSocketPath(udid: string, bundleId: string): string {
  const hash = createHash("sha1").update(`${udid}:${bundleId}`).digest("hex").slice(0, 20);
  return join(tmpdir(), `deus-siminspector-${hash}.sock`);
}

function parseLaunchPid(stdout: string): number | null {
  const pid = Number(stdout.trim().split(":").pop()?.trim());
  return Number.isFinite(pid) && pid > 0 ? pid : null;
}

function callInspector<T>(socketPath: string, command: string, timeoutMs = 5000): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const socket = createConnection(socketPath);
    let settled = false;
    let buffer = "";
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(new Error(`siminspector timed out for ${command}`));
    }, timeoutMs);

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      fn();
    };

    socket.on("connect", () => {
      socket.write(`${JSON.stringify({ command })}\n`);
    });
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      const newline = buffer.indexOf("\n");
      if (newline === -1) return;
      const line = buffer.slice(0, newline);
      finish(() => {
        try {
          const parsed = JSON.parse(line) as { ok?: boolean; data?: T; error?: string };
          if (!parsed.ok) reject(new Error(parsed.error ?? "siminspector request failed"));
          else resolve(parsed.data as T);
        } catch (err) {
          reject(err);
        }
      });
    });
    socket.on("error", (err) => finish(() => reject(err)));
  });
}

async function waitForInspector(socketPath: string): Promise<void> {
  const deadline = Date.now() + 8000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      await callInspector<{ pid: number }>(socketPath, "ping", 1000);
      return;
    } catch (err) {
      lastError = err;
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
  }
  throw new Error(
    `siminspector did not become ready${lastError instanceof Error ? `: ${lastError.message}` : ""}`
  );
}

function accessibilityNodeToInspectorNode(
  node: AccessibilityNodeLike,
  indexPath: string,
  parentId?: string
): InspectorNode {
  const id = `ax-${indexPath}`;
  const frame = node.frame ?? { x: 0, y: 0, width: 0, height: 0 };
  const properties: Record<string, string> = {};
  if (node.role) properties.role = node.role;
  if (node.value) properties.value = node.value;
  if (node.enabled !== undefined) properties.enabled = String(node.enabled);
  if (node.focused !== undefined) properties.focused = String(node.focused);
  if (node.traits?.length) properties.traits = node.traits.join(", ");
  if (node.identifier) properties.accessibilityIdentifier = node.identifier;
  if (node.label) properties.accessibilityLabel = node.label;

  return {
    id,
    ...(parentId ? { parentId } : {}),
    className: node.type ?? node.role ?? "AccessibilityElement",
    ...(node.label ? { label: node.label } : {}),
    ...(node.identifier ? { identifier: node.identifier } : {}),
    frame,
    screenRect: frame,
    alpha: 1,
    hidden: false,
    userInteractionEnabled: node.enabled ?? true,
    ...(Object.keys(properties).length > 0 ? { properties } : {}),
    children: (node.children ?? []).map((child, index) =>
      accessibilityNodeToInspectorNode(child, `${indexPath}-${index}`, id)
    ),
  };
}

async function accessibilitySnapshot(workspaceId: string): Promise<InspectorSnapshot> {
  const session = sessions.get(workspaceId);
  if (!session) throw new ConflictError("No active simulator session");
  const { callSimBridge } = await engine();
  const { data } = (await callSimBridge(
    { command: "describe-ui", udid: session.udid },
    { env: createBackendChildEnv() }
  )) as { data?: { elements?: AccessibilityNodeLike[] } };
  return {
    bundleId: "accessibility-current-ui",
    pid: 0,
    timestamp: Date.now(),
    source: "accessibility",
    roots: (data?.elements ?? []).map((node, index) =>
      accessibilityNodeToInspectorNode(node, String(index))
    ),
  };
}

export async function startInspector(
  workspaceId: string,
  bundleIdOverride?: string
): Promise<InspectorSnapshot> {
  const session = sessions.get(workspaceId);
  if (!session) throw new ConflictError("No active simulator session");
  const bundleId = bundleIdOverride ?? session.appBundleId;
  if (!bundleId) {
    session.inspectorSocketPath = null;
    session.inspectorPid = null;
    return accessibilitySnapshot(workspaceId);
  }

  const inspectorPath = (await engine()).findInspectorPath();
  if (!inspectorPath) {
    throw new Error("siminspector dylib not found. Run `bun run prepare:device-use`.");
  }

  const socketPath = inspectorSocketPath(session.udid, bundleId);
  try {
    unlinkSync(socketPath);
  } catch {
    /* ignore */
  }

  const { stdout } = await simctl(
    ["launch", "--terminate-running-process", session.udid, bundleId],
    {
      timeout: 30_000,
      env: {
        SIMCTL_CHILD_DYLD_INSERT_LIBRARIES: inspectorPath,
        SIMCTL_CHILD_DEUS_SIMINSPECTOR_SOCKET: socketPath,
      },
    }
  );

  session.appBundleId = bundleId;
  session.inspectorSocketPath = socketPath;
  session.inspectorPid = parseLaunchPid(stdout);

  await waitForInspector(socketPath);
  return inspectorSnapshot(workspaceId);
}

export async function inspectorSnapshot(workspaceId: string): Promise<InspectorSnapshot> {
  const session = sessions.get(workspaceId);
  if (!session?.inspectorSocketPath) {
    return accessibilitySnapshot(workspaceId);
  }
  return callInspector<InspectorSnapshot>(session.inspectorSocketPath, "snapshot", 8000);
}

// ---------------------------------------------------------------------------
// Public API — screenshot
// ---------------------------------------------------------------------------

export async function takeScreenshot(workspaceId: string): Promise<number[]> {
  const session = sessions.get(workspaceId);
  if (!session) throw new ConflictError("No active simulator session");

  const outputPath = join(tmpdir(), `deus-sim-screenshot-${Date.now()}.jpeg`);
  await simctl(["io", session.udid, "screenshot", "--type", "jpeg", outputPath]);

  const { readFile, unlink } = await import("fs/promises");
  const buf = await readFile(outputPath);
  await unlink(outputPath).catch(() => {});
  return Array.from(buf);
}

// ---------------------------------------------------------------------------
// Public API — Xcode project detection
// ---------------------------------------------------------------------------

export async function hasXcodeProject(workspacePath: string): Promise<boolean> {
  return (await findXcodeProject(workspacePath)) !== null;
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
  if (!session) throw new ConflictError("No active simulator session");

  const project = await findXcodeProject(workspacePath);
  if (!project) throw new NotFoundError("No Xcode project found in workspace or ios/ subdirectory");
  const projectArg = project.args;

  // Resolve scheme: explicit wins, else use the single shared scheme.
  // Multiple schemes without an explicit choice is an error — don't guess.
  let schemeName = scheme;
  if (!schemeName) {
    const { stdout: listOut } = await execFileAsync(
      "xcodebuild",
      [...projectArg, "-list", "-json"],
      { cwd: workspacePath, timeout: 30_000, env: await simEnv() }
    );
    const parsed = JSON.parse(listOut) as {
      workspace?: { schemes?: string[] };
      project?: { schemes?: string[] };
    };
    const schemes = parsed.workspace?.schemes ?? parsed.project?.schemes ?? [];
    if (schemes.length === 1) {
      schemeName = schemes[0];
    } else if (schemes.length === 0) {
      throw new ValidationError("No schemes found in Xcode project");
    } else {
      throw new ValidationError(
        `Multiple schemes found (${schemes.join(", ")}). Specify one explicitly.`
      );
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
  const env = await simEnv();
  await new Promise<void>((resolve, reject) => {
    const child = spawn("xcodebuild", buildArgs, { cwd: workspacePath, env });

    const makeLineBuffer = () => {
      let buffer = "";
      return (data: Buffer) => {
        buffer += data.toString();
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? ""; // keep incomplete trailing line
        for (const line of lines) {
          if (line) pushEvent(workspaceId, { type: "buildLog", line });
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
    { cwd: workspacePath, timeout: 60_000, env, maxBuffer: 20 * 1024 * 1024 }
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
  await simctl(["install", session.udid, appPath], { timeout: 60_000 });
  await simctl(["launch", session.udid, bundleId]);

  const appName = appPath.split("/").pop()?.replace(".app", "") ?? "App";

  // Update session
  session.appBundleId = bundleId;
  session.appName = appName;

  pushEvent(workspaceId, { type: "buildComplete", bundleId, appName, appPath });

  return { bundle_id: bundleId, name: appName, app_path: appPath };
}

// ---------------------------------------------------------------------------
// Startup reconciliation
// ---------------------------------------------------------------------------

export async function reconcile(): Promise<void> {
  try {
    const { stdout } = await simctl(["list", "devices", "available", "-j"], { timeout: 10_000 });
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
  for (const udid of [...activeStreams.keys()]) killStream(udid);
  sessions.clear();
  startingUdids.clear();
}
