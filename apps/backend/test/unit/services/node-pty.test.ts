import { describe, it, expect, vi, beforeEach } from "vitest";

const {
  mockGetDatabase,
  mockGetWorkspaceRaw,
  mockSpawnPty,
  mockWriteToPty,
  mockResizePty,
  mockKillPty,
  mockIsCloudPty,
  mockOpenCloudPty,
  mockWriteCloudPty,
  mockResizeCloudPty,
  mockKillCloudPty,
} = vi.hoisted(() => ({
  mockGetDatabase: vi.fn(() => ({})),
  mockGetWorkspaceRaw: vi.fn<(...a: unknown[]) => unknown>(),
  mockSpawnPty: vi.fn(() => "local-pty-id"),
  mockWriteToPty: vi.fn(),
  mockResizePty: vi.fn(),
  mockKillPty: vi.fn(),
  mockIsCloudPty: vi.fn<(...a: unknown[]) => boolean>(),
  mockOpenCloudPty: vi.fn(async () => {}),
  mockWriteCloudPty: vi.fn(),
  mockResizeCloudPty: vi.fn(),
  mockKillCloudPty: vi.fn(),
}));

vi.mock("../../../src/lib/database", () => ({ getDatabase: mockGetDatabase }));
vi.mock("../../../src/db/queries", () => ({ getWorkspaceRaw: mockGetWorkspaceRaw }));
vi.mock("../../../src/services/pty.service", () => ({
  spawnPty: mockSpawnPty,
  writeToPty: mockWriteToPty,
  resizePty: mockResizePty,
  killPty: mockKillPty,
}));
vi.mock("../../../src/services/agent/cloud/driver", () => ({
  isCloudPty: mockIsCloudPty,
  openCloudPty: mockOpenCloudPty,
  writeCloudPty: mockWriteCloudPty,
  resizeCloudPty: mockResizeCloudPty,
  killCloudPty: mockKillCloudPty,
}));

import { ptyRouter } from "../../../src/services/node/pty";

const base = { id: "t1", command: "bash", args: [] as string[], cols: 80, rows: 24 };

describe("ptyRouter — terminal node routing", () => {
  beforeEach(() => vi.clearAllMocks());

  describe("open", () => {
    it("local (no cloudWorkspaceId) → node-pty spawn, returns its id", async () => {
      const out = await ptyRouter.open({ ...base, cwd: "/tmp" });
      expect(mockSpawnPty).toHaveBeenCalledWith({
        id: "t1",
        command: "bash",
        args: [],
        cols: 80,
        rows: 24,
        cwd: "/tmp",
      });
      expect(mockOpenCloudPty).not.toHaveBeenCalled();
      expect(out).toBe("local-pty-id");
    });

    it("cloud → resolves the workspace's session and opens a sandbox pty", async () => {
      mockGetWorkspaceRaw.mockReturnValue({ current_session_id: "sess-9" });
      const out = await ptyRouter.open({ ...base, cloudWorkspaceId: "ws-cloud" });
      expect(mockOpenCloudPty).toHaveBeenCalledWith("sess-9", { ptyId: "t1", cols: 80, rows: 24 });
      expect(mockSpawnPty).not.toHaveBeenCalled();
      expect(out).toBe("t1");
    });

    it("cloud with no active session → throws, opens nothing", async () => {
      mockGetWorkspaceRaw.mockReturnValue(undefined);
      await expect(ptyRouter.open({ ...base, cloudWorkspaceId: "ws-cloud" })).rejects.toThrow(
        "no active session"
      );
      expect(mockOpenCloudPty).not.toHaveBeenCalled();
    });
  });

  describe("write / resize / kill route by ptyId", () => {
    it("cloud pty → cloud fns", () => {
      mockIsCloudPty.mockReturnValue(true);
      ptyRouter.write("c1", [1, 2]);
      ptyRouter.resize("c1", 100, 40);
      ptyRouter.kill("c1");
      expect(mockWriteCloudPty).toHaveBeenCalledWith("c1", [1, 2]);
      expect(mockResizeCloudPty).toHaveBeenCalledWith("c1", 100, 40);
      expect(mockKillCloudPty).toHaveBeenCalledWith("c1");
      expect(mockWriteToPty).not.toHaveBeenCalled();
    });

    it("local pty → node-pty fns", () => {
      mockIsCloudPty.mockReturnValue(false);
      ptyRouter.write("l1", [3]);
      ptyRouter.resize("l1", 90, 30);
      ptyRouter.kill("l1");
      expect(mockWriteToPty).toHaveBeenCalledWith("l1", [3]);
      expect(mockResizePty).toHaveBeenCalledWith("l1", 90, 30);
      expect(mockKillPty).toHaveBeenCalledWith("l1");
      expect(mockWriteCloudPty).not.toHaveBeenCalled();
    });
  });
});
