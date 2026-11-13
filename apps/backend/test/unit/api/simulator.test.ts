import { beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "@shared/api/simulator";
import { isOp } from "@shared/api/op";
import { operations, published } from "../../helpers";

// The simulator operations through the real handlers, with the Mac's simulator
// service, the cloud driver and the stream hub replaced: what each handler
// asks of them, and what the clients following a workspace's simulator are told.

const sim = vi.hoisted(() => ({
  getSimulatorCapabilities: vi.fn(),
  listDevices: vi.fn(),
  hasXcodeProject: vi.fn(),
  startStream: vi.fn(),
  stopStream: vi.fn(),
  sendTouch: vi.fn(),
  sendScroll: vi.fn(),
  sendKey: vi.fn(),
  sendButton: vi.fn(),
  takeScreenshot: vi.fn(),
  startInspector: vi.fn(),
  inspectorSnapshot: vi.fn(),
  buildAndRun: vi.fn(),
  getContextForWorkspace: vi.fn(),
}));
vi.mock("../../../src/services/simulator-context", () => sim);

const cloud = vi.hoisted(() => ({
  execCloudSimulator: vi.fn(),
  getCloudSimulatorStatus: vi.fn(),
  startCloudSimulator: vi.fn(),
  stopCloudSimulator: vi.fn(),
}));
vi.mock("../../../src/services/agent/cloud/driver", () => cloud);

const mockPublish = vi.hoisted(() => vi.fn());
vi.mock("../../../src/services/streams", () => ({ publish: mockPublish }));

const execFile = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({ execFile }));

import handlers from "../../../src/api/simulator";

const run = operations(handlers);
const overRelay = operations(handlers, { deviceId: "phone", relayed: true });

const WS = { workspaceId: "ws-1" };
const SNAPSHOT = { bundleId: "com.example.app", pid: 7, timestamp: 1, roots: [] };
const RELAY_REASON = "iOS Simulator streaming is unavailable over remote relay in this build.";

/**
 * What was published on `simulatorEvents` so far, each with the workspace
 * whose clients receive it, and that nothing went out on any other stream.
 */
const events = () => {
  const sent = published(mockPublish, api.simulatorEvents);
  expect(sent).toHaveLength(mockPublish.mock.calls.length);
  return sent;
};
/** Let a rejection the handler did not wait for reach its catch. */
const settle = () => new Promise((resolve) => setImmediate(resolve));

beforeEach(() => {
  vi.resetAllMocks();
  sim.getSimulatorCapabilities.mockImplementation(({ relayClient }: { relayClient?: boolean }) =>
    relayClient
      ? { available: false, unavailableReason: RELAY_REASON }
      : { available: true, unavailableReason: null }
  );
  sim.startStream.mockResolvedValue(undefined);
  sim.buildAndRun.mockResolvedValue({ bundle_id: "b", name: "n", app_path: "/p" });
  sim.getContextForWorkspace.mockReturnValue({ udid: "UDID-1", streaming: true });
  execFile.mockImplementation(
    (_file: string, _args: string[], done: (err: Error | null, out: unknown) => void) =>
      done(null, { stdout: "", stderr: "" })
  );
});

describe("which simulator operations are reads", () => {
  it("answers every declared operation, each as the kind its effect makes it", () => {
    const kinds = Object.fromEntries(handlers.map(({ op }) => [op.name, op.kind]));
    expect(kinds).toEqual({
      // Ask as often as you like: nothing on the Mac or the device changes.
      simulatorCapabilities: "read",
      simListDevices: "read",
      simHasXcodeProject: "read",
      simScreenshot: "read",
      simInspectSnapshot: "read",
      cloudSimulator: "read",
      // Start, stop or act on something: sent once, never repeated.
      simStart: "write",
      simStop: "write",
      simTouch: "write",
      simScroll: "write",
      simKey: "write",
      simButton: "write",
      simInspectStart: "write",
      simBuildAndRun: "write",
      simLaunchApp: "write",
      simTerminateApp: "write",
      simUninstallApp: "write",
      cloudSimStart: "write",
      cloudSimStop: "write",
      cloudSimExec: "write",
    });
    expect(handlers).toHaveLength(Object.values(api).filter(isOp).length);
  });
});

describe("simulator capabilities", () => {
  it("answers for this computer's own window", async () => {
    await expect(run(api.simulatorCapabilities)).resolves.toEqual({
      available: true,
      unavailableReason: null,
    });
    expect(sim.getSimulatorCapabilities).toHaveBeenCalledWith({ relayClient: false });
  });

  it("tells the service when the caller came through the relay", async () => {
    await expect(overRelay(api.simulatorCapabilities)).resolves.toEqual({
      available: false,
      unavailableReason: RELAY_REASON,
    });
    expect(sim.getSimulatorCapabilities).toHaveBeenCalledWith({ relayClient: true });
  });
});

describe("the local simulator's reads", () => {
  it("lists the devices", async () => {
    const devices = [
      {
        name: "iPhone 17",
        udid: "UDID-1",
        state: "Booted",
        runtime: "iOS 26.0",
        device_type: "iPhone 17",
        is_available: true,
      },
    ];
    sim.listDevices.mockResolvedValue(devices);
    await expect(run(api.simListDevices)).resolves.toEqual({ devices });
  });

  it("says whether a folder holds an Xcode project", async () => {
    sim.hasXcodeProject.mockResolvedValue(true);
    await expect(run(api.simHasXcodeProject, { workspacePath: "/repo/ws" })).resolves.toEqual({
      hasProject: true,
    });
    expect(sim.hasXcodeProject).toHaveBeenCalledWith("/repo/ws");
    await expect(run(api.simHasXcodeProject, {} as never)).rejects.toMatchObject({
      statusCode: 400,
      message: "simHasXcodeProject requires workspacePath",
    });
  });

  it("returns a screenshot's bytes, and the service's refusal when nothing is streaming", async () => {
    sim.takeScreenshot.mockResolvedValueOnce([255, 216, 255]);
    await expect(run(api.simScreenshot, WS)).resolves.toEqual({ bytes: [255, 216, 255] });
    sim.takeScreenshot.mockRejectedValueOnce(new Error("No active simulator session"));
    await expect(run(api.simScreenshot, WS)).rejects.toThrow("No active simulator session");
  });

  it("returns the current inspector snapshot", async () => {
    sim.inspectorSnapshot.mockResolvedValue(SNAPSHOT);
    await expect(run(api.simInspectSnapshot, WS)).resolves.toEqual({ snapshot: SNAPSHOT });
    expect(sim.inspectorSnapshot).toHaveBeenCalledWith("ws-1");
  });
});

describe("starting and stopping a stream", () => {
  it("refuses a relayed caller before any stream is started", async () => {
    await expect(overRelay(api.simStart, { ...WS, udid: "sim-1" })).rejects.toThrow("remote relay");
    expect(sim.getSimulatorCapabilities).toHaveBeenCalledWith({ relayClient: true });
    expect(sim.startStream).not.toHaveBeenCalled();
  });

  it("answers before the simulator has booted", async () => {
    sim.startStream.mockReturnValue(new Promise(() => {}));
    await expect(run(api.simStart, { ...WS, udid: "sim-1" })).resolves.toBeUndefined();
    expect(sim.startStream).toHaveBeenCalledWith("ws-1", "sim-1", undefined);
    expect(mockPublish).not.toHaveBeenCalled();
  });

  it("passes skipBootCheck through, and tells the clients following that workspace's simulator of a later failure", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    sim.startStream.mockRejectedValue(new Error("Failed to boot simulator: no such device"));
    await run(api.simStart, { ...WS, udid: "sim-1", skipBootCheck: true });
    expect(sim.startStream).toHaveBeenCalledWith("ws-1", "sim-1", true);
    await settle();
    expect(events()).toEqual([
      {
        scope: { workspaceId: "ws-1" },
        event: { type: "streamFailed", error: "Failed to boot simulator: no such device" },
      },
    ]);
  });

  it("publishes each workspace's failed start under its own scope", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    sim.startStream.mockImplementation(async (workspaceId: string) => {
      throw new Error(`no device for ${workspaceId}`);
    });
    await run(api.simStart, { workspaceId: "ws-1", udid: "sim-1" });
    await run(api.simStart, { workspaceId: "ws-2", udid: "sim-2" });
    await settle();
    // The panel of ws-2 never hears that ws-1's simulator failed, nor the reverse.
    expect(events()).toEqual([
      {
        scope: { workspaceId: "ws-1" },
        event: { type: "streamFailed", error: "no device for ws-1" },
      },
      {
        scope: { workspaceId: "ws-2" },
        event: { type: "streamFailed", error: "no device for ws-2" },
      },
    ]);
  });

  it("stops the workspace's stream", async () => {
    await expect(run(api.simStop, WS)).resolves.toBeUndefined();
    expect(sim.stopStream).toHaveBeenCalledWith("ws-1");
  });
});

describe("input sent to the simulator", () => {
  it("forwards a touch, a first one by default", async () => {
    await run(api.simTouch, { ...WS, x: 0.25, y: 0.5 });
    expect(sim.sendTouch).toHaveBeenLastCalledWith("ws-1", 0.25, 0.5, "began");
    await run(api.simTouch, { ...WS, x: 0.3, y: 0.5, touchType: "moved" });
    expect(sim.sendTouch).toHaveBeenLastCalledWith("ws-1", 0.3, 0.5, "moved");
  });

  it("refuses a touch without numeric coordinates or with an unknown phase", async () => {
    await expect(run(api.simTouch, { ...WS, x: 0.25 } as never)).rejects.toMatchObject({
      statusCode: 400,
      message: "simTouch requires y",
    });
    await expect(run(api.simTouch, { ...WS, x: "0.25", y: 0.5 } as never)).rejects.toMatchObject({
      statusCode: 400,
    });
    await expect(
      run(api.simTouch, { ...WS, x: 0.25, y: 0.5, touchType: "hover" } as never)
    ).rejects.toMatchObject({ statusCode: 400 });
    expect(sim.sendTouch).not.toHaveBeenCalled();
  });

  it("tells a client when there is no HID connection to carry the touch", async () => {
    sim.sendTouch.mockImplementation(() => {
      throw new Error("No HID connection available");
    });
    await expect(run(api.simTouch, { ...WS, x: 0.25, y: 0.5 })).rejects.toThrow(
      "No HID connection available"
    );
  });

  it("forwards a scroll with its distance", async () => {
    await run(api.simScroll, { ...WS, x: 0.5, y: 0.5, dx: 0, dy: -120 });
    expect(sim.sendScroll).toHaveBeenCalledWith("ws-1", 0.5, 0.5, 0, -120);
    await expect(run(api.simScroll, { ...WS, x: 0.5, y: 0.5, dx: 0 } as never)).rejects.toThrow(
      "simScroll requires dy"
    );
  });

  it("forwards a key, pressed down by default", async () => {
    await run(api.simKey, { ...WS, keycode: 4 });
    expect(sim.sendKey).toHaveBeenLastCalledWith("ws-1", 4, "down");
    await run(api.simKey, { ...WS, keycode: 4, direction: "up" });
    expect(sim.sendKey).toHaveBeenLastCalledWith("ws-1", 4, "up");
    await expect(run(api.simKey, WS as never)).rejects.toThrow("simKey requires keycode");
  });

  it("forwards a hardware button", async () => {
    await run(api.simButton, { ...WS, buttonType: "home" });
    expect(sim.sendButton).toHaveBeenCalledWith("ws-1", "home");
    await expect(run(api.simButton, WS as never)).rejects.toThrow("simButton requires buttonType");
  });
});

describe("inspecting", () => {
  it("starts with the named app, or with whatever the session knows", async () => {
    sim.startInspector.mockResolvedValue(SNAPSHOT);
    await expect(run(api.simInspectStart, { ...WS, bundleId: "com.example.app" })).resolves.toEqual(
      { snapshot: SNAPSHOT }
    );
    expect(sim.startInspector).toHaveBeenLastCalledWith("ws-1", "com.example.app");
    await run(api.simInspectStart, WS);
    expect(sim.startInspector).toHaveBeenLastCalledWith("ws-1", undefined);
  });
});

describe("build and run", () => {
  it("answers before the build ends and names the scheme when one is given", async () => {
    sim.buildAndRun.mockReturnValue(new Promise(() => {}));
    await expect(
      run(api.simBuildAndRun, { ...WS, workspacePath: "/repo/ws", scheme: "App" })
    ).resolves.toBeUndefined();
    expect(sim.buildAndRun).toHaveBeenCalledWith("ws-1", "/repo/ws", "App");
    expect(mockPublish).not.toHaveBeenCalled();
  });

  it("tells the clients following that workspace's simulator of a failed build", async () => {
    sim.buildAndRun.mockRejectedValue(new Error("xcodebuild exited with code 65"));
    await run(api.simBuildAndRun, { ...WS, workspacePath: "/repo/ws" });
    expect(sim.buildAndRun).toHaveBeenCalledWith("ws-1", "/repo/ws", undefined);
    await settle();
    expect(events()).toEqual([
      {
        scope: { workspaceId: "ws-1" },
        event: { type: "buildFailed", error: "xcodebuild exited with code 65" },
      },
    ]);
  });

  it("publishes each workspace's failed build under its own scope", async () => {
    sim.buildAndRun.mockImplementation(async (workspaceId: string) => {
      throw new Error(`build failed in ${workspaceId}`);
    });
    await run(api.simBuildAndRun, { workspaceId: "ws-1", workspacePath: "/repo/ws" });
    await run(api.simBuildAndRun, { workspaceId: "ws-2", workspacePath: "/repo/other" });
    await settle();
    expect(events()).toEqual([
      {
        scope: { workspaceId: "ws-1" },
        event: { type: "buildFailed", error: "build failed in ws-1" },
      },
      {
        scope: { workspaceId: "ws-2" },
        event: { type: "buildFailed", error: "build failed in ws-2" },
      },
    ]);
  });
});

describe("apps on the streaming simulator", () => {
  const APP = { ...WS, bundleId: "com.example.app" };

  it.each([
    ["launch", api.simLaunchApp],
    ["terminate", api.simTerminateApp],
    ["uninstall", api.simUninstallApp],
  ] as const)("runs simctl %s on the workspace's device", async (verb, op) => {
    await expect(run(op, APP)).resolves.toBeUndefined();
    expect(sim.getContextForWorkspace).toHaveBeenCalledWith("ws-1");
    expect(execFile).toHaveBeenCalledExactlyOnceWith(
      "xcrun",
      ["simctl", verb, "UDID-1", "com.example.app"],
      expect.any(Function)
    );
  });

  it("refuses when the workspace is not streaming a simulator", async () => {
    sim.getContextForWorkspace.mockReturnValue(null);
    for (const op of [api.simLaunchApp, api.simTerminateApp, api.simUninstallApp]) {
      await expect(run(op, APP)).rejects.toThrow("No active simulator session");
    }
    expect(execFile).not.toHaveBeenCalled();
  });

  it("reports simctl's own failure", async () => {
    execFile.mockImplementation((_file: string, _args: string[], done: (err: Error) => void) =>
      done(new Error("found nothing to terminate"))
    );
    await expect(run(api.simTerminateApp, APP)).rejects.toThrow("found nothing to terminate");
  });
});

describe("the cloud device", () => {
  it("reads the device's status, null when the platform knows of none", async () => {
    const status = { status: "ready", platform: "ios", streamUrl: "https://stream.example/1" };
    cloud.getCloudSimulatorStatus.mockResolvedValueOnce(status).mockResolvedValueOnce(null);
    await expect(run(api.cloudSimulator, WS)).resolves.toEqual(status);
    await expect(run(api.cloudSimulator, WS)).resolves.toBeNull();
    expect(cloud.getCloudSimulatorStatus).toHaveBeenCalledWith("ws-1");
  });

  it("starts and stops a device, naming the platform only when the client did", async () => {
    await expect(run(api.cloudSimStart, { ...WS, platform: "android" })).resolves.toBeUndefined();
    expect(cloud.startCloudSimulator).toHaveBeenLastCalledWith("ws-1", "android");
    await run(api.cloudSimStart, WS);
    expect(cloud.startCloudSimulator).toHaveBeenLastCalledWith("ws-1", undefined);

    await expect(run(api.cloudSimStop, WS)).resolves.toBeUndefined();
    expect(cloud.stopCloudSimulator).toHaveBeenLastCalledWith("ws-1", undefined);
    await run(api.cloudSimStop, { ...WS, platform: "ios" });
    expect(cloud.stopCloudSimulator).toHaveBeenLastCalledWith("ws-1", "ios");
  });

  it("refuses a start the sandbox could not be reached for", async () => {
    cloud.startCloudSimulator.mockRejectedValue(
      new Error("Hosted simulators run in cloud workspaces only")
    );
    await expect(run(api.cloudSimStart, WS)).rejects.toThrow(
      "Hosted simulators run in cloud workspaces only"
    );
  });

  it("runs one verb and returns the platform's verdict, a failed one included", async () => {
    const failed = { success: false, exitCode: 1, output: "", error: "no device" };
    cloud.execCloudSimulator.mockResolvedValue(failed);
    await expect(
      run(api.cloudSimExec, { ...WS, verb: "press", args: ["42", "100"], platform: "ios" })
    ).resolves.toEqual(failed);
    expect(cloud.execCloudSimulator).toHaveBeenLastCalledWith("ws-1", {
      verb: "press",
      args: ["42", "100"],
      platform: "ios",
    });
    await run(api.cloudSimExec, { ...WS, verb: "home" });
    expect(cloud.execCloudSimulator).toHaveBeenLastCalledWith("ws-1", { verb: "home" });
  });

  it("refuses a verb with malformed arguments or an unknown platform", async () => {
    await expect(run(api.cloudSimExec, WS as never)).rejects.toMatchObject({
      statusCode: 400,
      message: "cloudSimExec requires verb",
    });
    await expect(
      run(api.cloudSimExec, { ...WS, verb: "press", args: [42] } as never)
    ).rejects.toMatchObject({ statusCode: 400 });
    await expect(
      run(api.cloudSimExec, { ...WS, verb: "home", platform: "visionos" } as never)
    ).rejects.toMatchObject({ statusCode: 400 });
    await expect(
      run(api.cloudSimStart, { ...WS, platform: "visionos" } as never)
    ).rejects.toMatchObject({ statusCode: 400 });
    expect(cloud.execCloudSimulator).not.toHaveBeenCalled();
    expect(cloud.startCloudSimulator).not.toHaveBeenCalled();
  });
});
