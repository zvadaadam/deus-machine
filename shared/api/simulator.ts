/** Simulators: the local iOS Simulator and the cloud device attached to a workspace. */

import { z } from "zod";
import {
  CloudSimulatorPlatformSchema,
  type CloudSimulatorEvent,
  type CloudSimulatorStatus,
} from "../events";
import type {
  CloudSimulatorExecResult,
  InspectorSnapshot,
  SimulatorCapabilities,
  SimulatorInfo,
} from "../types/simulator";
import { out, read, write } from "./op";
import { stream } from "./stream";

const workspaceId = z.object({ workspaceId: z.string().min(1) });
/** An app on the simulator the workspace is streaming. */
const installedApp = workspaceId.extend({ bundleId: z.string().min(1) });
/** A point on the simulator's screen, each axis from 0 to 1. */
const point = workspaceId.extend({ x: z.number(), y: z.number() });
/** Without a platform: the workspace's default device (start), every running one (stop), the only one (exec). */
const cloudDevice = workspaceId.extend({ platform: CloudSimulatorPlatformSchema.optional() });

// ---- The iOS Simulator on the backend's Mac ----

/** Whether the caller can use the iOS Simulator here, and the reason when it cannot. */
export const simulatorCapabilities = read({
  name: "simulatorCapabilities",
  output: out<SimulatorCapabilities>(),
});

export const simListDevices = read({
  name: "simListDevices",
  output: out<{ devices: SimulatorInfo[] }>(),
});

/** Whether the folder holds an Xcode project that Build & Run could build. */
export const simHasXcodeProject = read({
  name: "simHasXcodeProject",
  input: z.object({ workspacePath: z.string().min(1) }),
  output: out<{ hasProject: boolean }>(),
});

/**
 * Boot a simulator and stream its screen into the workspace. Answers at once;
 * the stream's address arrives as a `streamReady` event on `simulatorEvents`, a failure as `streamFailed`.
 */
export const simStart = write({
  name: "simStart",
  input: workspaceId.extend({
    udid: z.string().min(1),
    /** The device is already booted: skip asking it to boot. */
    skipBootCheck: z.boolean().optional(),
  }),
  output: out<void>(),
});

/** Stop the workspace's stream. The simulator itself stays booted. */
export const simStop = write({ name: "simStop", input: workspaceId, output: out<void>() });

export const simTouch = write({
  name: "simTouch",
  input: point.extend({ touchType: z.enum(["began", "moved", "ended"]).default("began") }),
  output: out<void>(),
});

/** One swipe of `dx`, `dy` wheel pixels starting at the point. */
export const simScroll = write({
  name: "simScroll",
  input: point.extend({ dx: z.number(), dy: z.number() }),
  output: out<void>(),
});

export const simKey = write({
  name: "simKey",
  input: workspaceId.extend({
    /** A USB HID usage code, not a macOS virtual keycode. */
    keycode: z.number(),
    direction: z.enum(["down", "up"]).default("down"),
  }),
  output: out<void>(),
});

/** Press a hardware button, such as `home`. */
export const simButton = write({
  name: "simButton",
  input: workspaceId.extend({ buttonType: z.string().min(1) }),
  output: out<void>(),
});

/** The simulator's screen right now, as the bytes of a JPEG. */
export const simScreenshot = read({
  name: "simScreenshot",
  input: workspaceId,
  output: out<{ bytes: number[] }>(),
});

/**
 * Begin inspecting the screen's elements. With an app (the one named, else the
 * one Build & Run installed) this relaunches it with the inspector attached;
 * with none it falls back to the accessibility tree.
 */
export const simInspectStart = write({
  name: "simInspectStart",
  input: workspaceId.extend({ bundleId: z.string().optional() }),
  output: out<{ snapshot: InspectorSnapshot }>(),
});

/** The elements on screen right now, from whichever source `simInspectStart` set up. */
export const simInspectSnapshot = read({
  name: "simInspectSnapshot",
  input: workspaceId,
  output: out<{ snapshot: InspectorSnapshot }>(),
});

/**
 * Build the folder's Xcode project and run it on the streaming simulator.
 * Answers at once; the build's output arrives as `buildLog` events on `simulatorEvents`, its result as
 * `buildComplete` or `buildFailed`.
 */
export const simBuildAndRun = write({
  name: "simBuildAndRun",
  input: workspaceId.extend({
    workspacePath: z.string().min(1),
    /** Required only when the project has more than one scheme. */
    scheme: z.string().optional(),
  }),
  output: out<void>(),
});

export const simLaunchApp = write({
  name: "simLaunchApp",
  input: installedApp,
  output: out<void>(),
});

export const simTerminateApp = write({
  name: "simTerminateApp",
  input: installedApp,
  output: out<void>(),
});

export const simUninstallApp = write({
  name: "simUninstallApp",
  input: installedApp,
  output: out<void>(),
});

// ---- The cloud device on a workspace's sandbox ----

/** The workspace's cloud device as the platform reports it now; null when it knows of none. */
export const cloudSimulator = read({
  name: "cloudSimulator",
  input: workspaceId,
  output: out<CloudSimulatorStatus | null>(),
});

/**
 * Ask the sandbox to boot a device. The answer only says the sandbox was
 * reached; the device's progress arrives as `cloudSimulatorEvents` status events.
 */
export const cloudSimStart = write({
  name: "cloudSimStart",
  input: cloudDevice,
  output: out<void>(),
});

/** Ask the sandbox to stop a device; like starting, the outcome arrives as events. */
export const cloudSimStop = write({
  name: "cloudSimStop",
  input: cloudDevice,
  output: out<void>(),
});

/**
 * Do one thing on the cloud device (`press`, `fill`, `home`, `screenshot`, …).
 * Any verb counts as activity for the platform's idle stop. A screenshot's
 * image arrives as a `cloudSimulatorEvents` event, not in the answer.
 */
export const cloudSimExec = write({
  name: "cloudSimExec",
  input: cloudDevice.extend({ verb: z.string().min(1), args: z.array(z.string()).optional() }),
  output: out<CloudSimulatorExecResult>(),
});

export type SimulatorEvent =
  | { type: "streamReady"; url: string; port: number; hidAvailable: boolean }
  | { type: "streamFailed"; error: string }
  | { type: "buildLog"; line: string }
  | { type: "buildComplete"; bundleId: string; appName: string; appPath: string }
  | { type: "buildFailed"; error: string };

/** A workspace's local simulator: its stream starting and stopping, and a build's progress. */
export const simulatorEvents = stream({
  name: "simulatorEvents",
  scope: z.object({ workspaceId: z.string() }),
  event: out<SimulatorEvent>(),
});

/** A workspace's cloud device: its status, screenshots and the results of actions on it. */
export const cloudSimulatorEvents = stream({
  name: "cloudSimulatorEvents",
  scope: z.object({ workspaceId: z.string() }),
  event: out<CloudSimulatorEvent>(),
});
