import { afterEach, describe, expect, it, vi } from "vitest";
import {
  anyContentTabVisible,
  getVisibleTools,
  isTabVisible,
  tabsFor,
} from "@/app/layouts/content-tabs";
import { capabilities } from "@/platform/capabilities";
import * as config from "@/shared/config/backend.config";

describe("workspace tools", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });
  it.each(["electron", "web-dev", "web-standalone", "web-production", "web-direct"] as const)(
    "gates Device and its New Tab tile on the same support in %s",
    (mode) => {
      vi.spyOn(config, "getDeploymentMode").mockReturnValue(mode);
      vi.stubEnv("VITE_CLOUD_DIRECT", mode === "web-direct" ? "1" : "0");
      for (const available of [true, false]) {
        const local = tabsFor({ kind: "worktree" }, available);
        const cloud = tabsFor({ kind: "cloud" }, available);
        const visible = (mode === "electron" || mode === "web-dev") && available;
        expect(isTabVisible("device", {}, local)).toBe(visible);
        expect(getVisibleTools({}, local).some((tool) => tool.id === "device")).toBe(visible);
        expect(isTabVisible("device", {}, cloud)).toBe(true);
        expect(anyContentTabVisible({}, cloud)).toBe(true);
      }
    }
  );
  it("keeps the local Browser experimental and the cloud computer's Browser independent", () => {
    const settings = { experimental_browser: true };
    expect(isTabVisible("browser", {})).toBe(false);
    expect(isTabVisible("browser", settings)).toBe(capabilities.nativeBrowser);
    expect(isTabVisible("browser", {}, tabsFor({ kind: "cloud" }))).toBe(true);
  });
  it("offers only the hosted device in a direct cloud workspace", () => {
    vi.stubEnv("VITE_CLOUD_DIRECT", "1");
    expect(getVisibleTools({}, tabsFor({ kind: "cloud" })).map((t) => t.id)).toEqual(["device"]);
    expect(anyContentTabVisible({}, tabsFor({ kind: "worktree" }))).toBe(false);
  });
});
