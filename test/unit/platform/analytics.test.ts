import { afterEach, expect, it, vi } from "vitest";

const capture = vi.hoisted(() => vi.fn());
vi.mock("posthog-js", () => ({ default: { init: vi.fn(() => ({ capture })) } }));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  vi.resetModules();
});

it.each([false, true])(
  "starts and sends only in an ordinary browser (webdriver=%s)",
  async (webdriver) => {
    vi.stubGlobal("navigator", { webdriver });
    const { default: posthog } = await import("posthog-js");
    const { startAnalytics, track } = await import("@/platform/analytics/track");
    startAnalytics();
    const change = { key: "diff_view_mode", value: "split" };
    track("setting_changed", change);
    expect(posthog.init).toHaveBeenCalledTimes(webdriver ? 0 : 1);
    expect(capture.mock.calls).toEqual(webdriver ? [] : [["setting_changed", change]]);
  }
);
