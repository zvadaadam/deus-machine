// Unit tests for the AAP command handlers (launchApp / stopApp) dispatched
// through runCommand. These exercise the q:command path only — the agent-
// initiated launch path is covered by the integration tests in
// test/integration/aap.test.ts, and apps.service itself has its own suite.
//
// We mock the aap barrel so the handler's only observable effects are the
// forwarded arguments — exactly what we want to lock in here: that the
// command handler resolves workspaceId → workspacePath and userDataDir
// correctly before calling launchApp.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---- Hoisted mocks ----
const mockLaunchApp = vi.fn();
const mockStopApp = vi.fn();
const mockGetWorkspaceForMiddleware = vi.fn();
const mockComputeWorkspacePath = vi.fn();

vi.mock("../../../src/services/aap", () => ({
  launchApp: (...args: unknown[]) => mockLaunchApp(...args),
  stopApp: (...args: unknown[]) => mockStopApp(...args),
}));

// DB isn't actually touched — getDatabase() just returns a stub handle
// that's passed through to getWorkspaceForMiddleware (which we mock).
vi.mock("../../../src/lib/database", () => ({
  getDatabase: () => ({}) as unknown,
  DB_PATH: "/fake/user-data/deus.db",
}));

vi.mock("../../../src/db", () => ({
  getSessionRaw: vi.fn(),
  getWorkspaceForMiddleware: (...args: unknown[]) => mockGetWorkspaceForMiddleware(...args),
}));

vi.mock("../../../src/middleware/workspace-loader", () => ({
  computeWorkspacePath: (...args: unknown[]) => mockComputeWorkspacePath(...args),
}));

// Every import below is unrelated to the AAP path but gets dragged in by
// commands.ts — mock to no-ops so the module loads cleanly.
vi.mock("../../../src/services/message-writer", () => ({ writeUserMessage: vi.fn() }));
vi.mock("../../../src/services/pty.service", () => ({
  spawnPty: vi.fn(),
  writeToPty: vi.fn(),
  resizePty: vi.fn(),
  killPty: vi.fn(),
}));
vi.mock("../../../src/services/fs-watcher.service", () => ({
  watchWorkspace: vi.fn(),
  unwatchWorkspace: vi.fn(),
}));
vi.mock("../../../src/services/route-delegate", () => ({ delegateToRoute: vi.fn() }));
vi.mock("../../../src/services/agent/persistence", () => ({ persistSessionError: vi.fn() }));
vi.mock("../../../src/services/query-engine", () => ({ invalidate: vi.fn() }));
vi.mock("../../../src/services/agent/service", () => ({
  isConnected: () => true,
  forwardTurn: vi.fn(),
  stopSession: vi.fn(),
  // Stub the shared path resolver so the q:command handler hits the same
  // single helper as the agent RPC path without requiring the full DB graph.
  resolveAapPaths: ({ workspaceId }: { workspaceId: string }) => {
    const ws = mockGetWorkspaceForMiddleware(undefined, workspaceId);
    if (!ws) throw new Error(`Workspace not found: ${workspaceId}`);
    const workspacePath = mockComputeWorkspacePath(ws);
    if (!workspacePath) {
      throw new Error(
        `Workspace ${workspaceId} has no resolvable path (missing root_path or slug)`
      );
    }
    return { workspaceId, workspacePath, userDataDir: "/fake/user-data" };
  },
}));
vi.mock("../../../src/services/simulator-context", () => ({}));
vi.mock("../../../src/services/ws.service", () => ({ broadcast: vi.fn() }));

import { runCommand } from "../../../src/services/agent/commands";

describe("agent/commands — AAP command handlers", () => {
  beforeEach(() => {
    mockLaunchApp.mockReset();
    mockStopApp.mockReset();
    mockGetWorkspaceForMiddleware.mockReset();
    mockComputeWorkspacePath.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("launchApp", () => {
    it("resolves workspace → path and forwards to apps.service.launchApp", async () => {
      mockGetWorkspaceForMiddleware.mockReturnValue({
        id: "ws-1",
        repository_root_path: "/repos/r1",
        slug: "feature-x",
      });
      mockComputeWorkspacePath.mockReturnValue("/repos/r1/.deus/feature-x");
      mockLaunchApp.mockResolvedValue({
        runningAppId: "run-1",
        url: "http://127.0.0.1:9001/",
        bootstrap: "use this app to drive iOS",
      });

      const result = await runCommand("launchApp", {
        appId: "deus.mobile-use",
        workspaceId: "ws-1",
      });

      expect(mockLaunchApp).toHaveBeenCalledTimes(1);
      expect(mockLaunchApp).toHaveBeenCalledWith({
        appId: "deus.mobile-use",
        workspaceId: "ws-1",
        workspacePath: "/repos/r1/.deus/feature-x",
        userDataDir: "/fake/user-data",
      });
      expect(result).toEqual({
        runningAppId: "run-1",
        url: "http://127.0.0.1:9001/",
        bootstrap: "use this app to drive iOS",
      });
    });

    it("throws when workspaceId does not resolve to a row", async () => {
      mockGetWorkspaceForMiddleware.mockReturnValue(undefined);

      await expect(
        runCommand("launchApp", { appId: "deus.mobile-use", workspaceId: "ghost-ws" })
      ).rejects.toThrow(/Workspace not found/);

      expect(mockLaunchApp).not.toHaveBeenCalled();
    });

    it("throws when appId param is missing", async () => {
      await expect(runCommand("launchApp", { workspaceId: "ws-1" })).rejects.toThrow(/appId/);
    });

    it("throws when workspaceId param is missing", async () => {
      await expect(runCommand("launchApp", { appId: "deus.mobile-use" })).rejects.toThrow(
        /workspaceId/
      );
    });

    it("propagates launchApp rejection with the original message", async () => {
      mockGetWorkspaceForMiddleware.mockReturnValue({ id: "ws-1" });
      mockComputeWorkspacePath.mockReturnValue("/some/path");
      mockLaunchApp.mockRejectedValue(new Error("aap: deus.mobile-use failed to spawn — ENOENT"));

      await expect(
        runCommand("launchApp", { appId: "deus.mobile-use", workspaceId: "ws-1" })
      ).rejects.toThrow(/failed to spawn/);
    });
  });

  describe("stopApp", () => {
    it("forwards runningAppId to apps.service.stopApp", async () => {
      mockStopApp.mockResolvedValue(undefined);

      const result = await runCommand("stopApp", { runningAppId: "run-1" });

      expect(mockStopApp).toHaveBeenCalledTimes(1);
      expect(mockStopApp).toHaveBeenCalledWith("run-1");
      expect(result).toEqual({ success: true });
    });

    it("throws when runningAppId is missing", async () => {
      await expect(runCommand("stopApp", {})).rejects.toThrow(/runningAppId/);
      expect(mockStopApp).not.toHaveBeenCalled();
    });
  });
});
