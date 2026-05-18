import { describe, expect, it } from "vitest";
import { isTabVisible } from "@/app/layouts/content-tabs";
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
});
