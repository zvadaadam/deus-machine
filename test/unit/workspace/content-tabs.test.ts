import { describe, expect, it } from "vitest";
import { anyContentTabVisible, isTabVisible } from "@/app/layouts/content-tabs";
import type { Settings } from "@shared/types/settings";

const simulatorOn: Settings = {
  experimental_simulator: true,
};

describe("content tab visibility", () => {
  it("hides the simulator when the backend capability is unavailable", () => {
    expect(isTabVisible("simulator", simulatorOn, { simulatorAvailable: false })).toBe(false);
  });

  it("shows the simulator only when the setting and backend capability are both enabled", () => {
    expect(isTabVisible("simulator", simulatorOn, { simulatorAvailable: true })).toBe(true);
    expect(isTabVisible("simulator", {}, { simulatorAvailable: true })).toBe(false);
  });

  describe("cloud simulator", () => {
    it("shows the simulator for a cloud computer without the Mac capability or the experimental flag", () => {
      // The device lives in the platform, not on this Mac: neither the local
      // simctl capability nor the experimental toggle has a say.
      expect(isTabVisible("simulator", {}, { cloudSimulator: true })).toBe(true);
      expect(
        isTabVisible("simulator", {}, { simulatorAvailable: false, cloudSimulator: true })
      ).toBe(true);
    });

    it("still hides the simulator for a local workspace when nothing local serves it", () => {
      expect(
        isTabVisible("simulator", {}, { simulatorAvailable: false, cloudSimulator: false })
      ).toBe(false);
      expect(isTabVisible("simulator", simulatorOn, { cloudSimulator: false })).toBe(false);
    });

    it("counts the cloud simulator toward the content pane being available", () => {
      expect(anyContentTabVisible({}, { cloudSimulator: true })).toBe(true);
    });
  });
});
