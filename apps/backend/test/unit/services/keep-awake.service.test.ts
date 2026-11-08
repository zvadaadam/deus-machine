import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const settings = vi.hoisted(() => ({ values: {} as Record<string, unknown>, reads: 0 }));
vi.mock("../../../src/services/settings.service", () => ({
  getSetting: (key: string) => {
    settings.reads++;
    return key in settings.values ? settings.values[key] : null;
  },
}));

import {
  addConnection,
  disconnectDirectDevices,
  onDeviceConnectionsChange,
  removeConnection,
} from "../../../src/services/ws.service";
import {
  KEEP_AWAKE_GRACE_MS,
  resetKeepAwakeForTests,
  syncKeepAwake,
} from "../../../src/services/keep-awake.service";

const socket = { send: vi.fn(), close: vi.fn() };
let written: string[];

beforeEach(() => {
  vi.useFakeTimers();
  settings.values = { remote_access_enabled: true };
  settings.reads = 0;
  resetKeepAwakeForTests();
  written = [];
  vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
    written.push(String(chunk));
    return true;
  });
  onDeviceConnectionsChange(syncKeepAwake);
});

afterEach(() => {
  onDeviceConnectionsChange(null);
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("keep the Mac awake for a connected device", () => {
  it("asks while a paired device is connected, and stops a while after it leaves", () => {
    const id = addConnection(socket, "device-1", true);
    removeConnection(id);
    expect(written).toEqual(["DEUS_KEEP_AWAKE:1\n"]);
    vi.advanceTimersByTime(KEEP_AWAKE_GRACE_MS);
    expect(written).toEqual(["DEUS_KEEP_AWAKE:1\n", "DEUS_KEEP_AWAKE:0\n"]);
  });

  it("stays awake through a reconnect inside the grace period", () => {
    removeConnection(addConnection(socket, "device-1", true));
    vi.advanceTimersByTime(KEEP_AWAKE_GRACE_MS / 2);
    const back = addConnection(socket, "device-1", true);
    vi.advanceTimersByTime(KEEP_AWAKE_GRACE_MS);
    expect(written).toEqual(["DEUS_KEEP_AWAKE:1\n"]);
    removeConnection(back);
  });

  it("ignores the desktop's own window, which has no device, without reading settings", () => {
    const id = addConnection(socket, null);
    removeConnection(id);
    syncKeepAwake();
    expect(written).toEqual(["DEUS_KEEP_AWAKE:0\n"]);
    expect(settings.reads).toBe(0);
  });

  it("reports only changes, however many devices come and go", () => {
    const a = addConnection(socket, "device-1", true);
    const b = addConnection(socket, "device-2");
    removeConnection(a);
    removeConnection(b);
    vi.advanceTimersByTime(KEEP_AWAKE_GRACE_MS);
    expect(written).toEqual(["DEUS_KEEP_AWAKE:1\n", "DEUS_KEEP_AWAKE:0\n"]);
  });

  it("turning the setting off releases it at once, while a device stays connected", () => {
    const id = addConnection(socket, "device-1", true);
    settings.values.remote_keep_awake = false;
    syncKeepAwake();
    expect(written).toEqual(["DEUS_KEEP_AWAKE:1\n", "DEUS_KEEP_AWAKE:0\n"]);
    removeConnection(id);
  });

  it("turning remote access off releases it and disconnects the local network", () => {
    const relayed = addConnection(socket, "phone", true);
    const close = vi.fn();
    addConnection({ send: vi.fn(), close }, "laptop");
    settings.values.remote_access_enabled = false;
    disconnectDirectDevices();
    syncKeepAwake();
    // Not a revocation (4001): the laptop keeps its approval.
    expect(close).toHaveBeenCalledWith(1001, "Remote access turned off");
    expect(written).toEqual(["DEUS_KEEP_AWAKE:1\n", "DEUS_KEEP_AWAKE:0\n"]);
    removeConnection(relayed);
  });
});
