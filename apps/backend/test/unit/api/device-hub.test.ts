import { describe, expect, it, vi } from "vitest";
import * as api from "@shared/api/device-hub";
import handlers from "../../../src/api/device-hub";
import { deviceHub } from "../../../src/services/device-hub";
import { subscribe } from "../../../src/services/streams";
import { operations } from "../../helpers";

vi.mock("../../../src/services/ws.service", () => ({
  getConnection: () => ({ deviceId: "phone", isVirtual: true }),
  sendFrame: vi.fn(),
}));

describe("Device Hub access", () => {
  it("refuses a relay subscription before starting the installer", () => {
    const follow = vi.spyOn(deviceHub, "follow");
    expect(() =>
      subscribe("relay", "sub", api.deviceHubStatus, {
        workspaceId: "w",
        deviceId: null,
        platform: null,
      })
    ).toThrow("on this computer");
    expect(follow).not.toHaveBeenCalled();
  });

  it("refuses device operations from a paired viewer", async () => {
    const call = operations(handlers, { deviceId: "phone", assistant: null, relayed: false });
    await expect(call(api.deviceHubDevices, {})).rejects.toThrow("on this computer");
    await expect(call(api.startHubDevice, { platform: "android", id: "phone" })).rejects.toThrow(
      "on this computer"
    );
    await expect(call(api.retryDeviceHub, {})).rejects.toThrow("on this computer");
  });
});
