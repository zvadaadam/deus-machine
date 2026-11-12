import { beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "@shared/api";

// Starting a stream and building answer at once; their outcome is an event.
// The service is what turns "asked" plus "event" into one promise.
const { call, listeners } = vi.hoisted(() => ({
  call: vi.fn(),
  listeners: new Set<(event: string, data: unknown) => void>(),
}));
vi.mock("@/platform/ws", () => ({
  call,
  onEvent: (listener: (event: string, data: unknown) => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
}));

import { simulatorService } from "@/features/simulator/api/simulator.service";

const emit = (event: string, data: unknown) => [...listeners].forEach((l) => l(event, data));

beforeEach(() => {
  call.mockReset().mockResolvedValue(undefined);
  listeners.clear();
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
  it("resolves with the stream once this workspace's sim:streamReady arrives", async () => {
    const stream = simulatorService.startStreaming("ws-1", "U1", true);
    expect(call).toHaveBeenCalledExactlyOnceWith(api.simStart, {
      workspaceId: "ws-1",
      udid: "U1",
      skipBootCheck: true,
    });
    // Another workspace's stream is not ours.
    emit("sim:streamReady", { workspaceId: "ws-2", url: "http://localhost:9/s", port: 9 });
    emit("sim:streamReady", {
      workspaceId: "ws-1",
      url: "http://localhost:3100/stream.mjpeg",
      port: 3100,
      hidAvailable: true,
    });
    await expect(stream).resolves.toEqual({
      url: "http://localhost:3100/stream.mjpeg",
      port: 3100,
      hid_available: true,
    });
    expect(listeners.size).toBe(0);
  });

  it("rejects with the backend's reason when the stream fails to start", async () => {
    const stream = simulatorService.startStreaming("ws-1", "U1");
    emit("sim:streamFailed", { workspaceId: "ws-1", error: "Failed to boot simulator: nope" });
    await expect(stream).rejects.toThrow("Failed to boot simulator: nope");
    expect(listeners.size).toBe(0);
  });

  it("rejects at once when the start itself is refused, without waiting for an event", async () => {
    call.mockRejectedValue(
      new Error("iOS Simulator streaming is unavailable over remote relay in this build.")
    );
    await expect(simulatorService.startStreaming("ws-1", "U1")).rejects.toThrow("remote relay");
    expect(listeners.size).toBe(0);
  });
});

describe("simulatorService.buildAndRun", () => {
  it("resolves with the installed app on sim:buildComplete", async () => {
    const build = simulatorService.buildAndRun("ws-1", "/repo/ws");
    expect(call).toHaveBeenCalledExactlyOnceWith(api.simBuildAndRun, {
      workspaceId: "ws-1",
      workspacePath: "/repo/ws",
    });
    emit("sim:buildLog", { workspaceId: "ws-1", line: "Compiling…" });
    emit("sim:buildComplete", {
      workspaceId: "ws-1",
      bundleId: "com.example.app",
      appName: "Example",
      appPath: "/repo/ws/build/Example.app",
    });
    await expect(build).resolves.toEqual({
      bundle_id: "com.example.app",
      name: "Example",
      app_path: "/repo/ws/build/Example.app",
    });
    expect(listeners.size).toBe(0);
  });

  it("rejects with the build's error on sim:buildFailed", async () => {
    const build = simulatorService.buildAndRun("ws-1", "/repo/ws");
    emit("sim:buildFailed", { workspaceId: "ws-1", error: "xcodebuild exited with code 65" });
    await expect(build).rejects.toThrow("xcodebuild exited with code 65");
  });
});
