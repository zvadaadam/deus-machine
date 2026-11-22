import Database from "better-sqlite3";
import { SCHEMA_SQL } from "@shared/schema";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  config: vi.fn(),
  get: vi.fn(),
  resume: vi.fn(),
  create: vi.fn(),
  environment: vi.fn(),
  invalidate: vi.fn(),
  announce: vi.fn(),
  connect: vi.fn(),
  live: vi.fn(),
  secret: vi.fn(),
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
let db: Database.Database;
vi.mock("../../../src/lib/database", () => ({ getDatabase: () => db }));
vi.mock("../../../src/services/query-engine", () => ({ invalidate: mocks.invalidate }));

import {
  clearGithubTokenRefreshFlights,
  refreshWorkspaceGithubToken,
  wakeCloudWorkspaceWithFeedback,
} from "../../../src/services/cloud-workspace-init.service";
import { forgetGithubAnswers } from "../../../src/services/github-remote";

beforeEach(() => {
  vi.resetAllMocks();
  forgetGithubAnswers();
  db = new Database(":memory:");
  db.exec(SCHEMA_SQL);
  db.exec(`
    INSERT INTO repositories (id, name, git_origin_url) VALUES ('repo', 'repo', 'https://github.com/owner/repo');
    INSERT INTO workspaces (id, repository_id, slug, kind, state, current_session_id, provider_workspace_id, last_inline_mint_at)
      VALUES ('ws', 'repo', 'work', 'cloud', 'ready', 'session', 'vm', 0);
    INSERT INTO sessions (id, workspace_id) VALUES ('session', 'ws');
  `);
  clearGithubTokenRefreshFlights();
  mocks.config.mockReturnValue({ apiKey: "test", baseUrl: "https://cloud.test" });
  mocks.environment.mockResolvedValue({ configured: false });
  mocks.create.mockResolvedValue({ id: "vm", organizationId: "org" });
});

afterEach(() => db.close());

const stageOfWorkspace = () => db.prepare("SELECT init_stage FROM workspaces WHERE id='ws'").get();

describe("explicit cloud wake", () => {
  it.each([
    ["paused", "resuming", "resuming"],
    ["stopped", "resuming", "resuming"],
    ["error", "resuming", "resuming"],
    ["running", "running", null],
    [undefined, "resuming", "resuming"],
  ] as const)(
    "releases the hold for %s without requiring desktop mint context",
    async (status, response, stage) => {
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
      expect(result).toEqual({ ok: true, status: response });
      expect(stageOfWorkspace()).toEqual({ init_stage: stage });
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
    expect(stageOfWorkspace()).toEqual({ init_stage: "error" });
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
    expect(mocks.invalidate).not.toHaveBeenCalled();
    expect(mocks.announce).not.toHaveBeenCalled();
  });

  it.each(["error", "paused", "stopped", "resuming"])(
    "keeps a confirmed running computer available after clearing a stale %s stage",
    async (stage) => {
      db.prepare("UPDATE workspaces SET init_stage=? WHERE id='ws'").run(stage);
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
      expect(stageOfWorkspace()).toEqual({ init_stage: null });
      expect(mocks.invalidate).toHaveBeenCalledExactlyOnceWith(["workspaces"], {});
      expect(mocks.announce).not.toHaveBeenCalled();
    }
  );

  it.each([
    ["paused", "paused", "paused"],
    ["stopped", "stopped", "stopped"],
    ["error", "error", "error"],
    [null, "paused", "error"],
  ] as const)(
    "does not treat an open channel as proof that a %s computer is serving",
    async (status, before, expected) => {
      mocks.get.mockResolvedValue({ status });
      db.prepare("UPDATE workspaces SET init_stage=? WHERE id='ws'").run(before);
      mocks.live.mockReturnValue(true);
      mocks.resume.mockRejectedValue(new Error("resume failed"));
      expect(
        await wakeCloudWorkspaceWithFeedback({
          id: "ws",
          provider_workspace_id: "vm",
          current_session_id: "session",
        })
      ).toEqual({ ok: false, status: expected, error: "resume failed" });
      expect(stageOfWorkspace()).toEqual({ init_stage: expected });
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
      expect(stageOfWorkspace()).toEqual({ init_stage: "error" });
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
