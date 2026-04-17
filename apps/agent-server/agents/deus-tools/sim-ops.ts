// agent-server/agents/deus-tools/sim-ops.ts
//
// Pure simulator operations library. Module-level functions wrapping
// device-use/engine + xcodebuild. Every function takes a UDID and
// returns a result — no sessions, no transport awareness.
//
// IMPORTANT: device-use/engine is ESM-only. The agent-server bundles to CJS.
// All imports from device-use/engine MUST be lazy (dynamic import) to avoid
// crashing at module load time.
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
import { dirname, join } from "path";
import { EventBroadcaster } from "../../event-broadcaster";

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Lazy engine import — device-use/engine uses import.meta.url which
// fails in CJS. We load it on first use instead of at module load time.
// ---------------------------------------------------------------------------

let _engine: Awaited<typeof import("device-use/engine")> | null = null;
let _executor: any = null;

const SIM_ENV: Record<string, string | undefined> = {
  ...process.env,
  DEVELOPER_DIR: process.env["DEVELOPER_DIR"] ?? "/Applications/Xcode.app/Contents/Developer",
};

async function getEngine() {
  if (!_engine) {
    _engine = await import("device-use/engine");
    _executor = _engine.createExecutor({ env: SIM_ENV });
  }
  return { engine: _engine, executor: _executor };
}

// ---------------------------------------------------------------------------
// Direct simbridge invocation — bypasses the engine's findBridgePath()
// which uses import.meta.url (fails in CJS bundles). We resolve the binary
// ourselves and call it with the same JSON command protocol.
// ---------------------------------------------------------------------------

import { existsSync } from "fs";

let _simBridgePath: string | null | undefined; // undefined = not yet resolved

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

function resolveSimBridgePath(): string | null {
  if (_simBridgePath !== undefined) return _simBridgePath;

  // 1. Explicit override — set by Electron main when packaged, or by devs.
  const envOverride = process.env["DEVICE_USE_SIMBRIDGE"];
  if (envOverride && existsSync(envOverride)) {
    _simBridgePath = envOverride;
    return envOverride;
  }

  // 2. Packaged Electron app — extraResources drops simbridge here.
  //    resourcesPath is Electron-only, not in NodeJS.Process types.
  const resourcesPath = (process as { resourcesPath?: string }).resourcesPath;
  if (resourcesPath) {
    const packaged = join(resourcesPath, "simulator", "simbridge");
    if (existsSync(packaged)) {
      _simBridgePath = packaged;
      return packaged;
    }
  }

  // 3. Dev mode — walk up from cwd. Agent-server runs with cwd=apps/agent-server,
  //    so plain cwd-relative paths miss the workspace copy.
  const devCandidates = [
    "packages/device-use/bin/simbridge",
    "node_modules/device-use/bin/simbridge",
    "packages/device-use/native/.build/release/simbridge",
    "packages/device-use/native/.build/arm64-apple-macosx/release/simbridge",
  ];

  for (const rel of devCandidates) {
    const found = findUpwards(process.cwd(), rel);
    if (found) {
      _simBridgePath = found;
      return found;
    }
  }

  _simBridgePath = null;
  return null;
}

async function callSimBridge(request: Record<string, unknown>): Promise<void> {
  const bridgePath = resolveSimBridgePath();
  if (!bridgePath) {
    throw new Error(
      "simbridge binary not found. Run `bun install` or `bun run prepare:device-use` in repo root."
    );
  }

  await execFileAsync(bridgePath, [JSON.stringify(request)], {
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

// Ref cache — populated by readScreen, read by tap({ ref }). Lives for the
// whole session so agents can chain `readScreen → tap @e3 → tap @e5` without
// re-reading. New readScreen overwrites (refs are position-sensitive and
// expected to be consumed promptly).
interface RefEntry {
  ref: string;
  center: { x: number; y: number };
  label?: string;
  identifier?: string;
  type?: string;
}
const refCache = new Map<string, Map<string, RefEntry>>();

// Device screen bounds — for off-screen tap validation. Filled lazily and
// reused; doesn't change during a run (ignoring rotation, which is rare).
const screenBoundsCache = new Map<string, { width: number; height: number }>();

function refCacheKey(sessionKey: string | undefined, udid: string): string {
  return `${sessionKey ?? "__no_session__"}:${udid}`;
}

function recordRefs(
  sessionKey: string | undefined,
  udid: string,
  entries: Array<{
    ref: string;
    center: { x: number; y: number };
    label?: string;
    identifier?: string;
    type?: string;
  }>,
  rootFrame?: { width?: number; height?: number }
): void {
  const key = refCacheKey(sessionKey, udid);
  const map = new Map<string, RefEntry>();
  for (const e of entries) {
    map.set(e.ref, {
      ref: e.ref,
      center: e.center,
      label: e.label,
      identifier: e.identifier,
      type: e.type,
    });
  }
  refCache.set(key, map);
  if (rootFrame?.width && rootFrame?.height) {
    screenBoundsCache.set(udid, { width: rootFrame.width, height: rootFrame.height });
  }
}

async function fetchScreenBounds(udid: string): Promise<{ width: number; height: number } | null> {
  const cached = screenBoundsCache.get(udid);
  if (cached) return cached;
  try {
    const { engine } = await getEngine();
    const tree = await engine.fetchAccessibilityTree(udid);
    const app = tree.find((n: any) => n.type === "Application") ?? tree[0];
    if (app?.frame?.width && app?.frame?.height) {
      const bounds = { width: app.frame.width, height: app.frame.height };
      screenBoundsCache.set(udid, bounds);
      return bounds;
    }
  } catch {
    /* tree fetch failed — skip bounds check */
  }
  return null;
}

export async function readScreen(
  udid: string,
  opts: {
    sessionKey: string;
    filter?: "interactive" | "all";
    includeScreenshot?: boolean;
  }
): Promise<ScreenReadResult> {
  // Walks the nested describe-ui tree via device-use's buildSnapshot so
  // interactive nodes get @eN refs the agent can reuse for subsequent taps.
  let formatted = "[accessibility tree unavailable]";

  try {
    const { engine } = await getEngine();
    const tree = await engine.fetchAccessibilityTree(udid);
    const snapshot = engine.buildSnapshot(tree, {
      interactiveOnly: opts.filter !== "all",
    });
    formatted = engine.formatTree(snapshot.tree);
    if (!formatted) {
      formatted = "[no elements matched filter]";
    }
    // Populate ref cache so `tap({ ref: "@e3" })` can resolve coords from
    // the snapshot the agent just saw.
    const rootApp = tree.find((n: any) => n.type === "Application") ?? tree[0];
    recordRefs(opts.sessionKey, udid, snapshot.refs ?? [], rootApp?.frame);
  } catch (err) {
    formatted = `[failed to read accessibility tree: ${err instanceof Error ? err.message : String(err)}]`;
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
  opts: {
    ref?: string;
    identifier?: string;
    label?: string;
    x?: number;
    y?: number;
    sessionKey?: string;
  }
): Promise<void> {
  // Resolution is explicit — we take exactly one selector and fail loudly if
  // it doesn't match. No silent fallback chain (identifier → label → coord)
  // because that hides precision bugs: the agent says "tap NameField" and
  // we'd guess whether that's a ref, an identifier, or a label.

  if (opts.ref) {
    const map = refCache.get(refCacheKey(opts.sessionKey, udid));
    const normalized = opts.ref.startsWith("@") ? opts.ref : `@${opts.ref}`;
    const entry = map?.get(normalized);
    if (!entry) {
      throw new Error(
        `Ref ${normalized} not found. Call SimulatorReadScreen first — refs live only until the next screen read, and must come from its output.`
      );
    }
    await callSimBridge({ command: "tap", udid, x: entry.center.x, y: entry.center.y });
    return;
  }

  if (opts.identifier) {
    const { engine } = await getEngine();
    const tree = await engine.fetchAccessibilityTree(udid);
    const el = findInTreeBy(tree, (n) => n.identifier === opts.identifier);
    if (!el) {
      throw new Error(
        `Element with identifier "${opts.identifier}" not found. Identifiers come from app code (accessibilityIdentifier in SwiftUI, accessibilityIdentifier in UIKit).`
      );
    }
    await callSimBridge({ command: "tap", udid, x: el.center.x, y: el.center.y });
    return;
  }

  if (opts.label) {
    const { engine } = await getEngine();
    const tree = await engine.fetchAccessibilityTree(udid);
    const el = findInTreeBy(tree, (n) => n.label === opts.label);
    if (!el) {
      const available = collectLabels(tree).slice(0, 15);
      const hint = available.length > 0 ? ` Available labels: ${available.join(", ")}.` : "";
      throw new Error(
        `Element with label "${opts.label}" not found. ` +
          `Matches iOS accessibility label, not placeholder/visible text.${hint}`
      );
    }
    await callSimBridge({ command: "tap", udid, x: el.center.x, y: el.center.y });
    return;
  }

  if (typeof opts.x === "number" && typeof opts.y === "number") {
    const bounds = await fetchScreenBounds(udid);
    if (bounds) {
      if (opts.x < 0 || opts.y < 0 || opts.x > bounds.width || opts.y > bounds.height) {
        throw new Error(
          `(${opts.x}, ${opts.y}) is off-screen — device is ${Math.round(bounds.width)}x${Math.round(bounds.height)} logical points.`
        );
      }
    }
    await callSimBridge({ command: "tap", udid, x: opts.x, y: opts.y });
    return;
  }

  throw new Error("tap requires one of: ref, identifier, label, or (x, y) coordinates");
}

function findInTreeBy(nodes: any[], predicate: (n: any) => boolean): any | null {
  for (const n of nodes) {
    if (predicate(n)) return n;
    if (n.children) {
      const found = findInTreeBy(n.children, predicate);
      if (found) return found;
    }
  }
  return null;
}

/** Walk the tree and collect all non-empty labels (for error hints). */
function collectLabels(nodes: any[]): string[] {
  const labels: string[] = [];
  const walk = (list: any[]) => {
    for (const n of list) {
      if (typeof n.label === "string" && n.label.length > 0) labels.push(n.label);
      if (n.children) walk(n.children);
    }
  };
  walk(nodes);
  return [...new Set(labels)];
}

export async function typeText(
  udid: string,
  text: string,
  opts?: { submit?: boolean }
): Promise<void> {
  await callSimBridge({ command: "type", udid, text, submit: opts?.submit ?? false });
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

  await callSimBridge({
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
    await callSimBridge({ command: "button", udid, button: "home" });
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
    await callSimBridge({ command: "key", udid, keyCode: code });
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

export interface SimApp {
  bundleId: string;
  name: string;
  version?: string;
  type: "User" | "System";
}

export async function listApps(
  udid: string,
  opts?: { type?: "User" | "System" | "all" }
): Promise<SimApp[]> {
  const { engine, executor } = await getEngine();
  const apps = await engine.listApps(executor, udid, { type: opts?.type ?? "User" });
  return apps.map((a: any) => ({
    bundleId: a.bundleId,
    name: a.name,
    version: a.version,
    type: a.type,
  }));
}

// ---------------------------------------------------------------------------
// Build (xcodebuild)
// ---------------------------------------------------------------------------

/** Resolve the build scheme: explicit opts.scheme wins, otherwise use the
 *  single shared scheme if the project has exactly one. Multiple schemes
 *  without an explicit choice is an error — don't guess. */
async function resolveScheme(
  cwd: string,
  projectArg: string[],
  explicitScheme: string | undefined
): Promise<string> {
  if (explicitScheme) return explicitScheme;

  const { stdout } = await execFileAsync("xcodebuild", [...projectArg, "-list", "-json"], {
    cwd,
    timeout: 30_000,
    env: SIM_ENV,
  });
  const parsed = JSON.parse(stdout) as {
    workspace?: { schemes?: string[] };
    project?: { schemes?: string[] };
  };
  const schemes = parsed.workspace?.schemes ?? parsed.project?.schemes ?? [];

  if (schemes.length === 1) return schemes[0]!;
  if (schemes.length === 0) throw new Error("No schemes found in Xcode project");
  throw new Error(
    `Multiple schemes found (${schemes.join(", ")}). Specify one via the 'scheme' option.`
  );
}

/** Locate the built .app bundle by querying xcodebuild's build settings
 *  (TARGET_BUILD_DIR + FULL_PRODUCT_NAME). More reliable than `find`,
 *  which can return the wrong .app when multiple targets produce bundles. */
async function resolveBuiltAppPath(
  cwd: string,
  projectArg: string[],
  scheme: string,
  destination: string,
  derivedData: string
): Promise<string> {
  const { stdout } = await execFileAsync(
    "xcodebuild",
    [
      ...projectArg,
      "-scheme",
      scheme,
      "-destination",
      destination,
      "-derivedDataPath",
      derivedData,
      "-showBuildSettings",
      "-json",
    ],
    { cwd, timeout: 60_000, env: SIM_ENV, maxBuffer: 20 * 1024 * 1024 }
  );

  const settings = JSON.parse(stdout) as Array<{
    buildSettings?: Record<string, string>;
  }>;
  const s = settings[0]?.buildSettings ?? {};
  const targetDir = s.TARGET_BUILD_DIR;
  const productName = s.FULL_PRODUCT_NAME;
  if (!targetDir || !productName) {
    throw new Error("Could not determine built .app path from xcodebuild settings");
  }

  const { existsSync } = await import("fs");
  const appPath = join(targetDir, productName);
  if (!existsSync(appPath)) {
    throw new Error(`Built .app bundle not found at ${appPath}`);
  }
  return appPath;
}

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

  const schemeName = await resolveScheme(cwd, projectArg, opts.scheme);
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

  const appPath = await resolveBuiltAppPath(cwd, projectArg, schemeName, destination, derivedData);

  const { stdout: plistOut } = await execFileAsync("/usr/libexec/PlistBuddy", [
    "-c",
    "Print :CFBundleIdentifier",
    join(appPath, "Info.plist"),
  ]).catch((err) => {
    throw new Error(`Failed to extract CFBundleIdentifier from ${appPath}: ${err.message}`);
  });
  const bundleId = plistOut.trim();
  if (!bundleId) throw new Error(`Empty CFBundleIdentifier in ${appPath}/Info.plist`);

  const appName = appPath.split("/").pop()?.replace(".app", "") ?? "App";
  return { bundleId, appName, appPath };
}

export async function buildAndRun(
  udid: string,
  opts: { workingDirectory: string; scheme?: string }
): Promise<BuildResult> {
  const result = await build(udid, opts);
  await install(udid, result.appPath);
  await launch(udid, result.bundleId);
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
  // Max wait: 5 minutes. Prevents runaway waits from unit confusion
  // (e.g., agent passing 1500 thinking ms when the param is seconds).
  const MAX_WAIT_SECONDS = 300;

  if (typeof opts.time === "number") {
    if (opts.time > MAX_WAIT_SECONDS) {
      throw new Error(
        `time=${opts.time}s exceeds max ${MAX_WAIT_SECONDS}s. The 'time' parameter is in seconds — did you mean ${opts.time / 1000}?`
      );
    }
    const ms = Math.max(0, opts.time * 1000);
    await new Promise((r) => setTimeout(r, ms));
    return { found: true, elapsedMs: ms };
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
  let entries: string[];
  try {
    entries = await readdir(workingDirectory);
  } catch (err: any) {
    throw new Error(`Cannot read directory ${workingDirectory}: ${err.message}`);
  }
  const xcworkspace = entries.find((e) => e.endsWith(".xcworkspace")) ?? null;
  const xcodeproj = entries.find((e) => e.endsWith(".xcodeproj")) ?? null;

  if (!xcworkspace && !xcodeproj) {
    throw new Error(
      `No .xcworkspace or .xcodeproj found in ${workingDirectory}. ` +
        `Check the path — the Xcode project may be in a subdirectory (e.g., ${workingDirectory}/ios).`
    );
  }

  const projectArg = xcworkspace
    ? ["-workspace", join(workingDirectory, xcworkspace)]
    : ["-project", join(workingDirectory, xcodeproj!)];

  // Let xcodebuild failures surface — silently returning an empty schemes list
  // hides real errors (malformed project, missing dependencies, etc.)
  const { stdout } = await execFileAsync("xcodebuild", [...projectArg, "-list", "-json"], {
    cwd: workingDirectory,
    timeout: 30_000,
    env: SIM_ENV,
  });
  const parsed = JSON.parse(stdout);
  const schemes: string[] = parsed.workspace?.schemes ?? parsed.project?.schemes ?? [];
  return { schemes, workspace: xcworkspace, project: xcodeproj };
}
