import { describe, expect, it, vi } from "vitest";
import { runRequest } from "../../../src/services/query-request-dispatcher";
import { getSimulatorCapabilities } from "../../../src/services/simulator-context";

vi.mock("../../../src/services/simulator-context", () => ({
  getSimulatorCapabilities: vi.fn(({ relayClient }: { relayClient?: boolean }) => ({
    available: relayClient !== true,
    unavailableReason: relayClient === true ? "relay unavailable" : null,
  })),
}));

describe("query request dispatcher", () => {
  it("passes relay connection context into simulator capability requests", async () => {
    await expect(
      runRequest("simulatorCapabilities", {}, { relayClient: true })
    ).resolves.toMatchObject({
      available: false,
      unavailableReason: "relay unavailable",
    });

    expect(getSimulatorCapabilities).toHaveBeenCalledWith({ relayClient: true });
  });
});
