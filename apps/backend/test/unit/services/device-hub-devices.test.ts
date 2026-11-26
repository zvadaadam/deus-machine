import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { listHubDevices, startHubDevice } from "../../../src/services/device-hub/devices";
import { deviceToolchains, hasSimulatorToolchain } from "../../../src/services/device-hub/support";
import { listDevices, simctl } from "../../../src/services/device-hub/simctl";

vi.mock("../../../src/services/device-hub/support", () => ({
  deviceToolchains: vi.fn(),
  hasSimulatorToolchain: vi.fn(),
}));
vi.mock("../../../src/services/device-hub/simctl", () => ({
  listDevices: vi.fn(),
  simctl: vi.fn(),
}));

const hub = { origin: "http://127.0.0.1:4000", token: "test-device-hub" };
const ios = { id: "a", name: "iPhone", version: "iOS 27", platform: "ios", booted: false } as const;
const android = {
  id: "pixel",
  name: "Pixel",
  version: "36",
  platform: "android",
  booted: false,
} as const;
const sim = {
  udid: ios.id,
  name: ios.name,
  runtime: ios.version,
  state: "Shutdown",
  device_type: "iPhone",
  isAvailable: true,
};
const inventory = { simulators: [ios], emulators: [android], errors: [] };
const fetch = vi.fn();
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal("fetch", fetch);
  vi.mocked(deviceToolchains).mockResolvedValue({
    android: true,
    xcode: { available: true, version: null },
    installer: true,
  });
  vi.mocked(hasSimulatorToolchain).mockResolvedValue(true);
  vi.mocked(listDevices).mockResolvedValue([]);
});
afterEach(() => vi.unstubAllGlobals());

describe("Device inventory and startup", () => {
  it("adds only missing iOS simulators and reports independent platform readiness", async () => {
    vi.mocked(deviceToolchains).mockResolvedValue({
      android: false,
      xcode: { available: true, version: null },
      installer: true,
    });
    vi.mocked(listDevices).mockResolvedValue([sim, { ...sim, udid: "new" }]);
    fetch.mockResolvedValue(
      Response.json({
        ...inventory,
        emulators: [],
        errors: [{ message: "Could not list AVDs", error: "vendor diagnostic" }],
      })
    );
    const result = await listHubDevices(hub);
    expect(result.devices).toEqual([ios, { ...ios, id: "new" }]);
    expect(result.available).toEqual({ ios: true, android: false });
    expect(result.detail).toEqual({ ios: null, android: "Could not list AVDs\nvendor diagnostic" });
  });

  it("can list Android without Xcode and does not infer prerequisites from diagnostic text", async () => {
    vi.mocked(hasSimulatorToolchain).mockResolvedValue(false);
    fetch.mockResolvedValue(
      Response.json({ ...inventory, simulators: [], errors: [{ message: "ENOENT" }] })
    );
    expect(await listHubDevices(hub)).toEqual({
      devices: [android],
      available: { ios: false, android: true },
      detail: { ios: null, android: "ENOENT" },
    });
    expect(listDevices).not.toHaveBeenCalled();
  });

  it("shows the hub's devices and a diagnostic when simctl enumeration fails", async () => {
    vi.mocked(listDevices).mockRejectedValue(new Error("simctl timed out"));
    fetch.mockResolvedValue(Response.json(inventory));
    expect(await listHubDevices(hub)).toEqual({
      devices: [ios, android],
      available: { ios: true, android: true },
      detail: { ios: "simctl timed out", android: null },
    });
  });

  it("boots a never-used simulator with simctl and attaches that UDID through the hub", async () => {
    fetch
      .mockResolvedValueOnce(Response.json({ ...inventory, simulators: [] }))
      .mockResolvedValueOnce(Response.json({ ok: true }));
    vi.mocked(listDevices).mockResolvedValue([sim]);
    expect(await startHubDevice(hub, ios)).toEqual({ ...ios, booted: true });
    expect(simctl).toHaveBeenCalledWith(["boot", ios.id], { timeout: 90_000 });
    expect(fetch.mock.calls.map(([url]) => new URL(url).pathname)).toEqual([
      "/api/devices",
      "/vendor/serve-sim/grid/api/start",
    ]);
    expect(JSON.parse(fetch.mock.calls[1][1].body)).toEqual({ udid: ios.id });
  });

  it("reconnects only to a device that is already running", async () => {
    fetch.mockResolvedValueOnce(Response.json(inventory));
    await expect(startHubDevice(hub, ios, false)).rejects.toThrow("The device is shut down.");
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(simctl).not.toHaveBeenCalled();
  });

  it("boots a previously used simulator via the hub", async () => {
    fetch
      .mockResolvedValueOnce(Response.json(inventory))
      .mockResolvedValueOnce(Response.json({ ok: true }))
      .mockResolvedValueOnce(Response.json({ ok: true }));
    expect(await startHubDevice(hub, ios)).toEqual({ ...ios, booted: true });
    expect(fetch.mock.calls.map(([url]) => new URL(url).pathname)).toEqual([
      "/api/devices",
      "/api/devices/boot",
      "/vendor/serve-sim/grid/api/start",
    ]);
    expect(simctl).not.toHaveBeenCalled();
  });

  it("uses Android's running serial for capture and input", async () => {
    fetch
      .mockResolvedValueOnce(Response.json(inventory))
      .mockResolvedValueOnce(Response.json({ ok: true, serial: "emulator-5556" }));
    expect(await startHubDevice(hub, android)).toEqual({
      ...android,
      id: "emulator-5556",
      booted: true,
    });
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
