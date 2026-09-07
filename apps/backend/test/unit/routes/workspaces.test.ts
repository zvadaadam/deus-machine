import { vi, describe, it, expect, beforeEach } from "vitest";
import { Hono } from "hono";
import { errorHandler } from "../../../src/middleware/error-handler";

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
vi.mock("../../../src/services/aap", () => ({ stopAppsForWorkspace: vi.fn(async () => {}) }));

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

const fsMocks = vi.hoisted(() => ({
  existsSync: vi.fn<(...args: any[]) => any>(() => false),
  readFileSync: vi.fn<(...args: any[]) => any>(() => ""),
}));

vi.mock("fs", () => ({
  default: {
    existsSync: fsMocks.existsSync,
    createWriteStream: vi.fn<(...args: any[]) => any>(() => ({
      on: vi.fn<(...args: any[]) => any>(),
      end: vi.fn<(...args: any[]) => any>(),
    })),
    mkdirSync: vi.fn<(...args: any[]) => any>(),
    realpathSync: vi.fn<(...args: any[]) => any>((p: string) => p),
    readFileSync: fsMocks.readFileSync,
    writeFileSync: vi.fn<(...args: any[]) => any>(),
    statSync: vi.fn<(...args: any[]) => any>(() => ({
      isDirectory: () => true,
      isFile: () => false,
    })),
    constants: { R_OK: 4, X_OK: 1 },
  },
  existsSync: fsMocks.existsSync,
  createWriteStream: vi.fn<(...args: any[]) => any>(() => ({
    on: vi.fn<(...args: any[]) => any>(),
    end: vi.fn<(...args: any[]) => any>(),
  })),
  mkdirSync: vi.fn<(...args: any[]) => any>(),
  realpathSync: vi.fn<(...args: any[]) => any>((p: string) => p),
  readFileSync: fsMocks.readFileSync,
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
  fsMocks.existsSync.mockReturnValue(false);
  fsMocks.readFileSync.mockReturnValue("");
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
    app.request("/workspaces/ws-test-uuid", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ state: "archived" }),
    });
  const wake = () => app.request("/workspaces/ws-test-uuid/cloud-wake", { method: "POST" });

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
    const [archived, woken] = await Promise.all([archiving, waking]);
    expect(archived.status).toBe(200);
    expect(woken.status).toBe(400);
    expect(await woken.json()).toMatchObject({
      error: "Workspace is archived — unarchive it first",
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
    const [woken, archived] = await Promise.all([waking, archiving]);
    expect(woken.status).toBe(200);
    expect(archived.status).toBe(200);
    expect(state()).toBe("archived");
    expect(running).toBe(false);
  });
});

// ─── GET /workspaces/:id/manifest — cloud-kind guard ─────────────────
//
// Regression coverage for the withWorkspace contract: cloud rows pass through
// the middleware with workspacePath="" and a non-null root_path (the backend's
// on-disk clone). Local-FS routes must guard on workspace.kind and return
// manifest: null for cloud rows instead of serving the on-disk clone's deus.json.

describe("GET /workspaces/:id/manifest", () => {
  it("returns null manifest for a cloud workspace whose on-disk clone has a deus.json", async () => {
    mockStmt.get.mockReturnValue({
      ...MOCK_CREATED_WORKSPACE,
      kind: "cloud",
      provider_workspace_id: "agnt-workspace",
      root_path: "/repos/my-project", // NOT NULL in production (schema.ts:113) — the on-disk clone
      state: "ready",
    });
    // Simulate the on-disk clone carrying a deus.json — the route must NOT serve it.
    fsMocks.existsSync.mockImplementation((p: unknown) => String(p).endsWith("deus.json"));
    fsMocks.readFileSync.mockReturnValue(
      JSON.stringify({ version: 1, name: "my-project", tasks: { lint: "eslint ." } })
    );

    const res = await app.request("/workspaces/ws-test-uuid/manifest");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ manifest: null, tasks: [] });
    // Guard fired: the route never reached readManifestWithFallback → readManifest.
    expect(fsMocks.existsSync).not.toHaveBeenCalled();
    expect(fsMocks.readFileSync).not.toHaveBeenCalled();
  });

  it("returns null manifest for a cloud workspace with root_path null", async () => {
    mockStmt.get.mockReturnValue({
      ...MOCK_CREATED_WORKSPACE,
      kind: "cloud",
      provider_workspace_id: "agnt-workspace",
      root_path: null,
      state: "ready",
    });

    const res = await app.request("/workspaces/ws-test-uuid/manifest");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ manifest: null, tasks: [] });
    expect(fsMocks.existsSync).not.toHaveBeenCalled();
  });

  it("returns null manifest for a local workspace whose deus.json is absent", async () => {
    mockStmt.get.mockReturnValue({
      ...MOCK_CREATED_WORKSPACE,
      kind: "worktree",
      root_path: "/repos/my-project",
      slug: "europa",
      state: "ready",
    });

    const res = await app.request("/workspaces/ws-test-uuid/manifest");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ manifest: null, tasks: [] });
    // Local rows DO reach readManifestWithFallback; existsSync cancels the read.
    expect(fsMocks.existsSync).toHaveBeenCalled();
  });

  it("returns the parsed manifest + normalized tasks for a local workspace", async () => {
    mockStmt.get.mockReturnValue({
      ...MOCK_CREATED_WORKSPACE,
      kind: "worktree",
      root_path: "/repos/my-project",
      slug: "europa",
      state: "ready",
    });
    fsMocks.existsSync.mockImplementation((p: unknown) => String(p).endsWith("deus.json"));
    fsMocks.readFileSync.mockReturnValue(
      JSON.stringify({
        version: 1,
        name: "my-project",
        tasks: { lint: "eslint ." },
      })
    );

    const res = await app.request("/workspaces/ws-test-uuid/manifest");

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.manifest).toMatchObject({ version: 1, name: "my-project" });
    expect(body.tasks).toEqual([
      expect.objectContaining({
        name: "lint",
        command: "eslint .",
        persistent: false,
        mode: "concurrent",
      }),
    ]);
  });
});

// ─── POST /workspaces/:id/tasks/:name/run — cloud-kind guard ─────────

describe("POST /workspaces/:id/tasks/:name/run", () => {
  it("rejects a cloud workspace whose on-disk clone has a deus.json (the production bug)", async () => {
    mockStmt.get.mockReturnValue({
      ...MOCK_CREATED_WORKSPACE,
      kind: "cloud",
      provider_workspace_id: "agnt-workspace",
      root_path: "/repos/my-project",
      state: "ready",
    });
    fsMocks.existsSync.mockImplementation((p: unknown) => String(p).endsWith("deus.json"));
    fsMocks.readFileSync.mockReturnValue(
      JSON.stringify({ version: 1, name: "my-project", tasks: { lint: "eslint ." } })
    );

    const res = await app.request("/workspaces/ws-test-uuid/tasks/lint/run", { method: "POST" });

    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("Repository path not found");
    // Guard fired: the on-disk clone's manifest was never read.
    expect(fsMocks.existsSync).not.toHaveBeenCalled();
    expect(fsMocks.readFileSync).not.toHaveBeenCalled();
  });

  it("rejects a cloud workspace with root_path null", async () => {
    mockStmt.get.mockReturnValue({
      ...MOCK_CREATED_WORKSPACE,
      kind: "cloud",
      provider_workspace_id: "agnt-workspace",
      root_path: null,
      state: "ready",
    });

    const res = await app.request("/workspaces/ws-test-uuid/tasks/lint/run", { method: "POST" });

    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("Repository path not found");
  });

  it("returns 404 for a local workspace with no manifest", async () => {
    mockStmt.get.mockReturnValue({
      ...MOCK_CREATED_WORKSPACE,
      kind: "worktree",
      root_path: "/repos/my-project",
      slug: "europa",
      state: "ready",
    });

    const res = await app.request("/workspaces/ws-test-uuid/tasks/lint/run", { method: "POST" });

    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe("No deus.json manifest found");
  });

  it("returns 404 when the task name is not in the manifest", async () => {
    mockStmt.get.mockReturnValue({
      ...MOCK_CREATED_WORKSPACE,
      kind: "worktree",
      root_path: "/repos/my-project",
      slug: "europa",
      state: "ready",
    });
    fsMocks.existsSync.mockImplementation((p: unknown) => String(p).endsWith("deus.json"));
    fsMocks.readFileSync.mockReturnValue(
      JSON.stringify({ version: 1, name: "my-project", tasks: { lint: "eslint ." } })
    );

    const res = await app.request("/workspaces/ws-test-uuid/tasks/ghost/run", { method: "POST" });

    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe('Task "ghost" not found in manifest');
  });

  it("returns the task command, cwd, and env for a local workspace", async () => {
    mockStmt.get.mockReturnValue({
      ...MOCK_CREATED_WORKSPACE,
      id: "ws-test-uuid",
      kind: "worktree",
      root_path: "/repos/my-project",
      slug: "europa",
      state: "ready",
    });
    fsMocks.existsSync.mockImplementation((p: unknown) => String(p).endsWith("deus.json"));
    fsMocks.readFileSync.mockReturnValue(
      JSON.stringify({
        version: 1,
        name: "my-project",
        env: { NODE_ENV: "development" },
        tasks: { lint: { command: "eslint .", description: "Lint", persistent: true } },
      })
    );

    const res = await app.request("/workspaces/ws-test-uuid/tasks/lint/run", { method: "POST" });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.command).toBe("eslint .");
    expect(body.persistent).toBe(true);
    expect(body.mode).toBe("concurrent");
    expect(body.cwd).toBe("/repos/my-project/.deus/europa");
    expect(body.ptyId).toMatch(/^task-ws-test-uuid-lint-\d+$/);
    expect(body.env).toMatchObject({
      NODE_ENV: "development",
      DEUS_ROOT_PATH: "/repos/my-project",
      DEUS_WORKSPACE_PATH: "/repos/my-project/.deus/europa",
      DEUS_WORKSPACE_ID: "ws-test-uuid",
    });
  });
});

// ─── POST /workspaces/:id/retry-setup — cloud-kind defense-in-depth ──

describe("POST /workspaces/:id/retry-setup", () => {
  it("rejects a cloud workspace even when setup_status is failed (defense-in-depth)", async () => {
    mockStmt.get.mockReturnValue({
      ...MOCK_CREATED_WORKSPACE,
      kind: "cloud",
      provider_workspace_id: "agnt-workspace",
      root_path: "/repos/my-project",
      state: "ready",
      setup_status: "failed",
    });
    fsMocks.existsSync.mockImplementation((p: unknown) => String(p).endsWith("deus.json"));
    fsMocks.readFileSync.mockReturnValue(
      JSON.stringify({ version: 1, name: "my-project", lifecycle: { setup: "bun install" } })
    );

    const res = await app.request("/workspaces/ws-test-uuid/retry-setup", { method: "POST" });

    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("Repository path not found");
    // The cloud-kind guard fires before readManifestWithFallback.
    expect(fsMocks.existsSync).not.toHaveBeenCalled();
    expect(fsMocks.readFileSync).not.toHaveBeenCalled();
  });

  it("rejects when setup_status is not failed", async () => {
    mockStmt.get.mockReturnValue({
      ...MOCK_CREATED_WORKSPACE,
      kind: "worktree",
      root_path: "/repos/my-project",
      slug: "europa",
      setup_status: "completed",
    });

    const res = await app.request("/workspaces/ws-test-uuid/retry-setup", { method: "POST" });

    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("Can only retry when setup_status is failed");
  });
});
