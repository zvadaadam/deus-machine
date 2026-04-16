// agent-server/agents/deus-tools/sim-ops.ts
//
// Pure simulator operations library. Module-level functions wrapping
// agent-simulator/engine + xcodebuild. Every function takes a UDID and
// returns a result — no sessions, no transport awareness.
//
// IMPORTANT: agent-simulator/engine uses import.meta.url (ESM) but the
// agent-server bundles to CJS. All imports from agent-simulator/engine
// MUST be lazy (dynamic import) to avoid crashing at module load time.
//
// Used by: MCP tool definitions (simulator.ts) for agent headless control.
// NOT used by: Simulator Panel (that goes through the backend service).
//
// TODO(build-log-streaming): pipe xcodebuild stdout line-by-line via
// EventBroadcaster so the panel can show real-time build progress.

import { execFile } from "child_process";
import { promisify } from "util";
import { readdir } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { EventBroadcaster } from "../../event-broadcaster";

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Lazy engine import — agent-simulator/engine uses import.meta.url which
// fails in CJS. We load it on first use instead of at module load time.
// ---------------------------------------------------------------------------

let _engine: Awaited<typeof import("agent-simulator/engine")> | null = null;
let _executor: any = null;

const SIM_ENV: Record<string, string | undefined> = {
  ...process.env,
  DEVELOPER_DIR: process.env["DEVELOPER_DIR"] ?? "/Applications/Xcode.app/Contents/Developer",
};

async function getEngine() {
  if (!_engine) {
    _engine = await import("agent-simulator/engine");
    _executor = _engine.createExecutor({ env: SIM_ENV });
  }
  return { engine: _engine, executor: _executor };
}

// ---------------------------------------------------------------------------
// Direct sim-helper invocation — bypasses the engine's findHelperPath()
// which breaks in CJS bundles (import.meta.url → undefined → wrong __dirname).
// We resolve the binary ourselves and call it with the same JSON protocol.
// ---------------------------------------------------------------------------

import { existsSync } from "fs";
import { homedir } from "os";
import { dirname } from "path";

let _simHelperPath: string | null | undefined; // undefined = not yet resolved

function resolveSimHelperPath(): string | null {
  if (_simHelperPath !== undefined) return _simHelperPath;

  const candidates = [
    join(process.cwd(), "node_modules/agent-simulator/native/.build/release/sim-helper"),
    "/opt/homebrew/lib/node_modules/agent-simulator/native/.build/release/sim-helper",
    "/usr/local/lib/node_modules/agent-simulator/native/.build/release/sim-helper",
    join(
      homedir(),
      ".bun/install/global/node_modules/agent-simulator/native/.build/release/sim-helper"
    ),
  ];

  for (const c of candidates) {
    if (existsSync(c)) {
      _simHelperPath = c;
      return c;
    }
  }

  _simHelperPath = null;
  return null;
}

async function callSimHelper(request: Record<string, unknown>): Promise<void> {
  const helperPath = resolveSimHelperPath();
  if (!helperPath) {
    throw new Error(
      "sim-helper binary not found. Install agent-simulator or run: cd native && swift build -c release"
    );
  }

  await execFileAsync(helperPath, [JSON.stringify(request)], {
    timeout: 30_000,
    env: SIM_ENV,
    maxBuffer: 10 * 1024 * 1024,
  });
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SimDevice {
  udid: string;
  name: string;
  state: string;
  runtime: string;
  deviceType: string;
  isAvailable: boolean;
}

export interface ScreenshotResult {
  base64: string;
  mimeType: string;
}

export interface BuildResult {
  bundleId: string;
  appName: string;
  appPath: string;
}

export interface ScreenReadResult {
  formatted: string;
  screenshot?: ScreenshotResult;
}

// ---------------------------------------------------------------------------
// Device resolution — find the right UDID for a session
// ---------------------------------------------------------------------------

/**
 * Resolve a simulator UDID for the current session.
 *
 * Priority:
 * 1. Explicit destination (name or UDID) from tool params
 * 2. Backend context lookup (workspace → UDID binding)
 * 3. First booted simulator (convenience fallback)
 */
export async function resolveDevice(destination?: string, sessionId?: string): Promise<string> {
  // 1. Explicit destination
  if (destination) {
    if (/^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/i.test(destination)) {
      return destination;
    }
    const devices = await listDevices();
    const match =
      devices.find((d) => d.name.toLowerCase() === destination.toLowerCase()) ??
      devices.find((d) => d.name.toLowerCase().includes(destination.toLowerCase()));
    if (match) return match.udid;
    throw new Error(`Simulator "${destination}" not found`);
  }

  // 2. Backend context (workspace-specific UDID).
  // When sessionId is present, the session is bound to a workspace — we MUST
  // use that workspace's simulator. Falling back to "first booted" would break
  // per-workspace isolation in multi-simulator scenarios.
  if (sessionId) {
    // Let RPC errors (timeout, disconnect) propagate so the agent sees the
    // real problem. Only a `null` response means "no workspace binding yet".
    const ctx = await EventBroadcaster.requestSimulatorContext({ sessionId });
    if (ctx?.udid) return ctx.udid;
    throw new Error(
      "No simulator assigned to this workspace. Start one via the Simulator panel " +
        "or specify a destination (simulator name or UDID)."
    );
  }

  // 3. No session context — fall back to first booted simulator.
  const devices = await listDevices();
  const booted = devices.find((d) => d.state === "Booted");
  if (booted) return booted.udid;

  throw new Error("No booted simulator found. Boot one first or specify a destination.");
}

// ---------------------------------------------------------------------------
// Device listing
// ---------------------------------------------------------------------------

export async function listDevices(): Promise<SimDevice[]> {
  const { engine, executor } = await getEngine();
  const sims = await engine.listSimulators(executor);
  return sims.map((s: any) => ({
    udid: s.udid,
    name: s.name,
    state: s.state,
    runtime: s.runtime,
    deviceType: s.name.replace(/-/g, " "),
    isAvailable: s.isAvailable,
  }));
}

// ---------------------------------------------------------------------------
// Screenshot
// ---------------------------------------------------------------------------

export async function screenshot(
  udid: string,
  format: "png" | "jpeg" = "jpeg"
): Promise<ScreenshotResult> {
  const { engine, executor } = await getEngine();
  const outputPath = join(tmpdir(), `deus-sim-${udid.slice(0, 8)}-${Date.now()}.${format}`);
  await engine.takeScreenshot(executor, udid, outputPath, { format });

  const { readFile, unlink } = await import("fs/promises");
  const buf = await readFile(outputPath);
  await unlink(outputPath).catch(() => {});

  return {
    base64: buf.toString("base64"),
    mimeType: `image/${format}`,
  };
}

// ---------------------------------------------------------------------------
// Accessibility / screen reading
// ---------------------------------------------------------------------------

export async function readScreen(
  udid: string,
  opts: {
    sessionKey: string;
    filter?: "interactive" | "all";
    includeScreenshot?: boolean;
  }
): Promise<ScreenReadResult> {
  // Fetch accessibility tree via sim-helper directly
  const helperPath = resolveSimHelperPath();
  let formatted = "[accessibility tree unavailable — sim-helper not found]";

  if (helperPath) {
    try {
      const { stdout } = await execFileAsync(
        helperPath,
        [JSON.stringify({ command: "describe-ui", udid })],
        { timeout: 15_000, env: SIM_ENV, maxBuffer: 10 * 1024 * 1024 }
      );
      const result = JSON.parse(stdout);
      // Format the tree as compact text
      if (result.success && result.data?.elements) {
        formatted = result.data.elements
          .map(
            (e: any) =>
              `${e.role ?? ""}${e.label ? ` "${e.label}"` : ""}${e.value ? ` [${e.value}]` : ""} (${Math.round(e.frame?.x ?? 0)},${Math.round(e.frame?.y ?? 0)})`
          )
          .join("\n");
      } else {
        formatted = stdout;
      }
    } catch {
      formatted = "[failed to read accessibility tree]";
    }
  }

  let screenshotData: ScreenshotResult | undefined;
  if (opts.includeScreenshot !== false) {
    screenshotData = await screenshot(udid, "jpeg");
  }

  return { formatted, screenshot: screenshotData };
}

// ---------------------------------------------------------------------------
// Interaction — tap, type, swipe, key, button
// ---------------------------------------------------------------------------

export async function tap(
  udid: string,
  opts: { x?: number; y?: number; label?: string }
): Promise<void> {
  if (typeof opts.label === "string" && opts.label) {
    // Label-based tap: fetch accessibility tree, find element, tap its center
    const { engine } = await getEngine();
    const tree = await engine.fetchAccessibilityTree(udid);
    const el = findInTreeByLabel(tree, opts.label);
    if (!el) throw new Error(`Element with label "${opts.label}" not found`);
    await callSimHelper({ command: "tap", udid, x: el.center.x, y: el.center.y });
  } else if (typeof opts.x === "number" && typeof opts.y === "number") {
    await callSimHelper({ command: "tap", udid, x: opts.x, y: opts.y });
  } else {
    throw new Error("tap requires either (x, y) coordinates or a label");
  }
}

function findInTreeByLabel(nodes: any[], label: string): any | null {
  for (const n of nodes) {
    if (n.label === label) return n;
    if (n.children) {
      const found = findInTreeByLabel(n.children, label);
      if (found) return found;
    }
  }
  return null;
}

export async function typeText(
  udid: string,
  text: string,
  opts?: { submit?: boolean }
): Promise<void> {
  await callSimHelper({ command: "type", udid, text, submit: opts?.submit ?? false });
}

export async function swipe(
  udid: string,
  opts: {
    direction?: "up" | "down" | "left" | "right";
    startX?: number;
    startY?: number;
    endX?: number;
    endY?: number;
    distance?: number;
    duration?: number;
  }
): Promise<void> {
  let sx: number, sy: number, ex: number, ey: number;

  if (opts.direction) {
    const dist = opts.distance ?? 300;
    const cx = 195;
    const cy = 422;
    const vectors: Record<string, [number, number, number, number]> = {
      up: [cx, cy + dist / 2, cx, cy - dist / 2],
      down: [cx, cy - dist / 2, cx, cy + dist / 2],
      left: [cx + dist / 2, cy, cx - dist / 2, cy],
      right: [cx - dist / 2, cy, cx + dist / 2, cy],
    };
    [sx, sy, ex, ey] = vectors[opts.direction]!;
  } else if (opts.startX != null && opts.startY != null && opts.endX != null && opts.endY != null) {
    sx = opts.startX;
    sy = opts.startY;
    ex = opts.endX;
    ey = opts.endY;
  } else {
    throw new Error("swipe requires either direction or start/end coordinates");
  }

  await callSimHelper({
    command: "swipe",
    udid,
    startX: sx,
    startY: sy,
    endX: ex,
    endY: ey,
    ...(opts.duration !== undefined && { duration: opts.duration }),
  });
}

export async function pressKey(udid: string, key: string): Promise<void> {
  if (key === "home") {
    await callSimHelper({ command: "button", udid, button: "home" });
    return;
  }
  const keyMap: Record<string, number> = {
    return: 40,
    delete: 42,
    escape: 41,
    tab: 43,
    space: 44,
  };
  const code = keyMap[key];
  if (code != null) {
    await callSimHelper({ command: "key", udid, keyCode: code });
  } else {
    throw new Error(`Unknown key: ${key}`);
  }
}

// ---------------------------------------------------------------------------
// App lifecycle
// ---------------------------------------------------------------------------

async function install(udid: string, appPath: string): Promise<void> {
  const { engine, executor } = await getEngine();
  await engine.installApp(executor, udid, appPath);
}

export async function launch(udid: string, bundleId: string): Promise<string> {
  const { engine, executor } = await getEngine();
  return await engine.launchApp(executor, udid, bundleId);
}

// ---------------------------------------------------------------------------
// Build (xcodebuild)
// ---------------------------------------------------------------------------

export async function build(
  udid: string,
  opts: { workingDirectory: string; scheme?: string }
): Promise<BuildResult> {
  const cwd = opts.workingDirectory;
  const entries = await readdir(cwd);

  const xcworkspace = entries.find((e) => e.endsWith(".xcworkspace"));
  const xcodeproj = entries.find((e) => e.endsWith(".xcodeproj"));
  const projectArg = xcworkspace
    ? ["-workspace", join(cwd, xcworkspace)]
    : xcodeproj
      ? ["-project", join(cwd, xcodeproj)]
      : null;

  if (!projectArg) throw new Error("No .xcworkspace or .xcodeproj found in " + cwd);

  const schemeName =
    opts.scheme ?? (xcworkspace ?? xcodeproj)!.replace(/\.(xcworkspace|xcodeproj)$/, "");

  const destination = `platform=iOS Simulator,id=${udid}`;
  const derivedData = join(cwd, "build");

  // TODO(build-log-streaming): pipe stdout/stderr line-by-line via
  // EventBroadcaster so the frontend panel can show real-time build progress.
  await execFileAsync(
    "xcodebuild",
    [
      ...projectArg,
      "-scheme",
      schemeName,
      "-destination",
      destination,
      "-derivedDataPath",
      derivedData,
      "build",
    ],
    {
      timeout: 600_000,
      cwd,
      maxBuffer: 50 * 1024 * 1024,
      env: SIM_ENV,
    }
  );

  const { stdout: findOutput } = await execFileAsync("find", [
    derivedData,
    "-name",
    "*.app",
    "-type",
    "d",
    "-maxdepth",
    "6",
  ]);
  const appPath = findOutput.trim().split("\n")[0];
  if (!appPath) throw new Error("Built .app bundle not found");

  let bundleId = "";
  try {
    const { stdout: plistOut } = await execFileAsync("/usr/libexec/PlistBuddy", [
      "-c",
      "Print :CFBundleIdentifier",
      join(appPath, "Info.plist"),
    ]);
    bundleId = plistOut.trim();
  } catch {
    // bundle ID extraction is best-effort
  }

  const appName = appPath.split("/").pop()?.replace(".app", "") ?? "App";
  return { bundleId, appName, appPath };
}

export async function buildAndRun(
  udid: string,
  opts: { workingDirectory: string; scheme?: string }
): Promise<BuildResult> {
  const result = await build(udid, opts);
  await install(udid, result.appPath);
  if (result.bundleId) {
    await launch(udid, result.bundleId);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Wait
// ---------------------------------------------------------------------------

export async function waitFor(
  udid: string,
  opts: {
    time?: number;
    stabilize?: boolean;
    label?: string;
    timeout?: number;
  }
): Promise<{ found: boolean; elapsedMs: number }> {
  if (typeof opts.time === "number") {
    await new Promise((r) => setTimeout(r, opts.time! * 1000));
    return { found: true, elapsedMs: opts.time! * 1000 };
  }

  if (opts.label) {
    // Poll accessibility tree for label appearance
    const start = Date.now();
    const timeoutMs = (opts.timeout ?? 30) * 1000;
    while (Date.now() - start < timeoutMs) {
      const result = await readScreen(udid, {
        sessionKey: "wait",
        filter: "all",
        includeScreenshot: false,
      });
      if (result.formatted.includes(opts.label)) {
        return { found: true, elapsedMs: Date.now() - start };
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    return { found: false, elapsedMs: Date.now() - start };
  }

  if (opts.stabilize) {
    // Compare screenshots until stable
    const start = Date.now();
    const timeoutMs = (opts.timeout ?? 30) * 1000;
    let prevShot = await screenshot(udid, "jpeg");
    while (Date.now() - start < timeoutMs) {
      await new Promise((r) => setTimeout(r, 500));
      const currShot = await screenshot(udid, "jpeg");
      if (currShot.base64 === prevShot.base64) {
        return { found: true, elapsedMs: Date.now() - start };
      }
      prevShot = currShot;
    }
    return { found: false, elapsedMs: Date.now() - start };
  }

  throw new Error("waitFor requires time, stabilize, or label");
}

// ---------------------------------------------------------------------------
// Project info
// ---------------------------------------------------------------------------

export async function getProjectInfo(
  workingDirectory: string
): Promise<{ schemes: string[]; workspace: string | null; project: string | null }> {
  const entries = await readdir(workingDirectory);
  const xcworkspace = entries.find((e) => e.endsWith(".xcworkspace")) ?? null;
  const xcodeproj = entries.find((e) => e.endsWith(".xcodeproj")) ?? null;

  const projectArg = xcworkspace
    ? ["-workspace", join(workingDirectory, xcworkspace)]
    : xcodeproj
      ? ["-project", join(workingDirectory, xcodeproj)]
      : null;

  if (!projectArg) return { schemes: [], workspace: xcworkspace, project: xcodeproj };

  try {
    const { stdout } = await execFileAsync("xcodebuild", [...projectArg, "-list", "-json"], {
      cwd: workingDirectory,
      timeout: 30_000,
      env: SIM_ENV,
    });
    const parsed = JSON.parse(stdout);
    const schemes: string[] = parsed.workspace?.schemes ?? parsed.project?.schemes ?? [];
    return { schemes, workspace: xcworkspace, project: xcodeproj };
  } catch {
    return { schemes: [], workspace: xcworkspace, project: xcodeproj };
  }
}
