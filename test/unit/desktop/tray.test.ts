import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  templates: [] as Array<Array<{ label?: string }>>,
  tooltip: vi.fn(),
}));

vi.mock("electron", () => ({
  Tray: class {
    on = vi.fn();
    setToolTip = mocks.tooltip;
    setContextMenu = vi.fn();
    destroy = vi.fn();
  },
  Menu: {
    buildFromTemplate: (template: Array<{ label?: string }>) => {
      mocks.templates.push(template);
      return template;
    },
  },
  nativeImage: {
    createFromPath: () => ({ resize: () => ({ setTemplateImage: vi.fn() }) }),
  },
  app: { quit: vi.fn() },
  BrowserWindow: { getAllWindows: () => [] },
}));

const shown = () => mocks.templates.at(-1)?.[2]?.label;
const fetchSpy = vi.fn();

beforeEach(() => {
  vi.resetModules();
  mocks.templates.length = 0;
  vi.useFakeTimers();
  vi.stubGlobal("fetch", fetchSpy);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("follows the backend's starts and exits, without polling a port", async () => {
  const tray = await import("../../../apps/desktop/main/tray");
  // The first backend is ready before the tray exists.
  tray.setTrayStatus("running");
  tray.setupTray();
  expect(shown()).toContain("Backend running");

  tray.setTrayStatus("offline"); // it crashed
  expect(shown()).toContain("Backend offline");
  tray.setTrayStatus("running"); // a restart, on another port
  expect(shown()).toContain("Backend running");

  await vi.advanceTimersByTimeAsync(60_000);
  expect(fetchSpy).not.toHaveBeenCalled();
  expect(shown()).toContain("Backend running");

  tray.destroyTray();
  expect(() => tray.setTrayStatus("offline")).not.toThrow();
});
