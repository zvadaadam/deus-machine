// Unified tool definitions — one registry used by both the MCP server
// and the REST routes. Each tool has: name, description, a Zod input
// schema, and a handler that takes Context + params and returns a result.
//
// The invoker in invoker.ts wraps every call with tool-event emission.

import { mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { z } from "zod";
import {
  bootSimulator,
  createExecutor,
  fetchAccessibilityTree,
  findInTree,
  formatTree,
  getAppState,
  installApp,
  launchApp,
  listApps as engineListApps,
  listSimulators,
  openUrl,
  pressButton,
  setPermission,
  swipe as engineSwipe,
  takeScreenshot,
  tap as engineTap,
  terminateApp,
  typeText,
  waitFor,
  buildSnapshot,
  RefMap,
  getProjectInfo,
  build as engineBuild,
  resolveAppPath,
  streamLogs,
} from "../engine/index.js";
import type { CommandExecutor, PermissionAction, PermissionService } from "../engine/index.js";
import type { StateStore } from "./state.js";
import type { StreamManager } from "./stream.js";
import type { EventBus } from "./events.js";

export interface Context {
  executor: CommandExecutor;
  state: StateStore;
  stream: StreamManager;
  events: EventBus;
  /** In-memory ref-map for the most recent snapshot. */
  refMap: RefMap;
}

export function createContext(overrides: {
  state: StateStore;
  stream: StreamManager;
  events: EventBus;
  executor?: CommandExecutor;
  refMap?: RefMap;
}): Context {
  return {
    executor: overrides.executor ?? createExecutor(),
    refMap: overrides.refMap ?? new RefMap(),
    state: overrides.state,
    stream: overrides.stream,
    events: overrides.events,
  };
}

// ------------------------------- Types -----------------------------------

export interface ToolDefinition {
  name: string;
  description: string;
  schema: z.ZodTypeAny;
  handler: (ctx: Context, params: any) => Promise<unknown>;
}

function tool<S extends z.ZodTypeAny>(def: {
  name: string;
  description: string;
  schema: S;
  handler: (ctx: Context, params: z.infer<S>) => Promise<unknown>;
}): ToolDefinition {
  return def as ToolDefinition;
}

async function resolveUdid(ctx: Context, udid?: string): Promise<string> {
  if (udid) return udid;
  const pinned = ctx.state.get().simulator?.udid;
  if (pinned) return pinned;
  const sims = await listSimulators(ctx.executor, { booted: true });
  if (sims.length === 1 && sims[0]?.udid) return sims[0].udid;
  throw new Error(
    "No simulator specified. Pass `udid`, pin one via set_active_simulator, or have exactly one booted."
  );
}

// ------------------------------- Tools -----------------------------------

const list_devices = tool({
  name: "list_devices",
  description: "List available iOS simulators with their state (Booted/Shutdown) and runtime.",
  schema: z.object({ bootedOnly: z.boolean().optional() }),
  handler: async (ctx, params) => {
    const sims = await listSimulators(ctx.executor, { booted: params.bootedOnly ?? false });
    return { devices: sims };
  },
});

const boot = tool({
  name: "boot",
  description: "Boot an iOS simulator by UDID. No-op if already booted.",
  schema: z.object({ udid: z.string() }),
  handler: async (ctx, params) => {
    await bootSimulator(ctx.executor, params.udid);
    return { ok: true, udid: params.udid };
  },
});

const set_active_simulator = tool({
  name: "set_active_simulator",
  description:
    "Pin a simulator UDID as the workspace default. Future tool calls without an explicit udid will use this one.",
  schema: z.object({ udid: z.string() }),
  handler: async (ctx, params) => {
    await ctx.state.update({ simulator: { udid: params.udid } });
    return { ok: true, udid: params.udid };
  },
});

const set_active_project = tool({
  name: "set_active_project",
  description:
    "Pin the active Xcode project (path + scheme) for this workspace. Used by build/run when params are omitted.",
  schema: z.object({
    path: z.string(),
    scheme: z.string().optional(),
    configuration: z.string().optional(),
  }),
  handler: async (ctx, params) => {
    await ctx.state.update({ project: params });
    return { ok: true, project: params };
  },
});

const get_project_info = tool({
  name: "get_project_info",
  description: "List schemes / targets / configurations for an .xcodeproj or .xcworkspace.",
  schema: z.object({ path: z.string() }),
  handler: async (ctx, params) => getProjectInfo(ctx.executor, params.path),
});

const buildTool = tool({
  name: "build",
  description: "Build an Xcode project/scheme for the iOS simulator destination.",
  schema: z.object({
    project: z.string().optional(),
    scheme: z.string().optional(),
    udid: z.string().optional(),
    configuration: z.string().optional(),
  }),
  handler: async (ctx, params) => {
    const projectPath = params.project ?? ctx.state.get().project?.path;
    const scheme = params.scheme ?? ctx.state.get().project?.scheme;
    if (!projectPath)
      throw new Error("project path is required (pass project or set_active_project).");
    if (!scheme)
      throw new Error("scheme is required (pass scheme or set_active_project with scheme).");
    const udid = await resolveUdid(ctx, params.udid);
    const destination = `platform=iOS Simulator,id=${udid}`;
    const configuration = params.configuration ?? ctx.state.get().project?.configuration ?? "Debug";

    const logId = ctx.events.newId();
    const result = await engineBuild({
      project: projectPath,
      scheme,
      destination,
      configuration,
      onLog: (line, stream) => ctx.events.emit({ type: "tool-log", id: logId, stream, text: line }),
    });
    if (!result.success) {
      throw new Error(
        `xcodebuild failed (exit ${result.exitCode}):\n${result.stderrTail.split("\n").slice(-20).join("\n")}`
      );
    }
    return { success: true, exitCode: result.exitCode, scheme, configuration, udid };
  },
});

const install = tool({
  name: "install",
  description: "Install a .app bundle onto a booted simulator.",
  schema: z.object({ appPath: z.string(), udid: z.string().optional() }),
  handler: async (ctx, params) => {
    const udid = await resolveUdid(ctx, params.udid);
    await installApp(ctx.executor, udid, params.appPath);
    return { ok: true, udid, appPath: params.appPath };
  },
});

/**
 * Composite: build → resolve .app path → install → launch.
 * This is the "▶ Run" button behind the scenes. Agent can invoke directly
 * when it knows the project + scheme; or call the three steps separately
 * if it wants intermediate visibility.
 */
const run = tool({
  name: "run",
  description:
    "Composite: build → install → launch. Requires project + scheme (pass explicitly or set via set_active_project) and a pinned/booted simulator.",
  schema: z.object({
    project: z.string().optional(),
    scheme: z.string().optional(),
    udid: z.string().optional(),
    configuration: z.string().optional(),
    bundleId: z.string().optional(),
  }),
  handler: async (ctx, params) => {
    const projectPath = params.project ?? ctx.state.get().project?.path;
    const scheme = params.scheme ?? ctx.state.get().project?.scheme;
    if (!projectPath) throw new Error("project path is required");
    if (!scheme) throw new Error("scheme is required");
    const udid = await resolveUdid(ctx, params.udid);
    const destination = `platform=iOS Simulator,id=${udid}`;
    const configuration = params.configuration ?? ctx.state.get().project?.configuration ?? "Debug";

    // 1. build
    const logId = ctx.events.newId();
    const buildResult = await engineBuild({
      project: projectPath,
      scheme,
      destination,
      configuration,
      onLog: (line, stream) => ctx.events.emit({ type: "tool-log", id: logId, stream, text: line }),
    });
    if (!buildResult.success) {
      throw new Error(
        `build failed (exit ${buildResult.exitCode}):\n${buildResult.stderrTail.split("\n").slice(-20).join("\n")}`
      );
    }

    // 2. resolve app path via -showBuildSettings (handles default DerivedData)
    const appPath = await resolveAppPath(
      { project: projectPath, scheme, destination, configuration },
      ctx.executor
    );
    if (!appPath) {
      throw new Error("build succeeded but could not locate the built .app bundle");
    }

    // 3. install
    await installApp(ctx.executor, udid, appPath);

    // 4. launch — resolve bundleId from Info.plist if not given
    let bundleId = params.bundleId;
    if (!bundleId) {
      const plistResult = await ctx.executor([
        "defaults",
        "read",
        `${appPath}/Info.plist`,
        "CFBundleIdentifier",
      ]);
      if (!plistResult.success) {
        throw new Error(
          "could not read CFBundleIdentifier from Info.plist; pass bundleId explicitly"
        );
      }
      bundleId = plistResult.output.trim();
    }
    const pid = await launchApp(ctx.executor, udid, bundleId);

    return {
      success: true,
      udid,
      scheme,
      configuration,
      appPath,
      bundleId,
      pid,
    };
  },
});

const launch_app = tool({
  name: "launch_app",
  description: "Launch an installed app on the booted simulator by bundle identifier.",
  schema: z.object({ bundleId: z.string(), udid: z.string().optional() }),
  handler: async (ctx, params) => {
    const udid = await resolveUdid(ctx, params.udid);
    const pid = await launchApp(ctx.executor, udid, params.bundleId);
    return { ok: true, udid, bundleId: params.bundleId, pid };
  },
});

const terminate_app = tool({
  name: "terminate_app",
  description: "Terminate a running app on the simulator.",
  schema: z.object({ bundleId: z.string(), udid: z.string().optional() }),
  handler: async (ctx, params) => {
    const udid = await resolveUdid(ctx, params.udid);
    await terminateApp(ctx.executor, udid, params.bundleId);
    return { ok: true };
  },
});

const list_apps = tool({
  name: "list_apps",
  description: "List apps installed on the simulator (user + system).",
  schema: z.object({ udid: z.string().optional() }),
  handler: async (ctx, params) => {
    const udid = await resolveUdid(ctx, params.udid);
    const apps = await engineListApps(ctx.executor, udid);
    return { apps };
  },
});

const app_state = tool({
  name: "app_state",
  description: "Get the current running state of an app on the simulator.",
  schema: z.object({ bundleId: z.string(), udid: z.string().optional() }),
  handler: async (ctx, params) => {
    const udid = await resolveUdid(ctx, params.udid);
    const state = await getAppState(ctx.executor, udid, params.bundleId);
    return { state };
  },
});

const snapshot = tool({
  name: "snapshot",
  description:
    "Fetch the accessibility tree of the foreground app. Assigns @eN refs to interactive elements.",
  schema: z.object({
    interactiveOnly: z.boolean().optional(),
    format: z.enum(["tree", "compact", "json"]).optional(),
    udid: z.string().optional(),
  }),
  handler: async (ctx, params) => {
    const udid = await resolveUdid(ctx, params.udid);
    const nodes = await fetchAccessibilityTree(udid);
    ctx.refMap = new RefMap();
    const snap = buildSnapshot(nodes, {
      refMap: ctx.refMap,
      interactiveOnly: params.interactiveOnly ?? true,
    });
    const format = params.format ?? "compact";
    let rendered: string | undefined;
    if (format === "tree" || format === "compact") rendered = formatTree(snap.tree);
    return {
      counts: snap.counts,
      refs: snap.refs,
      tree: format === "json" ? snap.tree : undefined,
      rendered,
    };
  },
});

const tap = tool({
  name: "tap",
  description: "Tap an element by @ref (from snapshot) or absolute coordinates.",
  schema: z.object({
    ref: z.string().optional(),
    x: z.number().optional(),
    y: z.number().optional(),
    label: z.string().optional(),
    udid: z.string().optional(),
  }),
  handler: async (ctx, params) => {
    const udid = await resolveUdid(ctx, params.udid);
    if (params.ref) {
      const entry = ctx.refMap.resolve(params.ref);
      if (!entry) throw new Error(`ref ${params.ref} not found — call snapshot first`);
      await engineTap(udid, entry.center.x, entry.center.y);
      return { ok: true, via: "ref", ref: params.ref };
    }
    if (typeof params.x === "number" && typeof params.y === "number") {
      await engineTap(udid, params.x, params.y);
      return { ok: true, via: "coords" };
    }
    if (params.label) {
      const nodes = await fetchAccessibilityTree(udid);
      const found = findInTree(nodes, (n) => n.label === params.label);
      if (!found) throw new Error(`element with label "${params.label}" not found`);
      await engineTap(udid, found.center.x, found.center.y);
      return { ok: true, via: "label" };
    }
    throw new Error("tap requires `ref`, `x`+`y`, or `label`");
  },
});

const type_text = tool({
  name: "type_text",
  description: "Type text into the currently-focused input. No targeting required.",
  schema: z.object({
    text: z.string(),
    submit: z.boolean().optional(),
    udid: z.string().optional(),
  }),
  handler: async (ctx, params) => {
    const udid = await resolveUdid(ctx, params.udid);
    await typeText(udid, params.text, params.submit);
    return { ok: true };
  },
});

const swipe = tool({
  name: "swipe",
  description: "Drag from one point to another on the simulator screen.",
  schema: z.object({
    fromX: z.number(),
    fromY: z.number(),
    toX: z.number(),
    toY: z.number(),
    durationMs: z.number().optional(),
    udid: z.string().optional(),
  }),
  handler: async (ctx, params) => {
    const udid = await resolveUdid(ctx, params.udid);
    await engineSwipe(udid, params.fromX, params.fromY, params.toX, params.toY, params.durationMs);
    return { ok: true };
  },
});

const press_button = tool({
  name: "press_button",
  description: "Press a simulator hardware button: home, lock, volumeup, volumedown, siri.",
  schema: z.object({
    button: z.enum(["home", "lock", "volumeup", "volumedown", "siri"]),
    udid: z.string().optional(),
  }),
  handler: async (ctx, params) => {
    const udid = await resolveUdid(ctx, params.udid);
    await pressButton(udid, params.button);
    return { ok: true };
  },
});

const screenshot = tool({
  name: "screenshot",
  description: "Capture a screenshot of the booted simulator as base64-encoded image data.",
  schema: z.object({ format: z.enum(["png", "jpeg"]).optional(), udid: z.string().optional() }),
  handler: async (ctx, params) => {
    const udid = await resolveUdid(ctx, params.udid);
    const format = params.format ?? "jpeg";
    const dir = await mkdtemp(path.join(tmpdir(), "device-use-shot-"));
    const file = path.join(dir, `shot.${format}`);
    try {
      await takeScreenshot(ctx.executor, udid, file, { format });
      const buffer = await readFile(file);
      return {
        mimeType: format === "png" ? "image/png" : "image/jpeg",
        base64: buffer.toString("base64"),
      };
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  },
});

const wait_for = tool({
  name: "wait_for",
  description:
    "Wait for an element (by label, identifier, or type) to appear. Timeouts return failure.",
  schema: z.object({
    label: z.string().optional(),
    identifier: z.string().optional(),
    elementType: z.string().optional(),
    timeoutMs: z.number().optional(),
    udid: z.string().optional(),
  }),
  handler: async (ctx, params) => {
    const udid = await resolveUdid(ctx, params.udid);
    const predicate = (n: any) =>
      (params.label ? n.label === params.label : true) &&
      (params.identifier ? n.identifier === params.identifier : true) &&
      (params.elementType ? n.type === params.elementType : true);
    const res = await waitFor(udid, predicate, { timeoutMs: params.timeoutMs ?? 5000 });
    return res;
  },
});

const open_url = tool({
  name: "open_url",
  description: "Open a URL on the simulator (deep link or universal link).",
  schema: z.object({ url: z.string(), udid: z.string().optional() }),
  handler: async (ctx, params) => {
    const udid = await resolveUdid(ctx, params.udid);
    await openUrl(ctx.executor, udid, params.url);
    return { ok: true };
  },
});

const grant_permission = tool({
  name: "grant_permission",
  description:
    "Grant, revoke, or reset a permission for an app. Services: location, photos, contacts, camera, microphone, calendar, etc.",
  schema: z.object({
    bundleId: z.string(),
    service: z.string(),
    action: z.enum(["grant", "revoke", "reset"]),
    udid: z.string().optional(),
  }),
  handler: async (ctx, params) => {
    const udid = await resolveUdid(ctx, params.udid);
    await setPermission(
      ctx.executor,
      udid,
      params.action as PermissionAction,
      params.service as PermissionService,
      params.bundleId
    );
    return { ok: true };
  },
});

const stream_logs = tool({
  name: "stream_logs",
  description:
    "Stream simulator logs for a bundle id. Returns a subscription id; lines are emitted as tool-log events. Call stop_logs to stop.",
  schema: z.object({ bundleId: z.string().optional(), udid: z.string().optional() }),
  handler: async (ctx, params) => {
    const udid = await resolveUdid(ctx, params.udid);
    const id = ctx.events.newId();
    const handle = streamLogs({
      udid,
      ...(params.bundleId ? { bundleId: params.bundleId } : {}),
      onLine: (line) => ctx.events.emit({ type: "tool-log", id, stream: "stdout", text: line }),
    });
    // Park the handle on the event bus so stop_logs can find it.
    const bus = ctx.events as unknown as { _logHandles?: Map<string, { stop: () => void }> };
    bus._logHandles ??= new Map();
    bus._logHandles.set(id, handle);
    return { subscriptionId: id };
  },
});

const stop_logs = tool({
  name: "stop_logs",
  description: "Stop a log stream started by stream_logs.",
  schema: z.object({ subscriptionId: z.string() }),
  handler: async (ctx, params) => {
    const bus = ctx.events as unknown as { _logHandles?: Map<string, { stop: () => void }> };
    const map = bus._logHandles;
    const h = map?.get(params.subscriptionId);
    if (!h) throw new Error(`no log stream with id ${params.subscriptionId}`);
    h.stop();
    map!.delete(params.subscriptionId);
    return { ok: true };
  },
});

const get_state = tool({
  name: "get_state",
  description: "Read the persisted server state: pinned simulator, pinned project/scheme.",
  schema: z.object({}),
  handler: async (ctx) => ctx.state.get(),
});

// ------------------------------- Registry --------------------------------

export const TOOLS: ToolDefinition[] = [
  list_devices,
  boot,
  set_active_simulator,
  set_active_project,
  get_project_info,
  buildTool,
  install,
  run,
  launch_app,
  terminate_app,
  list_apps,
  app_state,
  snapshot,
  tap,
  type_text,
  swipe,
  press_button,
  screenshot,
  wait_for,
  open_url,
  grant_permission,
  stream_logs,
  stop_logs,
  get_state,
];

export function findTool(name: string): ToolDefinition | undefined {
  return TOOLS.find((t) => t.name === name);
}
