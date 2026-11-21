import Database from "better-sqlite3";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SCHEMA_SQL } from "@shared/schema";
import {
  createCloudWorkspace,
  retryCloudWorkspace,
} from "../../../src/services/cloud-workspace-init.service";

let db: Database.Database;
const mock = vi.hoisted(() => ({
  invalidate: vi.fn(),
  publicRepo: vi.fn(),
  createSession: vi.fn(),
  connect: vi.fn(),
}));
vi.mock("../../../src/lib/database", () => ({ getDatabase: () => db }));
vi.mock("../../../src/services/query-engine", () => ({ invalidate: mock.invalidate }));
vi.mock("../../../src/services/agent/cloud/config", async () =>
  (await import("../../cloud-config-mock")).cloudConfigMock(() => ({
    baseUrl: "https://platform.test",
    apiKey: "key",
    orgId: "org",
    deusCloudUrl: "https://cloud.test",
    deusCloudSessionToken: "session",
  }))
);
vi.mock("../../../src/services/github-remote", () => ({
  mintRepoInstallationToken: async () => ({ definitive: true, token: null }),
  isPublicGithubRepo: mock.publicRepo,
}));
vi.mock("../../../src/services/cloud-settings.service", () => ({
  getCloudWorkspaceUserId: async () => "user",
}));
vi.mock("../../../src/services/cloud-environment.service", () => ({
  getCloudEnvironmentInfo: async () => ({}),
}));
vi.mock("../../../src/services/agent/cloud/driver", () => ({ ensureCloudSession: mock.connect }));
vi.mock("@deus-hq/sdk", async (original) => ({
  ...(await original<typeof import("@deus-hq/sdk")>()),
  createWorkspace: async () => ({ id: "vm" }),
  createSession: mock.createSession,
}));

beforeEach(() => {
  vi.resetAllMocks();
  db = new Database(":memory:");
  db.exec(SCHEMA_SQL);
  db.exec(
    "INSERT INTO repositories (id, name, git_origin_url) VALUES ('r', 'repo', 'https://github.com/acme/repo')"
  );
});
afterEach(() => db.close());

it("publishes the committed row at create, refusal, retry, computer attachment and chat attachment", async () => {
  // Read what a synchronous subscriber can see, including the chat in the same commit.
  const observed: unknown[] = [];
  const row = db.prepare(`
    SELECT w.state, w.init_stage, w.error_message, w.error_detail, w.init_fetch_issue, w.setup_status,
           w.provider_workspace_id, w.last_inline_mint_at, s.provider_session_id
    FROM workspaces w LEFT JOIN sessions s ON s.id = w.current_session_id`);
  mock.invalidate.mockImplementation(() => observed.push(row.get()));
  mock.publicRepo.mockResolvedValue(false);
  const { workspaceId } = createCloudWorkspace({ repositoryId: "r" });
  await vi.waitFor(() => expect(observed).toHaveLength(2));
  mock.publicRepo.mockResolvedValue(true);
  mock.createSession.mockResolvedValue({ id: "platform-chat" });
  retryCloudWorkspace(workspaceId);
  await vi.waitFor(() => expect(mock.connect).toHaveBeenCalledOnce());

  const creating = {
    state: "initializing",
    init_stage: "creating cloud workspace",
    error_message: null,
    error_detail: null,
    init_fetch_issue: null,
    setup_status: "none",
    provider_workspace_id: null,
    last_inline_mint_at: null,
    provider_session_id: null,
  };
  const attached = {
    ...creating,
    init_stage: "creating cloud session",
    provider_workspace_id: "vm",
    last_inline_mint_at: 0,
  };
  expect(observed).toEqual([
    creating,
    {
      ...creating,
      state: "error",
      error_message:
        "GitHub access required — install the Deus GitHub App for acme/repo to run it in the cloud.",
    },
    creating,
    attached,
    { ...attached, init_stage: "provisioning sandbox", provider_session_id: "platform-chat" },
  ]);
  expect(mock.invalidate.mock.calls).toEqual(
    observed.map(() => [["workspaces", "sessions", "session"], {}])
  );
});

it("keeps the allocated computer and last stage when chat creation fails", async () => {
  mock.publicRepo.mockResolvedValue(true);
  mock.createSession.mockRejectedValue(new Error("chat unavailable"));
  const { workspaceId } = createCloudWorkspace({ repositoryId: "r" });
  await vi.waitFor(() => expect(mock.invalidate).toHaveBeenCalledTimes(3));
  expect(
    db
      .prepare(
        "SELECT state, init_stage, provider_workspace_id, current_session_id, error_message FROM workspaces WHERE id = ?"
      )
      .get(workspaceId)
  ).toEqual({
    state: "error",
    init_stage: "creating cloud session",
    provider_workspace_id: "vm",
    current_session_id: null,
    error_message: "Cloud provisioning failed: chat unavailable",
  });
  expect(mock.invalidate.mock.calls).toEqual(
    Array(3).fill([["workspaces", "sessions", "session"], {}])
  );
  expect(() => retryCloudWorkspace(workspaceId)).toThrow("not waiting for a retry");
  expect(mock.invalidate).toHaveBeenCalledTimes(3);
});
