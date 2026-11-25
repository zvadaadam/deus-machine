import { afterEach, describe, expect, it, vi } from "vitest";
import { listHubDevices, startHubDevice } from "../../../src/services/device-hub/devices";

const hub = { origin: "http://127.0.0.1:4000", token: "test-device-hub" };
const ios = { id: "a", name: "iPhone", version: "27", platform: "ios", booted: false } as const;
const android = {
  id: "pixel",
  name: "Pixel",
  version: "36",
  platform: "android",
  booted: false,
} as const;
const inventory = { simulators: [ios], emulators: [android], errors: [] };

afterEach(() => vi.unstubAllGlobals());

describe("Device Hub devices", () => {
  it("lists shutdown devices and reports the hub's missing Android SDK", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        Response.json({
          ...inventory,
          emulators: [],
          errors: [
            {
              message: "[android-utils] emulator list failed",
              error: "spawn emulator ENOENT\nstack",
            },
          ],
        })
      )
    );
    const list = await listHubDevices(hub);
    expect(list.devices).toEqual([ios]);
    expect(list.warnings).toEqual(["Android SDK unavailable. spawn emulator ENOENT"]);
  });

  it("distinguishes missing Xcode from a simulator that timed out", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        Response.json({
          simulators: [],
          emulators: [],
          errors: [
            {
              message: "[apple-utils] xcrun simctl failed",
              error: 'xcrun: error: unable to find utility "simctl"',
            },
            { message: "[apple-utils] xcrun simctl did not respond within 30 s" },
          ],
        })
      )
    );
    const { warnings } = await listHubDevices(hub);
    expect(warnings[0]).toContain("iOS requires Xcode");
    expect(warnings[1]).toBe("[apple-utils] xcrun simctl did not respond within 30 s");
  });

  it("boots iOS and attaches capture only for the selected device", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(Response.json(inventory))
      .mockResolvedValueOnce(Response.json({ ok: true }))
      .mockResolvedValueOnce(Response.json({ ok: true }));
    vi.stubGlobal("fetch", fetch);
    expect(await startHubDevice(hub, ios)).toEqual({ ...ios, booted: true });
    expect(fetch.mock.calls.map(([url]) => new URL(url).pathname)).toEqual([
      "/api/devices",
      "/api/devices/boot",
      "/vendor/serve-sim/grid/api/start",
    ]);
    expect(JSON.parse(fetch.mock.calls[2][1].body)).toEqual({ udid: ios.id });
  });

  it("uses Android's running serial for capture and input", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(Response.json(inventory))
      .mockResolvedValueOnce(Response.json({ ok: true, serial: "emulator-5556" }));
    vi.stubGlobal("fetch", fetch);
    expect(await startHubDevice(hub, android)).toEqual({
      ...android,
      id: "emulator-5556",
      booted: true,
    });
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
