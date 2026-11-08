import { beforeEach, expect, it, vi } from "vitest";

const electron = vi.hoisted(() => {
  const listeners: Record<string, () => void> = {};
  const started = new Set<number>();
  let next = 1;
  return {
    listeners,
    started,
    onBattery: false,
    powerMonitor: {
      isOnBatteryPower: () => electron.onBattery,
      on: (event: string, listener: () => void) => {
        listeners[event] = listener;
      },
    },
    powerSaveBlocker: {
      start: vi.fn(() => {
        const id = next++;
        started.add(id);
        return id;
      }),
      stop: vi.fn((id: number) => started.delete(id)),
      isStarted: (id: number) => started.has(id),
    },
  };
});
vi.mock("electron", () => ({
  powerMonitor: electron.powerMonitor,
  powerSaveBlocker: electron.powerSaveBlocker,
}));

beforeEach(() => {
  vi.resetModules();
  electron.started.clear();
  electron.onBattery = false;
  electron.powerSaveBlocker.start.mockClear();
});

it("holds the Mac awake while a device wants it and the Mac is plugged in", async () => {
  const { handleKeepAwakeLine } = await import("../../../apps/desktop/main/keep-awake");
  expect(handleKeepAwakeLine("DEUS_KEEP_AWAKE:1")).toBe(true);
  expect(electron.started.size).toBe(1);
  expect(electron.powerSaveBlocker.start).toHaveBeenCalledWith("prevent-app-suspension");

  handleKeepAwakeLine("DEUS_KEEP_AWAKE:0");
  expect(electron.started.size).toBe(0);
});

it("lets the Mac sleep on battery and resumes when plugged back in", async () => {
  const { setKeepAwakeWanted } = await import("../../../apps/desktop/main/keep-awake");
  setKeepAwakeWanted(true);
  expect(electron.started.size).toBe(1);

  electron.onBattery = true;
  electron.listeners["on-battery"]();
  expect(electron.started.size).toBe(0);

  electron.onBattery = false;
  electron.listeners["on-ac"]();
  expect(electron.started.size).toBe(1);
});

it("ignores other backend lines", async () => {
  const { handleKeepAwakeLine } = await import("../../../apps/desktop/main/keep-awake");
  expect(handleKeepAwakeLine("[BACKEND_PORT]4000")).toBe(false);
  expect(electron.started.size).toBe(0);
});
