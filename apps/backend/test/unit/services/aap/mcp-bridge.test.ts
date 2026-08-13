// Unit tests for apps/backend/src/services/aap/mcp-bridge.ts
//
// The bridge has two externally observable behaviors:
//   - When agent/client is connected, it calls the typed register/unregister
//     wrappers with the normalized server name + the given URL.
//   - When NOT connected, it logs a warning and returns normally (no throw).
//
// Since apps.service.ts wires the bridge via its imports, we mock the agent
// facade here and exercise the bridge directly.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { registerAapMcp, unregisterAapMcp, isConnected } = vi.hoisted(() => ({
  registerAapMcp: vi.fn(),
  unregisterAapMcp: vi.fn(),
  isConnected: vi.fn(),
}));

vi.mock("../../../../src/services/agent", () => ({
  registerAapMcp: (...args: unknown[]) => registerAapMcp(...args),
  unregisterAapMcp: (...args: unknown[]) => unregisterAapMcp(...args),
  isConnected: () => isConnected(),
}));

const { registerMcpForRunningApp, unregisterMcpForRunningApp } =
  await import("../../../../src/services/aap/mcp-bridge");

describe("aap/mcp-bridge", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe("registerMcpForRunningApp", () => {
    it("fires aap/register-mcp with the normalized server name + mcpUrl when connected", async () => {
      isConnected.mockReturnValue(true);
      registerAapMcp.mockResolvedValue(undefined);

      await registerMcpForRunningApp({
        appId: "deus.mobile-use",
        mcpUrl: "http://127.0.0.1:45321/mcp",
      });

      expect(registerAapMcp).toHaveBeenCalledTimes(1);
      expect(registerAapMcp).toHaveBeenCalledWith("deus_mobile_use", "http://127.0.0.1:45321/mcp");
    });

    it("normalizes dashes AND dots in the app id per idToServerName", async () => {
      isConnected.mockReturnValue(true);
      registerAapMcp.mockResolvedValue(undefined);

      await registerMcpForRunningApp({
        appId: "acme.foo-bar.baz",
        mcpUrl: "http://127.0.0.1:1/mcp",
      });

      expect(registerAapMcp).toHaveBeenCalledWith("acme_foo_bar_baz", "http://127.0.0.1:1/mcp");
    });

    it("is a silent no-op when agent/client is NOT connected (app launch still succeeds)", async () => {
      isConnected.mockReturnValue(false);

      await expect(
        registerMcpForRunningApp({
          appId: "deus.mobile-use",
          mcpUrl: "http://127.0.0.1:1/mcp",
        })
      ).resolves.toBeUndefined();

      expect(registerAapMcp).not.toHaveBeenCalled();
    });

    it("swallows errors from the register wrapper — registration is best-effort", async () => {
      isConnected.mockReturnValue(true);
      registerAapMcp.mockRejectedValue(new Error("agent-server timed out"));

      // Must not throw — the bridge is best-effort; the app is already
      // running and we don't want a flaky agent-server to rollback launch.
      await expect(
        registerMcpForRunningApp({
          appId: "deus.mobile-use",
          mcpUrl: "http://127.0.0.1:1/mcp",
        })
      ).resolves.toBeUndefined();
    });
  });

  describe("unregisterMcpForRunningApp", () => {
    it("fires aap/unregister-mcp with the normalized server name when connected", async () => {
      isConnected.mockReturnValue(true);
      unregisterAapMcp.mockResolvedValue(undefined);

      await unregisterMcpForRunningApp({
        appId: "deus.mobile-use",
        mcpUrl: "http://127.0.0.1:1/mcp",
      });

      expect(unregisterAapMcp).toHaveBeenCalledTimes(1);
      expect(unregisterAapMcp).toHaveBeenCalledWith("deus_mobile_use");
    });

    it("is a silent no-op when agent/client is NOT connected", async () => {
      isConnected.mockReturnValue(false);

      await expect(
        unregisterMcpForRunningApp({
          appId: "deus.mobile-use",
          mcpUrl: "http://127.0.0.1:1/mcp",
        })
      ).resolves.toBeUndefined();

      expect(unregisterAapMcp).not.toHaveBeenCalled();
    });

    it("swallows errors from the unregister wrapper — unregister is best-effort", async () => {
      isConnected.mockReturnValue(true);
      unregisterAapMcp.mockRejectedValue(new Error("agent-server dropped"));

      await expect(
        unregisterMcpForRunningApp({
          appId: "deus.mobile-use",
          mcpUrl: "http://127.0.0.1:1/mcp",
        })
      ).resolves.toBeUndefined();
    });
  });
});
