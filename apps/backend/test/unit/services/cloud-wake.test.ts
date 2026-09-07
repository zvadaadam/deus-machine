import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  config: vi.fn(),
  get: vi.fn(),
  resume: vi.fn(),
  create: vi.fn(),
  apiCreate: vi.fn(),
  environment: vi.fn(),
  repository: vi.fn(),
  run: vi.fn(),
  announce: vi.fn(),
  connect: vi.fn(),
  live: vi.fn(),
  workspace: { state: "ready", init_stage: null as string | null },
}));
vi.mock("@deus-hq/sdk", async (original) => ({
  ...(await original<typeof import("@deus-hq/sdk")>()),
  getWorkspace: mocks.get,
  resumeWorkspace: mocks.resume,
  createWorkspace: mocks.create,
  listSecrets: async function* () {},
}));
vi.mock("@deus-hq/sdk/client", () => ({ apiCreateWorkspace: mocks.apiCreate }));
vi.mock("../../../src/services/agent/cloud/config", () => ({
  getCloudConfig: mocks.config,
  setCloudConnectHook: vi.fn(),
}));
vi.mock("../../../src/services/agent/cloud/driver", () => ({
  announceCloudEnv: mocks.announce,
  ensureCloudSession: mocks.connect,
  hasLiveCloudSession: mocks.live,
  getCloudIdentityGeneration: () => 0,
}));
vi.mock("../../../src/services/cloud-environment.service", () => ({
  getCloudEnvironmentInfo: mocks.environment,
  enableCloudEnvironmentSimulator: vi.fn(),
}));
vi.mock("../../../src/db", () => ({ getRepositoryById: mocks.repository }));
vi.mock("../../../src/lib/database", () => ({
  getDatabase: () => ({
    prepare: (sql: string) => ({
      run: mocks.run,
      get: () => (sql.includes("init_stage") ? mocks.workspace : { last_inline_mint_at: 0 }),
    }),
  }),
}));
vi.mock("../../../src/services/query-engine", () => ({ invalidate: vi.fn() }));

import {
  clearGithubTokenRefreshFlights,
  refreshWorkspaceGithubToken,
  wakeCloudWorkspaceWithFeedback,
} from "../../../src/services/cloud-workspace-init.service";

beforeEach(() => {
  vi.resetAllMocks();
  mocks.workspace = { state: "ready", init_stage: null };
  clearGithubTokenRefreshFlights();
  mocks.config.mockReturnValue({ apiKey: "test", baseUrl: "https://cloud.test" });
  mocks.repository.mockReturnValue({ git_origin_url: "https://github.com/owner/repo" });
  mocks.environment.mockResolvedValue({ configured: false });
  mocks.create.mockResolvedValue({ id: "vm", organizationId: "org" });
});

describe("explicit cloud wake", () => {
  it.each(["paused", "stopped", "error", "running", undefined])(
    "releases the hold for %s without requiring desktop mint context",
    async (status) => {
      mocks.get.mockResolvedValue({ status });
      const result = await wakeCloudWorkspaceWithFeedback({
        id: "ws",
        provider_workspace_id: "vm",
        current_session_id: "session",
      });
      expect(mocks.resume).toHaveBeenCalledWith("vm", {
        apiKey: "test",
        baseUrl: "https://cloud.test",
      });
      expect(mocks.connect).toHaveBeenCalledWith("session");
      expect(result).toEqual({ ok: true, status: status === "running" ? "running" : "resuming" });
      if (status === "running") expect(mocks.run).toHaveBeenCalledWith(null, "ws");
    }
  );

  it("surfaces a failed resume without announcing success", async () => {
    mocks.get.mockResolvedValue({ status: "error" });
    mocks.resume.mockRejectedValue(new Error("provider unavailable"));
    expect(
      await wakeCloudWorkspaceWithFeedback({
        id: "ws",
        provider_workspace_id: "vm",
        current_session_id: "session",
      })
    ).toEqual({ ok: false, status: "error" });
    expect(mocks.run).toHaveBeenLastCalledWith("error", "ws");
    expect(mocks.connect).not.toHaveBeenCalled();
  });

  it("preserves a serving computer when its HTTP refresh fails", async () => {
    mocks.get.mockRejectedValue(new Error("control plane unavailable"));
    mocks.live.mockReturnValue(true);
    mocks.resume.mockRejectedValue(new Error("control plane unavailable"));
    expect(
      await wakeCloudWorkspaceWithFeedback({
        id: "ws",
        provider_workspace_id: "vm",
        current_session_id: "session",
      })
    ).toEqual({ ok: false, status: "running" });
    expect(mocks.run).not.toHaveBeenCalled();
    expect(mocks.announce).not.toHaveBeenCalled();
  });

  it.each(["paused", "stopped", "error", null])(
    "does not treat an open channel as proof that a %s computer is serving",
    async (status) => {
      mocks.get.mockResolvedValue({ status });
      mocks.workspace.init_stage = status ?? "paused";
      mocks.live.mockReturnValue(true);
      mocks.resume.mockRejectedValue(new Error("resume failed"));
      const expected = status === "paused" || status === "stopped" ? status : "error";
      expect(
        await wakeCloudWorkspaceWithFeedback({
          id: "ws",
          provider_workspace_id: "vm",
          current_session_id: "session",
        })
      ).toEqual({ ok: false, status: expected });
      expect(mocks.run).toHaveBeenLastCalledWith(expected, "ws");
    }
  );

  it("gates recovery if the previously-serving channel closes during refresh", async () => {
    mocks.get.mockRejectedValue(new Error("control plane unavailable"));
    mocks.live.mockReturnValue(true);
    mocks.resume.mockImplementation(async () => {
      mocks.live.mockReturnValue(false);
      throw new Error("resume failed");
    });
    expect(
      await wakeCloudWorkspaceWithFeedback({
        id: "ws",
        provider_workspace_id: "vm",
        current_session_id: "session",
      })
    ).toEqual({ ok: false, status: "error" });
    expect(mocks.run).toHaveBeenLastCalledWith("error", "ws");
  });
});

describe("cloud credential provenance", () => {
  it.each([false, true])(
    "omits the source update without a desktop session (named=%s)",
    async (named) => {
      mocks.environment.mockResolvedValue(
        named ? { configured: true, environmentId: "env", name: "env-name" } : { configured: false }
      );
      await refreshWorkspaceGithubToken({ repository_id: "repo", provider_workspace_id: "vm" });
      expect(mocks.apiCreate).not.toHaveBeenCalled();
      // The standard SDK call omits repositoryAuth, preserving the runtime choice.
      if (mocks.create.mock.calls.length)
        expect(mocks.create.mock.calls[0][0]).not.toHaveProperty("repositoryAuth");
      expect(mocks.create).toHaveBeenCalledOnce();
    }
  );
});
