import { beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "@shared/api";
import { emit, following } from "../../helpers";

// Starting a stream and building answer at once; their outcome is an event on
// the workspace's `simulatorEvents`. The service is what turns "asked" plus
// "event" into one promise.
const { call, follow } = vi.hoisted(() => ({
  call: vi.fn(),
  follow: vi.fn(() => vi.fn()),
}));
vi.mock("@/platform/ws", () => ({ call, follow }));

import { simulatorService } from "@/features/simulator/api/simulator.service";

beforeEach(() => {
  call.mockReset().mockResolvedValue(undefined);
  follow.mockClear();
});

describe("simulatorService.listSimulators", () => {
  it("reads the devices, allowing for a slow first answer from CoreSimulator", async () => {
    const devices = [{ name: "iPhone 17", udid: "U1" }];
    call.mockResolvedValue({ devices });
    await expect(simulatorService.listSimulators()).resolves.toBe(devices);
    expect(call).toHaveBeenCalledExactlyOnceWith(api.simListDevices, {}, { timeoutMs: 45_000 });
  });

  it("shows no devices when they cannot be listed", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    call.mockRejectedValue(new Error("xcrun: error: unable to find utility simctl"));
    await expect(simulatorService.listSimulators()).resolves.toEqual([]);
  });
});

describe("simulatorService.startStreaming", () => {
  it("resolves with the stream once this workspace's simulator reports it ready", async () => {
    const stream = simulatorService.startStreaming("ws-1", "U1", true);
    expect(call).toHaveBeenCalledExactlyOnceWith(api.simStart, {
      workspaceId: "ws-1",
      udid: "U1",
      skipBootCheck: true,
    });
    expect(following(follow)).toEqual([
      { stream: "simulatorEvents", filter: { workspaceId: "ws-1" } },
    ]);
    // Another workspace's stream is not ours.
    emit(
      follow,
      api.simulatorEvents,
      { workspaceId: "ws-2" },
      { type: "streamReady", url: "http://localhost:9/s", port: 9, hidAvailable: false }
    );
    emit(
      follow,
      api.simulatorEvents,
      { workspaceId: "ws-1" },
      {
        type: "streamReady",
        url: "http://localhost:3100/stream.mjpeg",
        port: 3100,
        hidAvailable: true,
      }
    );
    await expect(stream).resolves.toEqual({
      url: "http://localhost:3100/stream.mjpeg",
      port: 3100,
      hid_available: true,
    });
    expect(following(follow)).toEqual([]);
  });

  it("rejects with the backend's reason when the stream fails to start", async () => {
    const stream = simulatorService.startStreaming("ws-1", "U1");
    emit(
      follow,
      api.simulatorEvents,
      { workspaceId: "ws-1" },
      { type: "streamFailed", error: "Failed to boot simulator: nope" }
    );
    await expect(stream).rejects.toThrow("Failed to boot simulator: nope");
    expect(following(follow)).toEqual([]);
  });

  it("rejects at once when the start itself is refused, without waiting for an event", async () => {
    call.mockRejectedValue(
      new Error("iOS Simulator streaming is unavailable over remote relay in this build.")
    );
    await expect(simulatorService.startStreaming("ws-1", "U1")).rejects.toThrow("remote relay");
    expect(following(follow)).toEqual([]);
  });
});

describe("simulatorService.buildAndRun", () => {
  it("resolves with the installed app once the build completes", async () => {
    const build = simulatorService.buildAndRun("ws-1", "/repo/ws");
    expect(call).toHaveBeenCalledExactlyOnceWith(api.simBuildAndRun, {
      workspaceId: "ws-1",
      workspacePath: "/repo/ws",
    });
    expect(following(follow)).toEqual([
      { stream: "simulatorEvents", filter: { workspaceId: "ws-1" } },
    ]);
    // A line of the build's output is not its outcome.
    emit(
      follow,
      api.simulatorEvents,
      { workspaceId: "ws-1" },
      { type: "buildLog", line: "Compiling…" }
    );
    expect(following(follow)).toHaveLength(1);
    emit(
      follow,
      api.simulatorEvents,
      { workspaceId: "ws-1" },
      {
        type: "buildComplete",
        bundleId: "com.example.app",
        appName: "Example",
        appPath: "/repo/ws/build/Example.app",
      }
    );
    await expect(build).resolves.toEqual({
      bundle_id: "com.example.app",
      name: "Example",
      app_path: "/repo/ws/build/Example.app",
    });
    expect(following(follow)).toEqual([]);
  });

  it("rejects with the build's error when the build fails", async () => {
    const build = simulatorService.buildAndRun("ws-1", "/repo/ws");
    emit(
      follow,
      api.simulatorEvents,
      { workspaceId: "ws-1" },
      { type: "buildFailed", error: "xcodebuild exited with code 65" }
    );
    await expect(build).rejects.toThrow("xcodebuild exited with code 65");
  });
});
