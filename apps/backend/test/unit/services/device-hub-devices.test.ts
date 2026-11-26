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
const ios = {
  physical: false,
  id: "a",
  name: "iPhone",
  version: "iOS 27",
  platform: "ios",
  booted: false,
} as const;
const android = {
  physical: false,
  id: "Pixel",
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
    androidSdk: "/fixture/sdk",
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
      androidSdk: null,
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
    expect(result.devices).toEqual([ios, expect.objectContaining({ id: "new", name: ios.name })]);
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
    expect(await startHubDevice(hub, { platform: "ios", identity: ios.id })).toMatchObject({
      id: ios.id,
      booted: true,
    });
    expect(simctl).toHaveBeenCalledWith(["boot", ios.id], { timeout: 90_000 });
    expect(fetch.mock.calls.map(([url]) => new URL(url).pathname)).toEqual([
      "/api/devices",
      "/vendor/serve-sim/grid/api/start",
    ]);
    expect(JSON.parse(fetch.mock.calls[1][1].body)).toEqual({ udid: ios.id });
  });

  it("reconnects only to a device that is already running", async () => {
    fetch.mockResolvedValueOnce(Response.json(inventory));
    await expect(startHubDevice(hub, { platform: "ios", identity: ios.id }, false)).rejects.toThrow(
      "The device is shut down."
    );
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(simctl).not.toHaveBeenCalled();
  });

  it("boots a previously used simulator via the hub", async () => {
    fetch
      .mockResolvedValueOnce(Response.json(inventory))
      .mockResolvedValueOnce(Response.json({ ok: true }))
      .mockResolvedValueOnce(Response.json({ ok: true }));
    expect(await startHubDevice(hub, { platform: "ios", identity: ios.id })).toEqual({
      ...ios,
      booted: true,
    });
    expect(fetch.mock.calls.map(([url]) => new URL(url).pathname)).toEqual([
      "/api/devices",
      "/api/devices/boot",
      "/vendor/serve-sim/grid/api/start",
    ]);
    expect(simctl).not.toHaveBeenCalled();
  });

  it("filters physical phones and refuses to start them", async () => {
    const phone = { ...android, physical: true, id: "usb-123", name: "My phone", booted: true };
    const devices = { ...inventory, emulators: [phone, android] };
    fetch.mockImplementation(async () => Response.json(devices));
    expect((await listHubDevices(hub)).devices).toEqual([ios, android]);
    for (const identity of [phone.id, phone.name])
      await expect(startHubDevice(hub, { platform: "android", identity })).rejects.toThrow(
        "Choose a device again"
      );
    expect(fetch.mock.calls.every(([url]) => new URL(url).pathname === "/api/devices")).toBe(true);
  });

  it("follows the AVD name across a serial change and refuses an unknown or ambiguous AVD", async () => {
    const running = { ...android, id: "emulator-5556", booted: true };
    const other = { ...running, name: "Tablet", id: "emulator-5554" };
    const unidentified = { ...running, name: "emulator-5558", id: "emulator-5558" };
    const target = { platform: "android", identity: android.name } as const;
    for (const [emulators, identity] of [
      [[other, unidentified], android.name],
      [[other, unidentified], unidentified.id],
      [[running, { ...other, name: running.name }], running.name],
    ] as const) {
      fetch.mockResolvedValueOnce(Response.json({ ...inventory, emulators }));
      await expect(startHubDevice(hub, { ...target, identity }, false)).rejects.toThrow(
        "Choose a device again"
      );
    }
    fetch.mockResolvedValueOnce(Response.json({ ...inventory, emulators: [other, running] }));
    expect(await startHubDevice(hub, target, false)).toEqual(running);
  });

  it("uses Android's running serial for capture and input", async () => {
    fetch
      .mockResolvedValueOnce(Response.json(inventory))
      .mockResolvedValueOnce(Response.json({ ok: true, serial: "emulator-5556" }))
      .mockResolvedValueOnce(
        Response.json({
          ...inventory,
          emulators: [{ ...android, booted: true, id: "emulator-5556" }],
        })
      );
    expect(await startHubDevice(hub, { platform: "android", identity: android.name })).toEqual({
      ...android,
      id: "emulator-5556",
      booted: true,
    });
    expect(fetch).toHaveBeenCalledTimes(3);
  });
});
