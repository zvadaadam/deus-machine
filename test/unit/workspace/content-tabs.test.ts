import { describe, expect, it, afterEach, vi } from "vitest";
import { anyContentTabVisible, isTabVisible, tabsFor } from "@/features/workspace-tabs/registry";
import type { Settings } from "@shared/types/settings";

const simulatorOn: Settings = {
  experimental_simulator: true,
};

describe("content tab visibility", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("makes the backend terminal available in a browser, including Run commands", () => {
    expect(isTabVisible("terminal")).toBe(true);
  });

  it("hides backend panels for direct cloud chat without a connected backend", () => {
    vi.stubEnv("VITE_CLOUD_DIRECT", "1");
    expect(isTabVisible("terminal")).toBe(false);
    expect(anyContentTabVisible()).toBe(false);
  });

  it("hides the simulator when the backend capability is unavailable", () => {
    expect(isTabVisible("simulator", simulatorOn, { simulatorAvailable: false })).toBe(false);
  });

  it("shows the simulator only when the setting and backend capability are both enabled", () => {
    expect(isTabVisible("simulator", simulatorOn, { simulatorAvailable: true })).toBe(true);
    expect(isTabVisible("simulator", {}, { simulatorAvailable: true })).toBe(false);
  });

  describe("a cloud workspace's tabs are the cloud computer's", () => {
    it("shows the simulator for a cloud computer without the Mac capability or the experimental flag", () => {
      // The device lives in the platform, not on this Mac: neither the local
      // simctl capability nor the experimental toggle has a say.
      expect(isTabVisible("simulator", {}, { cloud: true })).toBe(true);
      expect(isTabVisible("simulator", {}, { simulatorAvailable: false, cloud: true })).toBe(true);
    });

    it("still hides the simulator for a local workspace when nothing local serves it", () => {
      expect(isTabVisible("simulator", {}, { simulatorAvailable: false, cloud: false })).toBe(
        false
      );
      expect(isTabVisible("simulator", simulatorOn, { cloud: false })).toBe(false);
    });

    it("counts the cloud computer's tabs toward the content pane being available", () => {
      expect(anyContentTabVisible({}, { cloud: true })).toBe(true);
    });

    // Every combination of this computer's local settings and capabilities.
    const combos = [true, false].flatMap((browserSetting) =>
      [true, false].flatMap((simulatorSetting) =>
        [true, false].flatMap((simulatorAvailable) =>
          [true, false].map((nativeBrowser) => ({
            browserSetting,
            simulatorSetting,
            simulatorAvailable,
            nativeBrowser,
          }))
        )
      )
    );

    it.each(combos)(
      "browser %o: the cloud's Browser and Simulator always show; a local one follows this computer",
      async ({ browserSetting, simulatorSetting, simulatorAvailable, nativeBrowser }) => {
        const { capabilities } = await import("@/platform/capabilities");
        const original = capabilities.nativeBrowser;
        (capabilities as { nativeBrowser: boolean }).nativeBrowser = nativeBrowser;
        try {
          const settings: Settings = {
            experimental_browser: browserSetting,
            experimental_simulator: simulatorSetting,
          };
          const cloud = tabsFor({ kind: "cloud" }, simulatorAvailable);
          for (const tab of [
            "changes",
            "files",
            "terminal",
            "browser",
            "simulator",
            "config",
          ] as const) {
            expect(isTabVisible(tab, settings, cloud)).toBe(true);
          }
          const local = tabsFor({ kind: "worktree" }, simulatorAvailable);
          expect(isTabVisible("browser", settings, local)).toBe(nativeBrowser && browserSetting);
          expect(isTabVisible("simulator", settings, local)).toBe(
            simulatorAvailable && simulatorSetting
          );
        } finally {
          (capabilities as { nativeBrowser: boolean }).nativeBrowser = original;
        }
      }
    );

    it("shows no tab on the hosted web, cloud or not", () => {
      vi.stubEnv("VITE_CLOUD_DIRECT", "1");
      expect(isTabVisible("browser", {}, { cloud: true })).toBe(false);
      expect(isTabVisible("simulator", {}, { cloud: true })).toBe(false);
    });
  });
});
