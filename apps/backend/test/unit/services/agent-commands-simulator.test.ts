import { describe, expect, it, vi } from "vitest";
import { runCommand } from "../../../src/services/agent/commands";
import * as simulator from "../../../src/services/simulator-context";

describe("agent simulator commands", () => {
  it("rejects simulator stream start for relay clients before spawning a local stream", async () => {
    vi.spyOn(simulator, "getSimulatorCapabilities").mockReturnValue({
      available: false,
      unavailableReason: "iOS Simulator streaming is unavailable over remote relay in this build.",
    });
    const startStream = vi.spyOn(simulator, "startStream").mockResolvedValue(undefined);

    await expect(
      runCommand("sim:start", { workspaceId: "ws-1", udid: "sim-1" }, { relayClient: true })
    ).rejects.toThrow("remote relay");

    expect(startStream).not.toHaveBeenCalled();
  });
});
