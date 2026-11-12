import { beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "@shared/api";

// The service adds the deadlines and the verbs: every method must ask for
// exactly the operation the backend's cloud driver answers, and wait long enough.
const { call } = vi.hoisted(() => ({ call: vi.fn() }));
vi.mock("@/platform/ws", () => ({ call }));

import { cloudSimulatorService } from "@/features/simulator/cloud/cloudSimulator.service";

beforeEach(() => {
  call.mockReset().mockResolvedValue({ success: true, exitCode: 0, output: "" });
});

describe("cloudSimulatorService — start / stop (the outcome arrives as events)", () => {
  it("calls cloudSim:start with the platform only when one is named", async () => {
    await cloudSimulatorService.start("ws-1", "android");
    expect(call).toHaveBeenLastCalledWith(
      api.cloudSimStart,
      { workspaceId: "ws-1", platform: "android" },
      // Outlasts the backend's connect deadline (token mint + 30 s handshake).
      { timeoutMs: 75_000 }
    );

    await cloudSimulatorService.start("ws-1");
    expect(call).toHaveBeenLastCalledWith(
      api.cloudSimStart,
      { workspaceId: "ws-1" },
      { timeoutMs: 75_000 }
    );
  });

  it("calls cloudSim:stop; no platform means every running device", async () => {
    await cloudSimulatorService.stop("ws-1");
    expect(call).toHaveBeenLastCalledWith(
      api.cloudSimStop,
      { workspaceId: "ws-1" },
      { timeoutMs: 75_000 }
    );

    await cloudSimulatorService.stop("ws-1", "ios");
    expect(call).toHaveBeenLastCalledWith(
      api.cloudSimStop,
      { workspaceId: "ws-1", platform: "ios" },
      { timeoutMs: 75_000 }
    );
  });

  it("surfaces a refusal as an error (the outcome otherwise only rides the status event)", async () => {
    call.mockRejectedValueOnce(new Error("no cloud session"));
    await expect(cloudSimulatorService.start("ws-1")).rejects.toThrow("no cloud session");
  });
});

describe("cloudSimulatorService — exec (one device operation)", () => {
  it("calls cloudSimExec with verb, args and platform, omitting what wasn't given", async () => {
    await cloudSimulatorService.exec("ws-1", "press", ["42", "100"], "ios");
    expect(call).toHaveBeenLastCalledWith(
      api.cloudSimExec,
      {
        workspaceId: "ws-1",
        verb: "press",
        args: ["42", "100"],
        platform: "ios",
      },
      { timeoutMs: 100_000 }
    );

    await cloudSimulatorService.exec("ws-1", "home");
    expect(call).toHaveBeenLastCalledWith(
      api.cloudSimExec,
      {
        workspaceId: "ws-1",
        verb: "home",
      },
      { timeoutMs: 100_000 }
    );
    // What goes on the wire: an absent argument is no key at all.
    expect(JSON.parse(JSON.stringify(call.mock.lastCall?.[1]))).toStrictEqual({
      workspaceId: "ws-1",
      verb: "home",
    });
  });

  it("is a write: acting on a device must not be repeated when its answer is lost", () => {
    expect(api.cloudSimExec.kind).toBe("write");
  });

  it("returns the platform's response verbatim — a failed exec is data, not an exception", async () => {
    const failed = { success: false, exitCode: 1, output: "", error: "no device" };
    call.mockResolvedValueOnce(failed);
    await expect(cloudSimulatorService.exec("ws-1", "apps")).resolves.toEqual(failed);
  });

  it("screenshot is the `screenshot` verb (the PNG arrives on the event, not here)", async () => {
    await cloudSimulatorService.screenshot("ws-1");
    expect(call).toHaveBeenLastCalledWith(
      api.cloudSimExec,
      {
        workspaceId: "ws-1",
        verb: "screenshot",
      },
      { timeoutMs: 100_000 }
    );
  });

  it("screenshot names the displayed device's platform when given one", async () => {
    await cloudSimulatorService.screenshot("ws-1", "ios");
    expect(call).toHaveBeenLastCalledWith(
      api.cloudSimExec,
      { workspaceId: "ws-1", verb: "screenshot", platform: "ios" },
      { timeoutMs: 100_000 }
    );
  });

  it("keepAlive is the `appstate` verb — cheap device activity that resets the idle stop", async () => {
    await cloudSimulatorService.keepAlive("ws-1", "android");
    expect(call).toHaveBeenLastCalledWith(
      api.cloudSimExec,
      {
        workspaceId: "ws-1",
        verb: "appstate",
        platform: "android",
      },
      { timeoutMs: 100_000 }
    );
  });
});
