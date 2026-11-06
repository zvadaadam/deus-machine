import { beforeEach, expect, it, vi } from "vitest";

const capabilities = vi.hoisted(() => ({ windowLifecycle: true, nativeOnboarding: true }));
vi.mock("@/platform/capabilities", () => ({ capabilities }));
const invoke = vi.hoisted(() => vi.fn());
vi.mock("@/platform/electron/invoke", () => ({ invoke }));

beforeEach(() => {
  vi.resetModules();
  invoke.mockReset();
});

it("the startup safety net stays quiet once the app has shown its window", async () => {
  const win = await import("@/platform/native/window");
  expect(win.hasRevealedWindow()).toBe(false);

  await win.show();
  expect(win.hasRevealedWindow()).toBe(true);
  expect(invoke).toHaveBeenCalledWith("show_main_window");
});

it("onboarding puts the window on screen too", async () => {
  const win = await import("@/platform/native/window");
  await win.enterOnboarding();
  expect(win.hasRevealedWindow()).toBe(true);
});
