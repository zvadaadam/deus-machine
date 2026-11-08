import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const settings = vi.hoisted(() => ({ values: {} as Record<string, unknown> }));
vi.mock("../../../src/services/settings.service", () => ({
  getSetting: (key: string) => (key in settings.values ? settings.values[key] : null),
}));

import {
  addConnection,
  onDeviceConnectionsChange,
  removeConnection,
} from "../../../src/services/ws.service";
import { resetKeepAwakeForTests, syncKeepAwake } from "../../../src/services/keep-awake.service";

const socket = { send: vi.fn(), close: vi.fn() };
let written: string[];

beforeEach(() => {
  settings.values = {};
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
});

describe("keep the Mac awake for a connected device", () => {
  it("asks while a paired device is connected, and stops when it leaves", () => {
    const id = addConnection(socket, "device-1", true);
    removeConnection(id);
    expect(written).toEqual(["DEUS_KEEP_AWAKE:1\n", "DEUS_KEEP_AWAKE:0\n"]);
  });

  it("ignores the desktop's own window, which has no device", () => {
    const id = addConnection(socket, null);
    removeConnection(id);
    syncKeepAwake();
    expect(written).toEqual(["DEUS_KEEP_AWAKE:0\n"]);
  });

  it("reports only changes, however many devices come and go", () => {
    const a = addConnection(socket, "device-1", true);
    const b = addConnection(socket, "device-2");
    removeConnection(a);
    removeConnection(b);
    expect(written).toEqual(["DEUS_KEEP_AWAKE:1\n", "DEUS_KEEP_AWAKE:0\n"]);
  });

  it("turning the setting off releases it while a device stays connected", () => {
    const id = addConnection(socket, "device-1", true);
    settings.values.remote_keep_awake = false;
    syncKeepAwake();
    removeConnection(id);
    expect(written).toEqual(["DEUS_KEEP_AWAKE:1\n", "DEUS_KEEP_AWAKE:0\n"]);
  });
});
