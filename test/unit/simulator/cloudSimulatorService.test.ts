import { beforeEach, describe, expect, it, vi } from "vitest";

// The service is a thin wire adapter: every method must produce exactly the
// q:command / q:request frame the backend's cloud driver dispatches on.
const { sendCommand, sendRequest } = vi.hoisted(() => ({
  sendCommand: vi.fn(),
  sendRequest: vi.fn(),
}));
vi.mock("@/platform/ws", () => ({ sendCommand, sendRequest }));

import { cloudSimulatorService } from "@/features/simulator/cloud/cloudSimulator.service";

beforeEach(() => {
  sendCommand.mockReset().mockResolvedValue({ accepted: true });
  sendRequest.mockReset().mockResolvedValue({ success: true, exitCode: 0, output: "" });
});

describe("cloudSimulatorService — start / stop (fire-and-forget commands)", () => {
  it("sends cloudSim:start with the platform only when one is named", async () => {
    await cloudSimulatorService.start("ws-1", "android");
    expect(sendCommand).toHaveBeenLastCalledWith("cloudSim:start", {
      workspaceId: "ws-1",
      platform: "android",
    });

    await cloudSimulatorService.start("ws-1");
    expect(sendCommand).toHaveBeenLastCalledWith("cloudSim:start", { workspaceId: "ws-1" });
  });

  it("sends cloudSim:stop; no platform means every running device", async () => {
    await cloudSimulatorService.stop("ws-1");
    expect(sendCommand).toHaveBeenLastCalledWith("cloudSim:stop", { workspaceId: "ws-1" });

    await cloudSimulatorService.stop("ws-1", "ios");
    expect(sendCommand).toHaveBeenLastCalledWith("cloudSim:stop", {
      workspaceId: "ws-1",
      platform: "ios",
    });
  });

  it("surfaces a refused ack as an error (the outcome otherwise only rides the status event)", async () => {
    sendCommand.mockResolvedValueOnce({ accepted: false, error: "no cloud session" });
    await expect(cloudSimulatorService.start("ws-1")).rejects.toThrow("no cloud session");
    sendCommand.mockResolvedValueOnce({ accepted: false });
    await expect(cloudSimulatorService.stop("ws-1")).rejects.toThrow(/stop/i);
  });
});

describe("cloudSimulatorService — exec (request/response)", () => {
  it("sends cloudSimExec with verb, args and platform, omitting what wasn't given", async () => {
    await cloudSimulatorService.exec("ws-1", "press", ["42", "100"], "ios");
    expect(sendRequest).toHaveBeenLastCalledWith(
      "cloudSimExec",
      {
        workspaceId: "ws-1",
        verb: "press",
        args: ["42", "100"],
        platform: "ios",
      },
      { timeoutMs: 65_000 }
    );

    await cloudSimulatorService.exec("ws-1", "home");
    expect(sendRequest).toHaveBeenLastCalledWith(
      "cloudSimExec",
      {
        workspaceId: "ws-1",
        verb: "home",
      },
      { timeoutMs: 65_000 }
    );
  });

  it("returns the platform's response verbatim — a failed exec is data, not an exception", async () => {
    const failed = { success: false, exitCode: 1, output: "", error: "no device" };
    sendRequest.mockResolvedValueOnce(failed);
    await expect(cloudSimulatorService.exec("ws-1", "apps")).resolves.toEqual(failed);
  });

  it("screenshot is the `screenshot` verb (the PNG arrives on the event, not here)", async () => {
    await cloudSimulatorService.screenshot("ws-1");
    expect(sendRequest).toHaveBeenLastCalledWith(
      "cloudSimExec",
      {
        workspaceId: "ws-1",
        verb: "screenshot",
      },
      { timeoutMs: 65_000 }
    );
  });

  it("keepAlive is the `appstate` verb — cheap device activity that resets the idle stop", async () => {
    await cloudSimulatorService.keepAlive("ws-1", "android");
    expect(sendRequest).toHaveBeenLastCalledWith(
      "cloudSimExec",
      {
        workspaceId: "ws-1",
        verb: "appstate",
        platform: "android",
      },
      { timeoutMs: 65_000 }
    );
  });
});

describe("cloudSimulatorService — status (the one-shot read the store seeds from)", () => {
  it("asks the backend for the workspace's device status", async () => {
    sendRequest.mockResolvedValueOnce({ status: "ready", platform: "ios", streamUrl: "u" });
    await expect(cloudSimulatorService.status("ws-1")).resolves.toEqual({
      status: "ready",
      platform: "ios",
      streamUrl: "u",
    });
    expect(sendRequest).toHaveBeenLastCalledWith("cloudSimulator", { workspaceId: "ws-1" });
  });
});
