import { vi, describe, it, expect, beforeEach } from "vitest";
import { Hono } from "hono";
import { errorHandler } from "../../../src/middleware/error-handler";

// ─── Hoisted mocks (vi.mock factories run before imports) ─────────

const { mockStmt, mockDb, mockExecFileAsync, mockInitializeWorkspace, mockInvalidate } = vi.hoisted(
  () => {
    const mockStmt = {
      all: vi.fn(() => []),
      get: vi.fn(),
      run: vi.fn(() => ({ changes: 1 })),
    };
    const mockDb = {
      prepare: vi.fn(() => mockStmt),
      transaction: vi.fn((fn: Function) => fn),
    };
    const mockExecFileAsync = vi.fn(() => Promise.resolve({ stdout: "", stderr: "" }));
    const mockInitializeWorkspace = vi.fn(() => Promise.resolve());
    const mockInvalidate = vi.fn();
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
  getDatabase: vi.fn(() => mockDb),
}));

vi.mock("../../../src/services/workspace.service", () => ({
  generateUniqueName: vi.fn(() => "europa"),
}));

vi.mock("../../../src/services/workspace-init.service", () => ({
  initializeWorkspace: (...args: unknown[]) => mockInitializeWorkspace(...args),
}));

vi.mock("../../../src/services/query-engine", () => ({
  invalidate: (...args: unknown[]) => mockInvalidate(...args),
}));

vi.mock("../../../src/services/git.service", () => ({
  detectDefaultBranch: vi.fn(() => "main"),
  getDiffStats: vi.fn(() => ({ additions: 0, deletions: 0 })),
  getDiffFiles: vi.fn(() => ({ files: [], truncated: false, total_count: 0 })),
  getMergeBase: vi.fn(() => "abc123"),
  getGitFileContent: vi.fn(() => null),
  resolveWorkspaceRelativePath: vi.fn((p: string) => p),
  getOpenCommand: vi.fn(() => "open"),
}));

vi.mock("child_process", () => ({
  execSync: vi.fn(() => "testuser"),
  execFile: vi.fn(),
  spawn: vi.fn(),
}));

vi.mock("util", () => ({
  promisify: () => mockExecFileAsync,
}));

vi.mock("@shared/lib/uuid", () => ({
  uuidv7: vi.fn(() => "ws-test-uuid"),
}));

vi.mock("fs", () => ({
  default: {
    existsSync: vi.fn(() => false),
    createWriteStream: vi.fn(() => ({ on: vi.fn(), end: vi.fn() })),
    mkdirSync: vi.fn(),
    realpathSync: vi.fn((p: string) => p),
    readFileSync: vi.fn(() => ""),
    writeFileSync: vi.fn(),
    statSync: vi.fn(() => ({ isDirectory: () => true, isFile: () => false })),
    constants: { R_OK: 4, X_OK: 1 },
  },
  existsSync: vi.fn(() => false),
  createWriteStream: vi.fn(() => ({ on: vi.fn(), end: vi.fn() })),
  mkdirSync: vi.fn(),
  realpathSync: vi.fn((p: string) => p),
  readFileSync: vi.fn(() => ""),
  writeFileSync: vi.fn(),
  statSync: vi.fn(() => ({ isDirectory: () => true, isFile: () => false })),
  constants: { R_OK: 4, X_OK: 1 },
}));

vi.mock("os", () => ({
  default: { tmpdir: vi.fn(() => "/tmp") },
  tmpdir: vi.fn(() => "/tmp"),
}));

import workspacesRoutes from "../../../src/routes/workspaces";

const app = new Hono();
app.route("/", workspacesRoutes);
app.onError(errorHandler);

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
  title: null,
  title_source: "slug",
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

// ─── POST /workspaces ─────────────────────────────────────────────

describe("POST /workspaces", () => {
  it("returns 400 when repository_id is missing", async () => {
    const res = await app.request("/workspaces", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it("returns 400 when repository_id is empty string", async () => {
    const res = await app.request("/workspaces", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ repository_id: "" }),
    });
    expect(res.status).toBe(400);
  });

  it("returns 404 when repository does not exist", async () => {
    mockStmt.get.mockReturnValueOnce(undefined);

    const res = await app.request("/workspaces", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ repository_id: "nonexistent" }),
    });
    expect(res.status).toBe(404);
  });

  it("returns 200 with new workspace on success", async () => {
    mockStmt.get.mockReturnValueOnce(MOCK_REPO).mockReturnValueOnce(MOCK_CREATED_WORKSPACE);

    const res = await app.request("/workspaces", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ repository_id: "repo-001" }),
    });
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.id).toBe("ws-test-uuid");
    expect(body.slug).toBe("europa");
    expect(body.state).toBe("initializing");
  });

  it("creates workspace in initializing state", async () => {
    mockStmt.get.mockReturnValueOnce(MOCK_REPO).mockReturnValueOnce(MOCK_CREATED_WORKSPACE);

    await app.request("/workspaces", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ repository_id: "repo-001" }),
    });

    // Verify INSERT run args include 'initializing'
    const insertRun = mockStmt.run.mock.calls.find((c: unknown[]) => c.includes("initializing"));
    expect(insertRun).toBeTruthy();
  });

  it("stores PR titles with pr title source on creation", async () => {
    mockStmt.get.mockReturnValueOnce(MOCK_REPO).mockReturnValueOnce({
      ...MOCK_CREATED_WORKSPACE,
      title: "Fix workspace title promotion",
      title_source: "pr",
    });

    await app.request("/workspaces", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        repository_id: "repo-001",
        source_branch: "main",
        pr_title: "Fix workspace title promotion",
      }),
    });

    const insertRun = mockStmt.run.mock.calls.find((c: unknown[]) =>
      c.includes("Fix workspace title promotion")
    );
    expect(insertRun).toBeTruthy();
    expect(insertRun).toContain("pr");
  });

  it("stores slug title source when no PR title is provided", async () => {
    mockStmt.get.mockReturnValueOnce(MOCK_REPO).mockReturnValueOnce(MOCK_CREATED_WORKSPACE);

    await app.request("/workspaces", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ repository_id: "repo-001" }),
    });

    const insertRun = mockStmt.run.mock.calls.find((c: unknown[]) => c.includes("slug"));
    expect(insertRun).toBeTruthy();
  });

  it("fetches origin/<parent_branch> before creating worktree", async () => {
    mockStmt.get.mockReturnValueOnce(MOCK_REPO).mockReturnValueOnce(MOCK_CREATED_WORKSPACE);

    await app.request("/workspaces", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ repository_id: "repo-001" }),
    });

    expect(mockExecFileAsync).toHaveBeenCalledWith(
      "git",
      ["fetch", "origin", "main"],
      expect.objectContaining({ cwd: "/repos/my-project" })
    );
  });

  it("uses origin/<parent_branch> as worktree base when remote exists", async () => {
    mockStmt.get.mockReturnValueOnce(MOCK_REPO).mockReturnValueOnce(MOCK_CREATED_WORKSPACE);

    // Both fetch and show-ref succeed
    mockExecFileAsync.mockResolvedValue({ stdout: "", stderr: "" });

    await app.request("/workspaces", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ repository_id: "repo-001" }),
    });

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
    mockStmt.get.mockReturnValueOnce(MOCK_REPO).mockReturnValueOnce(MOCK_CREATED_WORKSPACE);

    // fetch succeeds, show-ref fails (no remote branch)
    mockExecFileAsync
      .mockResolvedValueOnce({ stdout: "", stderr: "" })
      .mockRejectedValueOnce(new Error("not a valid ref"));

    await app.request("/workspaces", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ repository_id: "repo-001" }),
    });

    expect(mockInitializeWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({ worktreeBase: "main" })
    );
  });

  it("continues creation when git fetch fails (offline)", async () => {
    mockStmt.get.mockReturnValueOnce(MOCK_REPO).mockReturnValueOnce(MOCK_CREATED_WORKSPACE);

    // fetch fails, show-ref also fails
    mockExecFileAsync
      .mockRejectedValueOnce(new Error("network unreachable"))
      .mockRejectedValueOnce(new Error("not a valid ref"));

    const res = await app.request("/workspaces", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ repository_id: "repo-001" }),
    });

    expect(res.status).toBe(200);
    expect(mockInitializeWorkspace).toHaveBeenCalled();
  });

  it("fires init pipeline async (returns before pipeline completes)", async () => {
    mockStmt.get.mockReturnValueOnce(MOCK_REPO).mockReturnValueOnce(MOCK_CREATED_WORKSPACE);

    // Pipeline is slow
    mockInitializeWorkspace.mockImplementation(
      () => new Promise((resolve) => setTimeout(resolve, 5000))
    );

    const res = await app.request("/workspaces", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ repository_id: "repo-001" }),
    });

    // Response should return immediately
    expect(res.status).toBe(200);
    expect(mockInitializeWorkspace).toHaveBeenCalled();
  });

  it("passes correct context to init pipeline", async () => {
    mockStmt.get.mockReturnValueOnce(MOCK_REPO).mockReturnValueOnce(MOCK_CREATED_WORKSPACE);

    await app.request("/workspaces", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ repository_id: "repo-001" }),
    });

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
    mockStmt.get.mockReturnValueOnce(MOCK_REPO).mockReturnValueOnce(MOCK_CREATED_WORKSPACE);

    await app.request("/workspaces", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ repository_id: "repo-001" }),
    });

    expect(mockInitializeWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({ branchName: "testuser/europa" })
    );
  });

  it("includes computed workspace_path in response", async () => {
    mockStmt.get.mockReturnValueOnce(MOCK_REPO).mockReturnValueOnce(MOCK_CREATED_WORKSPACE);

    const res = await app.request("/workspaces", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ repository_id: "repo-001" }),
    });

    const body = await res.json();
    expect(body.workspace_path).toBe("/repos/my-project/.deus/europa");
  });

  it("uses repo git_default_branch as parent_branch", async () => {
    const repoWithDev = { ...MOCK_REPO, git_default_branch: "develop" };
    mockStmt.get
      .mockReturnValueOnce(repoWithDev)
      .mockReturnValueOnce({ ...MOCK_CREATED_WORKSPACE, git_target_branch: "develop" });

    mockExecFileAsync.mockResolvedValue({ stdout: "", stderr: "" });

    await app.request("/workspaces", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ repository_id: "repo-001" }),
    });

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
    mockStmt.get
      .mockReturnValueOnce({ ...MOCK_REPO, git_default_branch: null })
      .mockReturnValueOnce(MOCK_CREATED_WORKSPACE);

    await app.request("/workspaces", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ repository_id: "repo-001" }),
    });

    expect(mockInitializeWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({ parentBranch: "main" })
    );
  });
});

describe("PATCH /workspaces/:id", () => {
  it("rejects session-only state values like working", async () => {
    const res = await app.request("/workspaces/ws-test-uuid", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ state: "working" }),
    });

    expect(res.status).toBe(400);
    expect(mockStmt.run).not.toHaveBeenCalled();
  });

  it("accepts canonical workspace state values from shared enums", async () => {
    mockStmt.get.mockReturnValueOnce({ ...MOCK_CREATED_WORKSPACE, state: "ready" });

    const res = await app.request("/workspaces/ws-test-uuid", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ state: "ready" }),
    });

    expect(res.status).toBe(200);
    expect(mockStmt.run).toHaveBeenCalledWith("ready", "ws-test-uuid");
    expect(mockInvalidate).toHaveBeenCalledWith(["workspaces", "sessions", "stats"]);
  });
});
