import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  run: vi.fn(),
  get: vi.fn(),
  environment: vi.fn(),
  createWorkspace: vi.fn(),
  createSession: vi.fn(),
  connect: vi.fn(),
}));
vi.mock("../../../src/lib/database", () => ({
  getDatabase: () => ({
    prepare: () => ({ run: mocks.run, get: mocks.get }),
    transaction: (fn: () => void) => fn,
  }),
}));
vi.mock("../../../src/db", () => ({
  getRepositoryById: () => ({
    git_origin_url: "https://gitlab.com/team/app",
    git_default_branch: "main",
  }),
}));
vi.mock("../../../src/services/query-engine", () => ({ invalidate: vi.fn() }));
vi.mock("../../../src/services/workspace.service", () => ({
  generateUniqueName: () => "test-branch",
}));
vi.mock("../../../src/services/agent/cloud/driver", () => ({
  ensureCloudSession: mocks.connect,
  announceCloudEnv: vi.fn(),
  getCloudIdentityGeneration: () => 0,
}));
vi.mock("../../../src/services/cloud-environment.service", () => ({
  getCloudEnvironmentInfo: mocks.environment,
}));
vi.mock("@deus-hq/sdk", () => ({
  createWorkspace: mocks.createWorkspace,
  createSession: mocks.createSession,
  listSecrets: async function* () {},
}));

import {
  createCloudWorkspace,
  clearGithubTokenRefreshFlights,
  retryCloudWorkspace,
} from "../../../src/services/cloud-workspace-init.service";
import {
  resetCloudConfigForTests,
  setCloudRuntimeCredentials,
} from "../../../src/services/agent/cloud/config";

const environment = {
  configured: true,
  name: "shared-recipe",
  environmentId: "shared-environment-id",
  simulator: true,
};
beforeEach(() => {
  vi.clearAllMocks();
  resetCloudConfigForTests();
  clearGithubTokenRefreshFlights();
  setCloudRuntimeCredentials({
    baseUrl: "https://platform.test",
    apiKey: "alice-key",
    orgId: "org",
    deusCloudSessionToken: "alice-session",
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json({ account_id: "alice", items: [{ id: "org" }] }))
  );
  mocks.environment.mockResolvedValue(environment);
  mocks.createWorkspace.mockResolvedValue({ id: "provider-workspace" });
  mocks.createSession.mockResolvedValue({ id: "provider-session" });
});
afterEach(() => {
  resetCloudConfigForTests();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it("uses the verified human's secret scope and the exact shared recipe that was prepared", async () => {
  createCloudWorkspace({ repositoryId: "repo" });
  await vi.waitFor(() => expect(mocks.connect).toHaveBeenCalledOnce());
  expect(mocks.createWorkspace).toHaveBeenCalledWith(
    expect.objectContaining({
      apiKey: "alice-key",
      userId: "alice",
      // A same-name personal recipe must not shadow this resolved organization recipe.
      environment: "shared-environment-id",
    })
  );
});

it("stops creation when the human switches accounts during preparation", async () => {
  let finish!: (value: typeof environment) => void;
  mocks.environment.mockReturnValue(
    new Promise((resolve) => {
      finish = resolve;
    })
  );
  vi.spyOn(console, "error").mockImplementation(() => {});
  createCloudWorkspace({ repositoryId: "repo" });
  await vi.waitFor(() => expect(mocks.environment).toHaveBeenCalledOnce());
  setCloudRuntimeCredentials({ apiKey: "bob-key", deusCloudSessionToken: "bob-session" });
  finish(environment);
  await vi.waitFor(() =>
    expect(mocks.run).toHaveBeenCalledWith(
      expect.stringContaining("Your Deus account changed"),
      expect.any(String)
    )
  );
  expect(mocks.createWorkspace).not.toHaveBeenCalled();
  expect(mocks.createSession).not.toHaveBeenCalled();
});

it("provisions a failed cloud workspace again on the same row, on its own branch", async () => {
  mocks.get.mockReturnValue({
    repository_id: "repo",
    git_branch: "test-branch",
    git_target_branch: "release",
  });
  mocks.run.mockReturnValue({ changes: 1 });
  retryCloudWorkspace("workspace");
  await vi.waitFor(() => expect(mocks.connect).toHaveBeenCalledOnce());
  // The claim names the only rows it may take: failed, with no computer yet.
  expect(mocks.run).toHaveBeenCalledWith("workspace");
  expect(mocks.createWorkspace).toHaveBeenCalledWith(
    expect.objectContaining({ checkout: { branch: "test-branch", from: "release" } })
  );
});

it("does not provision twice, or over a computer that exists", () => {
  mocks.get.mockReturnValue({
    repository_id: "repo",
    git_branch: "test-branch",
    git_target_branch: "main",
  });
  // Nothing claimed: another retry took it, it is not failed, or it has a computer.
  mocks.run.mockReturnValue({ changes: 0 });
  expect(() => retryCloudWorkspace("workspace")).toThrow("not waiting for a retry");
  expect(mocks.createWorkspace).not.toHaveBeenCalled();
});

it("asks for sign-in instead of retrying while signed out", () => {
  resetCloudConfigForTests();
  expect(() => retryCloudWorkspace("workspace")).toThrow("Sign in to Deus Cloud");
  expect(mocks.run).not.toHaveBeenCalled();
});
