import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  archiveWorkspace,
  unarchiveWorkspace,
} from "../../../src/services/workspace-archive.service";

const mocks = vi.hoisted(() => ({
  workspace: vi.fn(),
  pause: vi.fn(),
  wake: vi.fn(),
  stopApps: vi.fn(),
  run: vi.fn(),
  status: vi.fn(),
}));
vi.mock("../../../src/db", () => ({ getWorkspaceRaw: mocks.workspace }));
vi.mock("../../../src/lib/database", () => ({
  getDatabase: () => ({ prepare: () => ({ run: mocks.run }) }),
}));
vi.mock("../../../src/services/aap", () => ({ stopAppsForWorkspace: mocks.stopApps }));
vi.mock("../../../src/services/cloud-workspace-init.service", () => ({
  pauseCloudWorkspace: mocks.pause,
  wakeCloudWorkspaceWithFeedback: mocks.wake,
}));
vi.mock("../../../src/services/query-engine", () => ({ invalidate: vi.fn() }));
vi.mock("../../../src/services/workspace-status.service", () => ({
  autoProgressStatus: mocks.status,
}));

beforeEach(() => {
  vi.resetAllMocks();
  mocks.workspace.mockReturnValue({
    id: "workspace",
    kind: "cloud",
    provider_workspace_id: "cloud-vm",
  });
  mocks.pause.mockResolvedValue(undefined);
  mocks.wake.mockResolvedValue({ ok: true, status: "resuming" });
  mocks.stopApps.mockResolvedValue(undefined);
});

describe("workspace archive", () => {
  it("waits for cloud suspension before marking the workspace archived", async () => {
    let resume!: () => void;
    mocks.pause.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        resume = resolve;
      })
    );
    const archiving = archiveWorkspace("workspace");
    await vi.waitFor(() => expect(mocks.pause).toHaveBeenCalledWith("cloud-vm"));
    expect(mocks.run).not.toHaveBeenCalled();
    resume();
    await archiving;
    expect(mocks.stopApps).toHaveBeenCalledWith("workspace");
    expect(mocks.run).toHaveBeenCalledWith("workspace");
    expect(mocks.status).toHaveBeenCalledWith("workspace", "done", { force: true });
  });

  it("leaves archive incomplete and surfaces a failed cloud pause", async () => {
    mocks.pause.mockRejectedValue(new Error("provider unavailable"));
    await expect(archiveWorkspace("workspace")).rejects.toThrow("provider unavailable");
    expect(mocks.run).not.toHaveBeenCalled();
    expect(mocks.status).not.toHaveBeenCalled();
  });

  it("archives local workspaces without touching cloud infrastructure", async () => {
    mocks.workspace.mockReturnValue({ id: "workspace", kind: "worktree" });
    await archiveWorkspace("workspace");
    expect(mocks.pause).not.toHaveBeenCalled();
    expect(mocks.run).toHaveBeenCalledOnce();
  });
});

describe("workspace unarchive", () => {
  it("serializes unarchive behind an in-flight cloud pause", async () => {
    let release!: () => void;
    mocks.pause.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        release = resolve;
      })
    );
    const archiving = archiveWorkspace("workspace");
    const opening = unarchiveWorkspace("workspace");
    await vi.waitFor(() => expect(mocks.pause).toHaveBeenCalledOnce());
    expect(mocks.wake).not.toHaveBeenCalled();
    mocks.workspace.mockReturnValue({
      id: "workspace",
      state: "archived",
      kind: "cloud",
      provider_workspace_id: "cloud-vm",
    });
    release();
    await Promise.all([archiving, opening]);
    expect(mocks.wake).toHaveBeenCalledWith(
      expect.objectContaining({ provider_workspace_id: "cloud-vm" })
    );
    expect(mocks.run).toHaveBeenCalledTimes(2);
  });

  it("restores archived membership when wake fails; a retry can succeed", async () => {
    mocks.workspace.mockReturnValue({
      id: "workspace",
      state: "archived",
      kind: "cloud",
      provider_workspace_id: "cloud-vm",
    });
    mocks.wake.mockResolvedValueOnce({ ok: false, status: "paused" });
    await expect(unarchiveWorkspace("workspace")).rejects.toThrow("Could not wake");
    expect(mocks.run).toHaveBeenCalledTimes(2);
    await unarchiveWorkspace("workspace");
    expect(mocks.run).toHaveBeenCalledTimes(3);
  });
});
