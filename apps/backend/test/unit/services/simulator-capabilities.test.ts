import { describe, expect, it } from "vitest";
import { resolveSimulatorCapabilities } from "../../../src/services/simulator-context";

describe("simulator capability resolution", () => {
  it("allows local macOS clients with simctl", () => {
    expect(
      resolveSimulatorCapabilities({
        backendPlatform: "darwin",
        relayClient: false,
        simctlAvailable: true,
      })
    ).toEqual({
      available: true,
      unavailableReason: null,
    });
  });

  it("blocks relay clients because simulator streams are not proxied", () => {
    const capabilities = resolveSimulatorCapabilities({
      backendPlatform: "darwin",
      relayClient: true,
      simctlAvailable: true,
    });

    expect(capabilities.available).toBe(false);
    expect(capabilities.unavailableReason).toContain("remote relay");
  });

  it("blocks non-macOS backends", () => {
    const capabilities = resolveSimulatorCapabilities({
      backendPlatform: "linux",
      relayClient: false,
      simctlAvailable: true,
    });

    expect(capabilities.available).toBe(false);
    expect(capabilities.unavailableReason).toContain("macOS backend");
  });

  it("blocks macOS backends without simctl", () => {
    const capabilities = resolveSimulatorCapabilities({
      backendPlatform: "darwin",
      relayClient: false,
      simctlAvailable: false,
    });

    expect(capabilities.available).toBe(false);
    expect(capabilities.unavailableReason).toContain("simctl");
  });
});
