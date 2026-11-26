import { beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "@shared/api/cloud-device";
import { operations } from "../../helpers";
const cloud = vi.hoisted(() => ({
  execCloudSimulator: vi.fn(),
  getCloudSimulatorStatus: vi.fn(),
  startCloudSimulator: vi.fn(),
  stopCloudSimulator: vi.fn(),
}));
vi.mock("../../../src/services/agent/cloud/driver", () => cloud);

import handlers from "../../../src/api/cloud-device";

const run = operations(handlers);
const WS = { workspaceId: "ws-1" };
beforeEach(() => vi.resetAllMocks());

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
      new Error("Hosted devices run in cloud workspaces only")
    );
    await expect(run(api.cloudSimStart, WS)).rejects.toThrow(
      "Hosted devices run in cloud workspaces only"
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
