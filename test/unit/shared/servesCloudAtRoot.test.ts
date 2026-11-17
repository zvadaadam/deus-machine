import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isCloudDirectWebMode, servesCloudAtRoot } from "@/shared/config/webDirectMode";

const capabilities = vi.hoisted(() => ({ ipcInvoke: false }));
vi.mock("@/platform/capabilities", () => ({ capabilities }));

beforeEach(() => {
  capabilities.ipcInvoke = false;
  vi.stubEnv("VITE_BACKEND_PORT", "");
  vi.stubEnv("VITE_CLOUD_DIRECT", "1");
  vi.stubGlobal("window", { location: { pathname: "/connect" } });
  vi.stubGlobal("localStorage", { getItem: () => null });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("servesCloudAtRoot (asked from /connect)", () => {
  it("is true on a hosted build, where /connect itself is not web-direct", () => {
    expect(isCloudDirectWebMode()).toBe(false);
    expect(servesCloudAtRoot()).toBe(true);
  });

  it("is false when the build does not serve the cloud", () => {
    vi.stubEnv("VITE_CLOUD_DIRECT", "0");
    expect(servesCloudAtRoot()).toBe(false);
  });

  it("is false in Electron", () => {
    capabilities.ipcInvoke = true;
    expect(servesCloudAtRoot()).toBe(false);
  });

  it("is false in web-dev, where the root redirects to /s/local", () => {
    vi.stubEnv("VITE_BACKEND_PORT", "41000");
    expect(servesCloudAtRoot()).toBe(false);
  });
});
