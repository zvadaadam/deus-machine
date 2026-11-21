import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  config: vi.fn(),
  get: vi.fn(),
  resume: vi.fn(),
  create: vi.fn(),
  environment: vi.fn(),
  repository: vi.fn(),
  run: vi.fn(),
  announce: vi.fn(),
  connect: vi.fn(),
  live: vi.fn(),
  secret: vi.fn(),
  workspace: { state: "ready", init_stage: null as string | null },
}));
vi.mock("@deus-hq/sdk", async (original) => ({
  ...(await original<typeof import("@deus-hq/sdk")>()),
  getWorkspace: mocks.get,
  resumeWorkspace: mocks.resume,
  createWorkspace: mocks.create,
  createSecret: mocks.secret,
  listSecrets: async function* () {},
}));
vi.mock("../../../src/services/agent/cloud/config", async () =>
  (await import("../../cloud-config-mock")).cloudConfigMock(mocks.config)
);
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
      run: (...args: unknown[]) => {
        if (sql.startsWith("UPDATE workspaces SET init_stage =")) {
          mocks.workspace.init_stage = args[0] as string | null;
        }
        return mocks.run(...args);
      },
      get: () =>
        sql.includes("AS chat")
          ? { chat: "session" }
          : sql.includes("init_stage")
            ? mocks.workspace
            : { last_inline_mint_at: 0 },
    }),
  }),
}));
vi.mock("../../../src/services/query-engine", () => ({ invalidate: vi.fn() }));

import {
  clearGithubTokenRefreshFlights,
  refreshWorkspaceGithubToken,
  wakeCloudWorkspaceWithFeedback as wake,
} from "../../../src/services/cloud-workspace-init.service";
import { forgetGithubAnswers } from "../../../src/services/github-remote";

const wakeCloudWorkspaceWithFeedback = (workspace: Parameters<typeof wake>[0]) =>
  wake(workspace, () => true);

beforeEach(() => {
  vi.resetAllMocks();
  forgetGithubAnswers();
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
    ).toEqual({ ok: false, status: "error", error: "provider unavailable" });
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

  it.each(["error", "paused", "stopped", "resuming"])(
    "keeps a confirmed running computer available after clearing a stale %s stage",
    async (stage) => {
      mocks.workspace.init_stage = stage;
      mocks.get.mockResolvedValue({ status: "running" });
      mocks.live.mockReturnValue(true);
      mocks.resume.mockRejectedValue(new Error("resume unavailable"));
      expect(
        await wakeCloudWorkspaceWithFeedback({
          id: "ws",
          provider_workspace_id: "vm",
          current_session_id: "session",
        })
      ).toEqual({ ok: false, status: "running" });
      expect(mocks.workspace.init_stage).toBeNull();
      expect(mocks.run).toHaveBeenCalledExactlyOnceWith(null, "ws");
      expect(mocks.announce).not.toHaveBeenCalled();
    }
  );

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
      ).toEqual({ ok: false, status: expected, error: "resume failed" });
      expect(mocks.run).toHaveBeenLastCalledWith(expected, "ws");
    }
  );

  it.each(["running", null])(
    "gates recovery if the channel closes during refresh after a %s status",
    async (status) => {
      mocks.get.mockResolvedValue({ status });
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
      ).toEqual({ ok: false, status: "error", error: "resume failed" });
      expect(mocks.run).toHaveBeenLastCalledWith("error", "ws");
    }
  );
});

describe("cloud credential provenance", () => {
  it.each([false, true])(
    "omits the source update without a desktop session (named=%s)",
    async (named) => {
      mocks.environment.mockResolvedValue(
        named ? { configured: true, environmentId: "env", name: "env-name" } : { configured: false }
      );
      await refreshWorkspaceGithubToken({ repository_id: "repo", provider_workspace_id: "vm" });
      expect(mocks.create).toHaveBeenCalledOnce();
      // An undefined source is omitted on the wire, preserving the runtime choice.
      expect(mocks.create.mock.calls[0][0].repositoryAuth).toBeUndefined();
    }
  );
});

describe("organizations", () => {
  const ORGS = {
    baseUrl: "https://cloud.test",
    deusCloudUrl: "https://deus.test",
    deusCloudSessionToken: "session",
    orgKeys: { org_a: "key_a", org_b: "key_b" },
  };

  it("wakes a workspace with its own organization's key, and a row with none with the default's", async () => {
    mocks.config.mockReturnValue(ORGS);
    mocks.get.mockResolvedValue({ status: "paused" });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 503 }))
    );
    try {
      await wakeCloudWorkspaceWithFeedback({
        id: "ws",
        provider_workspace_id: "vm_b",
        current_session_id: "session",
        organization_id: "org_b",
      });
      await wakeCloudWorkspaceWithFeedback({
        id: "ws",
        provider_workspace_id: "vm_old",
        current_session_id: "session",
        organization_id: null,
      });
    } finally {
      vi.unstubAllGlobals();
    }
    expect(mocks.get.mock.calls.map(([id, auth]) => [id, auth.apiKey])).toEqual([
      ["vm_b", "key_b"],
      ["vm_old", "key_a"],
    ]);
    expect(mocks.resume.mock.calls.map(([id, auth]) => [id, auth.apiKey])).toEqual([
      ["vm_b", "key_b"],
      ["vm_old", "key_a"],
    ]);
  });

  it("asks the GitHub mint for each workspace's organization, never sharing a flight across them", async () => {
    mocks.config.mockReturnValue(ORGS);
    mocks.environment.mockResolvedValue({
      configured: true,
      environmentId: "env",
      name: "repo-env",
    });
    const minted: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL) => {
        minted.push(String(url));
        await gate;
        return Response.json({ token: `ghs_${minted.length}` });
      })
    );
    try {
      const a = refreshWorkspaceGithubToken({
        repository_id: "repo",
        provider_workspace_id: "vm_a",
        organization_id: "org_a",
      });
      const b = refreshWorkspaceGithubToken({
        repository_id: "repo",
        provider_workspace_id: "vm_b",
        organization_id: "org_b",
      });
      await vi.waitFor(() => expect(minted).toHaveLength(2));
      release();
      await Promise.all([a, b]);
    } finally {
      vi.unstubAllGlobals();
    }
    expect(minted.sort()).toEqual([
      "https://deus.test/orgs/org_a/github/installation-token",
      "https://deus.test/orgs/org_b/github/installation-token",
    ]);
    // Each organization's environment secret is written with its own key.
    expect(mocks.secret.mock.calls.map(([, , auth]) => auth.apiKey).sort()).toEqual([
      "key_a",
      "key_b",
    ]);
    expect(mocks.environment.mock.calls.map(([, orgId]) => orgId).sort()).toEqual([
      "org_a",
      "org_b",
    ]);
  });
});
