import { vi, describe, it, expect, beforeEach } from "vitest";
import * as api from "@shared/api/workspaces";
import { operations } from "../../helpers";

// ─── Hoisted mocks (vi.mock factories run before imports) ─────────

const { mockStmt, mockDb, mockExecFileAsync, mockInitializeWorkspace, mockInvalidate } = vi.hoisted(
  () => {
    const mockStmt = {
      all: vi.fn<(...args: any[]) => any>(() => []),
      get: vi.fn<(...args: any[]) => any>(),
      run: vi.fn<(...args: any[]) => any>(() => ({ changes: 1 })),
    };
    const mockDb = {
      prepare: vi.fn<(...args: any[]) => any>(() => mockStmt),
      transaction: vi.fn<(...args: any[]) => any>((fn: Function) => fn),
    };
    const mockExecFileAsync = vi.fn<(...args: any[]) => any>(() =>
      Promise.resolve({ stdout: "", stderr: "" })
    );
    const mockInitializeWorkspace = vi.fn<(...args: any[]) => any>(() => Promise.resolve());
    const mockInvalidate = vi.fn<(...args: any[]) => any>();
    return {
      mockStmt,
      mockDb,
      mockExecFileAsync,
      mockInitializeWorkspace,
      mockInvalidate,
    };
  }
);

vi.mock("../../../src/lib/database", () => ({
  getDatabase: vi.fn<(...args: any[]) => any>(() => mockDb),
}));

vi.mock("../../../src/services/workspace.service", () => ({
  generateUniqueName: vi.fn<(...args: any[]) => any>(() => "europa"),
}));

vi.mock("../../../src/services/workspace-init.service", () => ({
  initializeWorkspace: (...args: unknown[]) => mockInitializeWorkspace(...args),
}));

vi.mock("../../../src/services/query-engine", () => ({
  invalidate: (...args: unknown[]) => mockInvalidate(...args),
}));

const cloud = vi.hoisted(() => ({ pause: vi.fn(), wake: vi.fn() }));
vi.mock("../../../src/services/cloud-workspace-init.service", () => ({
  createCloudWorkspace: vi.fn(),
  pauseCloudWorkspace: cloud.pause,
  wakeCloudWorkspaceWithFeedback: cloud.wake,
}));

vi.mock("../../../src/services/git.service", () => ({
  detectDefaultBranch: vi.fn<(...args: any[]) => any>(() => "main"),
  getDiffStats: vi.fn<(...args: any[]) => any>(() => ({ additions: 0, deletions: 0 })),
  getDiffFiles: vi.fn<(...args: any[]) => any>(() => ({
    files: [],
    truncated: false,
    total_count: 0,
  })),
  getMergeBase: vi.fn<(...args: any[]) => any>(() => "abc123"),
  getGitFileContent: vi.fn<(...args: any[]) => any>(() => null),
  resolveWorkspaceRelativePath: vi.fn<(...args: any[]) => any>((p: string) => p),
  getOpenCommand: vi.fn<(...args: any[]) => any>(() => "open"),
}));

vi.mock("child_process", () => ({
  execSync: vi.fn<(...args: any[]) => any>(() => "testuser"),
  execFile: vi.fn<(...args: any[]) => any>(),
  spawn: vi.fn<(...args: any[]) => any>(),
}));

vi.mock("util", () => ({
  promisify: () => mockExecFileAsync,
}));

vi.mock("@shared/lib/uuid", () => ({
  uuidv7: vi.fn<(...args: any[]) => any>(() => "ws-test-uuid"),
}));

vi.mock("fs", () => ({
  default: {
    existsSync: vi.fn<(...args: any[]) => any>(() => false),
    createWriteStream: vi.fn<(...args: any[]) => any>(() => ({
      on: vi.fn<(...args: any[]) => any>(),
      end: vi.fn<(...args: any[]) => any>(),
    })),
    mkdirSync: vi.fn<(...args: any[]) => any>(),
    realpathSync: vi.fn<(...args: any[]) => any>((p: string) => p),
    readFileSync: vi.fn<(...args: any[]) => any>(() => ""),
    writeFileSync: vi.fn<(...args: any[]) => any>(),
    statSync: vi.fn<(...args: any[]) => any>(() => ({
      isDirectory: () => true,
      isFile: () => false,
    })),
    constants: { R_OK: 4, X_OK: 1 },
  },
  existsSync: vi.fn<(...args: any[]) => any>(() => false),
  createWriteStream: vi.fn<(...args: any[]) => any>(() => ({
    on: vi.fn<(...args: any[]) => any>(),
    end: vi.fn<(...args: any[]) => any>(),
  })),
  mkdirSync: vi.fn<(...args: any[]) => any>(),
  realpathSync: vi.fn<(...args: any[]) => any>((p: string) => p),
  readFileSync: vi.fn<(...args: any[]) => any>(() => ""),
  writeFileSync: vi.fn<(...args: any[]) => any>(),
  statSync: vi.fn<(...args: any[]) => any>(() => ({
    isDirectory: () => true,
    isFile: () => false,
  })),
  constants: { R_OK: 4, X_OK: 1 },
}));

vi.mock("os", () => ({
  default: { tmpdir: vi.fn<(...args: any[]) => any>(() => "/tmp") },
  tmpdir: vi.fn<(...args: any[]) => any>(() => "/tmp"),
}));

import workspaceHandlers from "../../../src/api/workspaces";

const run = operations(workspaceHandlers);
const create = (input: Record<string, unknown> = { repository_id: "repo-001" }) =>
  run(api.createWorkspace, input as never);

// ─── Fixtures ─────────────────────────────────────────────────────

const MOCK_REPO = {
  id: "repo-001",
  name: "my-project",
  root_path: "/repos/my-project",
  git_default_branch: "main",
  sort_order: 0,
  updated_at: "2024-01-01T00:00:00Z",
};

const MOCK_CREATED_WORKSPACE = {
  id: "ws-test-uuid",
  repository_id: "repo-001",
  slug: "europa",
  git_branch: "testuser/europa",
  git_target_branch: "main",
  state: "initializing",
  current_session_id: null,
  init_stage: null,
  repo_name: "my-project",
  root_path: "/repos/my-project",
  updated_at: "2024-01-01T00:00:00Z",
};

// ─── Setup ────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  mockDb.prepare.mockReturnValue(mockStmt);
  mockDb.transaction.mockImplementation((fn: Function) => fn);
  mockInitializeWorkspace.mockResolvedValue(undefined);
  mockExecFileAsync.mockResolvedValue({ stdout: "", stderr: "" });
});

// ─── createWorkspace ──────────────────────────────────────────────

describe("createWorkspace", () => {
  it("refuses a request with no repository_id", async () => {
    await expect(create({})).rejects.toMatchObject({
      statusCode: 400,
      message: "createWorkspace requires repository_id",
    });
  });

  it("refuses an empty repository_id", async () => {
    await expect(create({ repository_id: "" })).rejects.toMatchObject({ statusCode: 400 });
  });

  it("refuses a repository that does not exist", async () => {
    mockStmt.get.mockReturnValueOnce(undefined);

    await expect(create({ repository_id: "nonexistent" })).rejects.toMatchObject({
      statusCode: 404,
    });
  });

  it("answers with the new workspace's id and tells subscribers", async () => {
    mockStmt.get.mockReturnValueOnce(MOCK_REPO);

    expect(await create()).toEqual({ workspaceId: "ws-test-uuid" });
    expect(mockInvalidate).toHaveBeenCalledWith(["workspaces", "stats"]);
  });

  it("creates workspace in initializing state", async () => {
    mockStmt.get.mockReturnValueOnce(MOCK_REPO);

    await create();

    // Verify INSERT run args include 'initializing'
    const insertRun = mockStmt.run.mock.calls.find((c: unknown[]) => c.includes("initializing"));
    expect(insertRun).toBeTruthy();
  });

  it("fetches origin/<parent_branch> before creating worktree", async () => {
    mockStmt.get.mockReturnValueOnce(MOCK_REPO);

    await create();

    expect(mockExecFileAsync).toHaveBeenCalledWith(
      "git",
      ["fetch", "origin", "main"],
      expect.objectContaining({ cwd: "/repos/my-project" })
    );
  });

  it("uses origin/<parent_branch> as worktree base when remote exists", async () => {
    mockStmt.get.mockReturnValueOnce(MOCK_REPO);

    // Both fetch and show-ref succeed
    mockExecFileAsync.mockResolvedValue({ stdout: "", stderr: "" });

    await create();

    // Should verify origin/main via show-ref
    expect(mockExecFileAsync).toHaveBeenCalledWith(
      "git",
      ["show-ref", "--verify", "--quiet", "refs/remotes/origin/main"],
      expect.any(Object)
    );

    // initializeWorkspace should receive origin/main as worktreeBase
    expect(mockInitializeWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({ worktreeBase: "origin/main" })
    );
  });

  it("falls back to local branch when origin/<parent> does not exist", async () => {
    mockStmt.get.mockReturnValueOnce(MOCK_REPO);

    // fetch succeeds, show-ref fails (no remote branch)
    mockExecFileAsync
      .mockResolvedValueOnce({ stdout: "", stderr: "" })
      .mockRejectedValueOnce(new Error("not a valid ref"));

    await create();

    expect(mockInitializeWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({ worktreeBase: "main" })
    );
  });

  it("continues creation when git fetch fails (offline)", async () => {
    mockStmt.get.mockReturnValueOnce(MOCK_REPO);

    // fetch fails, show-ref also fails
    mockExecFileAsync
      .mockRejectedValueOnce(new Error("network unreachable"))
      .mockRejectedValueOnce(new Error("not a valid ref"));

    expect(await create()).toEqual({ workspaceId: "ws-test-uuid" });
    expect(mockInitializeWorkspace).toHaveBeenCalled();
  });

  it("fires init pipeline async (returns before pipeline completes)", async () => {
    mockStmt.get.mockReturnValueOnce(MOCK_REPO);

    // Pipeline is slow
    mockInitializeWorkspace.mockImplementation(
      () => new Promise((resolve) => setTimeout(resolve, 5000))
    );

    // Answers at once, without waiting for the pipeline.
    expect(await create()).toEqual({ workspaceId: "ws-test-uuid" });
    expect(mockInitializeWorkspace).toHaveBeenCalled();
  });

  it("passes correct context to init pipeline", async () => {
    mockStmt.get.mockReturnValueOnce(MOCK_REPO);

    await create();

    expect(mockInitializeWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "ws-test-uuid",
        repositoryId: "repo-001",
        repoRootPath: "/repos/my-project",
        workspacePath: "/repos/my-project/.deus/europa",
        branchName: "testuser/europa",
        parentBranch: "main",
      })
    );
  });

  it("uses git username as branch prefix", async () => {
    mockStmt.get.mockReturnValueOnce(MOCK_REPO);

    await create();

    expect(mockInitializeWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({ branchName: "testuser/europa" })
    );
  });

  it("uses repo git_default_branch as parent_branch", async () => {
    const repoWithDev = { ...MOCK_REPO, git_default_branch: "develop" };
    mockStmt.get.mockReturnValueOnce(repoWithDev);

    mockExecFileAsync.mockResolvedValue({ stdout: "", stderr: "" });

    await create();

    // Should fetch origin/develop
    expect(mockExecFileAsync).toHaveBeenCalledWith(
      "git",
      ["fetch", "origin", "develop"],
      expect.any(Object)
    );

    expect(mockInitializeWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({ parentBranch: "develop" })
    );
  });

  it("defaults parent_branch to main when repo has no git_default_branch", async () => {
    mockStmt.get.mockReturnValueOnce({ ...MOCK_REPO, git_default_branch: null });

    await create();

    expect(mockInitializeWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({ parentBranch: "main" })
    );
  });
});

describe("updateWorkspace", () => {
  it("rejects session-only state values like working", async () => {
    await expect(
      run(api.updateWorkspace, { workspaceId: "ws-test-uuid", state: "working" as never })
    ).rejects.toMatchObject({ statusCode: 400 });
    expect(mockStmt.run).not.toHaveBeenCalled();
  });

  it("accepts canonical workspace state values from shared enums", async () => {
    mockStmt.get.mockReturnValueOnce({ ...MOCK_CREATED_WORKSPACE, state: "ready" });

    await run(api.updateWorkspace, { workspaceId: "ws-test-uuid", state: "ready" });

    expect(mockDb.prepare).toHaveBeenCalledWith(
      "UPDATE workspaces SET state = 'ready' WHERE id = ?"
    );
    expect(mockStmt.run).toHaveBeenCalledWith("ws-test-uuid");
    expect(mockInvalidate).toHaveBeenCalledWith(["workspaces", "sessions", "stats"]);
  });
});

describe("cloud wake and archive ordering", () => {
  function cloudRow() {
    let state = "ready";
    mockStmt.get.mockImplementation(() => ({
      ...MOCK_CREATED_WORKSPACE,
      kind: "cloud",
      provider_workspace_id: "agnt-workspace",
      root_path: null,
      state,
    }));
    mockDb.prepare.mockImplementation((sql: string) => {
      if (sql === "UPDATE workspaces SET state = 'archived' WHERE id = ?") {
        return {
          run: () => {
            state = "archived";
          },
        };
      }
      return mockStmt;
    });
    return () => state;
  }

  const archive = () =>
    run(api.updateWorkspace, { workspaceId: "ws-test-uuid", state: "archived" });
  // Settled rather than awaited: one of the two is expected to be refused.
  const wake = () =>
    run(api.wakeCloudWorkspace, { workspaceId: "ws-test-uuid" }).then(
      (answer) => ({ answer }),
      (error: Error & { statusCode?: number }) => ({ error })
    );

  it("rechecks archived membership when a wake was queued behind Pause", async () => {
    const state = cloudRow();
    let release!: () => void;
    cloud.pause.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        })
    );
    cloud.wake.mockResolvedValue({ ok: true, status: "resuming" });
    const archiving = archive();
    await vi.waitFor(() => expect(cloud.pause).toHaveBeenCalledOnce());
    const waking = wake();
    release();
    const [, woken] = await Promise.all([archiving, waking]);
    expect(woken).toMatchObject({
      error: { statusCode: 400, message: "Workspace is archived — unarchive it first" },
    });
    expect(cloud.wake).not.toHaveBeenCalled();
    expect(state()).toBe("archived");
  });

  it("finishes a prior wake before Pause so an archived workspace stays suspended", async () => {
    const state = cloudRow();
    let running = false;
    let release!: () => void;
    cloud.wake.mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      running = true;
      return { ok: true, status: "resuming" };
    });
    cloud.pause.mockImplementation(async () => {
      running = false;
    });
    const waking = wake();
    await vi.waitFor(() => expect(cloud.wake).toHaveBeenCalledOnce());
    const archiving = archive();
    // Let the archive request reach its first await before releasing Resume.
    await new Promise((resolve) => setImmediate(resolve));
    release();
    const [woken] = await Promise.all([waking, archiving]);
    expect(woken).toEqual({ answer: { ok: true, status: "resuming" } });
    expect(state()).toBe("archived");
    expect(running).toBe(false);
  });
});
