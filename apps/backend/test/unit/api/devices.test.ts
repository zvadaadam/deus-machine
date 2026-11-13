import { vi, describe, it, expect, beforeEach } from "vitest";
import * as api from "@shared/api/devices";
import { operations } from "../../helpers";

const devices = vi.hoisted(() => ({
  list: vi.fn(),
  revoke: vi.fn(),
  relayStatus: vi.fn(),
}));
vi.mock("../../../src/services/remote-auth.service", () => ({
  listDevices: devices.list,
  revokeDevice: devices.revoke,
}));
vi.mock("../../../src/services/relay.service", () => ({ getRelayStatus: devices.relayStatus }));

import handlers from "../../../src/api/devices";

const run = operations(handlers);
// A device that reached this computer through the relay asks the same operations.
const runRelayed = operations(handlers, { deviceId: "dev2", relayed: true });

const PHONE = {
  id: "dev1",
  name: "Phone",
  account_id: null,
  machine_id: null,
  ip_address: null,
  user_agent: null,
  last_seen_at: "2025-01-01",
  created_at: "2025-01-01",
  connected: true,
};

beforeEach(() => {
  vi.clearAllMocks();
  devices.list.mockReturnValue([PHONE]);
  devices.revoke.mockReturnValue(true);
});

describe("pairedDevices", () => {
  it("answers the devices this computer approved", async () => {
    expect(await run(api.pairedDevices)).toEqual({ devices: [PHONE] });
    expect(await runRelayed(api.pairedDevices)).toEqual({ devices: [PHONE] });
  });
});

describe("relayStatus", () => {
  it("answers the tunnel's state as the relay service has it", async () => {
    const status = {
      state: "connected",
      connected: true,
      clients: 1,
      serverId: "machine-1",
      serverName: "Adam's MacBook",
      accountId: "user_a",
      relayUrl: "wss://relay.example",
      error: null,
      platform: "darwin",
    };
    devices.relayStatus.mockReturnValue(status);
    expect(await run(api.relayStatus)).toBe(status);
  });
});

describe("revokeDevice", () => {
  it("revokes the device", async () => {
    expect(await run(api.revokeDevice, { deviceId: "dev1" })).toBeUndefined();
    expect(devices.revoke).toHaveBeenCalledExactlyOnceWith("dev1");
  });

  it("says when there is no such device", async () => {
    devices.revoke.mockReturnValue(false);
    await expect(run(api.revokeDevice, { deviceId: "nonexistent" })).rejects.toMatchObject({
      statusCode: 404,
      message: "Device not found",
    });
  });

  it("requires the device", async () => {
    await expect(run(api.revokeDevice, {} as never)).rejects.toMatchObject({
      statusCode: 400,
      message: "revokeDevice requires deviceId",
    });
    expect(devices.revoke).not.toHaveBeenCalled();
  });
});
