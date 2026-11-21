import { afterEach, expect, it, vi } from "vitest";

const { capture, setPersonProperties } = vi.hoisted(() => ({
  capture: vi.fn(),
  setPersonProperties: vi.fn(),
}));
vi.mock("posthog-js", () => ({
  default: { init: vi.fn(() => ({ capture, setPersonProperties })) },
}));

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

it("counts the desktop launch before a theme is chosen and reports each later choice", async () => {
  vi.stubGlobal("navigator", { webdriver: false });
  vi.stubGlobal("window", { electronAPI: { getAppVersion: async () => "0.3.20" } });
  const { reportTheme, startAnalytics } = await import("@/platform/analytics/track");
  startAnalytics();
  reportTheme(undefined);
  startAnalytics();
  await vi.waitFor(() =>
    expect(capture).toHaveBeenCalledWith("app_launched", { version: "0.3.20" })
  );
  expect(setPersonProperties).not.toHaveBeenCalled();

  reportTheme("dark");
  reportTheme("light");
  expect(setPersonProperties.mock.calls).toEqual([[{ theme: "dark" }], [{ theme: "light" }]]);
  expect(capture).toHaveBeenCalledTimes(1);
});

it("strips URL fragments from event and person data and skips the unfiltered flags request", async () => {
  vi.stubGlobal("navigator", { webdriver: false });
  const { default: posthog } = await import("posthog-js");
  const { startAnalytics } = await import("@/platform/analytics/track");
  startAnalytics();
  const options = vi.mocked(posthog.init).mock.lastCall![1]!;
  expect(options.advanced_disable_flags).toBe(true);
  const filter = options.before_send;
  if (typeof filter !== "function") throw new Error("Missing PostHog event filter");

  const current = "https://deus.test/s/machine?keep=1";
  const referrer = "/login?keep=2";
  const timestamp = new Date();
  const event = (url: string, from: string) => ({
    uuid: "fixture",
    event: "error_occurred",
    properties: {
      $current_url: url,
      $session_entry_url: url,
      $referrer: from,
      error_message: `Failed at ${url} on issue #42`,
      nested: [{ source: url }],
    },
    $set: { $initial_referrer: from },
    $set_once: { $initial_current_url: url },
    timestamp,
  });
  expect(filter(event(current + "#pair=SOFT+TIGER", referrer + "#token=fixture"))).toEqual(
    event(current, referrer)
  );
  expect(filter(null)).toBeNull();
});
