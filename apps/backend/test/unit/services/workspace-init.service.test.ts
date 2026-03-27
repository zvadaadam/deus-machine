import { vi, describe, it, expect, beforeEach } from "vitest";

// ─── Hoisted mocks (vi.mock factories run before imports) ─────────

const { mockStmt, mockDb, mockExecFileAsync, mockFs } = vi.hoisted(() => {
  const mockStmt = {
    run: vi.fn(() => ({ changes: 1 })),
    get: vi.fn(),
    all: vi.fn(() => []),
  };
  const mockDb = {
    prepare: vi.fn(() => mockStmt),
    transaction: vi.fn((fn: Function) => fn),
  };
  const mockExecFileAsync = vi.fn(() => Promise.resolve({ stdout: "", stderr: "" }));
  const mockFs = {
    existsSync: vi.fn(() => false),
    rmSync: vi.fn(),
    copyFileSync: vi.fn(),
  };
  return { mockStmt, mockDb, mockExecFileAsync, mockFs };
});

vi.mock("../../../src/lib/database", () => ({
  getDatabase: vi.fn(() => mockDb),
}));

vi.mock("child_process", () => ({
  execFile: vi.fn(),
}));

vi.mock("util", () => ({
  promisify: () => mockExecFileAsync,
}));

vi.mock("@shared/lib/uuid", () => ({
  uuidv7: vi.fn(() => "test-session-uuid"),
}));

vi.mock("fs", () => ({
  default: mockFs,
  ...mockFs,
}));

vi.mock("../../../src/services/query-engine", () => ({
  invalidate: vi.fn(),
}));

import {
  detectPackageManager,
  initializeWorkspace,
  type InitContext,
} from "../../../src/services/workspace-init.service";

// ─── Helpers ──────────────────────────────────────────────────────

function createInitContext(overrides: Partial<InitContext> = {}): InitContext {
  return {
    workspaceId: "ws-001",
    repositoryId: "repo-001",
    repoRootPath: "/repos/my-project",
    workspacePath: "/repos/my-project/.deus/europa",
    branchName: "zvada/europa",
    worktreeBase: "origin/main",
    parentBranch: "main",
    ...overrides,
  };
}

/** Capture stdout writes for verifying DEUS_WORKSPACE_PROGRESS emissions */
function captureStdout(): string[] {
  const lines: string[] = [];
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    lines.push(String(chunk));
    return true;
  });
  return lines;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
  mockDb.prepare.mockReturnValue(mockStmt);
  mockDb.transaction.mockImplementation((fn: Function) => fn);
  mockExecFileAsync.mockResolvedValue({ stdout: "", stderr: "" });
  mockFs.existsSync.mockReturnValue(false);
});

// ─── detectPackageManager ─────────────────────────────────────────

describe("detectPackageManager", () => {
  it("returns bun for bun.lock", () => {
    mockFs.existsSync.mockImplementation((p: unknown) => String(p).endsWith("bun.lock"));
    const pm = detectPackageManager("/workspace");
    expect(pm).toEqual({ command: "bun", args: ["install", "--frozen-lockfile"] });
  });

  it("returns bun for bun.lockb (binary lockfile)", () => {
    mockFs.existsSync.mockImplementation((p: unknown) => String(p).endsWith("bun.lockb"));
    const pm = detectPackageManager("/workspace");
    expect(pm).toEqual({ command: "bun", args: ["install", "--frozen-lockfile"] });
  });

  it("returns yarn for yarn.lock", () => {
    mockFs.existsSync.mockImplementation((p: unknown) => String(p).endsWith("yarn.lock"));
    const pm = detectPackageManager("/workspace");
    expect(pm).toEqual({ command: "yarn", args: ["install", "--frozen-lockfile"] });
  });

  it("returns pnpm for pnpm-lock.yaml", () => {
    mockFs.existsSync.mockImplementation((p: unknown) => String(p).endsWith("pnpm-lock.yaml"));
    const pm = detectPackageManager("/workspace");
    expect(pm).toEqual({ command: "pnpm", args: ["install", "--frozen-lockfile"] });
  });

  it("returns npm ci for package-lock.json", () => {
    mockFs.existsSync.mockImplementation((p: unknown) => String(p).endsWith("package-lock.json"));
    const pm = detectPackageManager("/workspace");
    expect(pm).toEqual({ command: "npm", args: ["ci"] });
  });

  it("returns npm install for package.json without lockfile", () => {
    mockFs.existsSync.mockImplementation((p: unknown) => String(p).endsWith("package.json"));
    const pm = detectPackageManager("/workspace");
    expect(pm).toEqual({ command: "npm", args: ["install"] });
  });

  it("returns null when no package.json exists", () => {
    mockFs.existsSync.mockReturnValue(false);
    const pm = detectPackageManager("/workspace");
    expect(pm).toBeNull();
  });

  it("prioritizes bun over yarn when both lockfiles exist", () => {
    mockFs.existsSync.mockImplementation((p: unknown) => {
      const s = String(p);
      return s.endsWith("bun.lock") || s.endsWith("yarn.lock");
    });
    const pm = detectPackageManager("/workspace");
    expect(pm!.command).toBe("bun");
  });
});

// ─── initializeWorkspace — happy path ─────────────────────────────

describe("initializeWorkspace", () => {
  it("runs all 4 stages in order", async () => {
    mockFs.existsSync.mockReturnValue(false);

    const ctx = createInitContext();
    await initializeWorkspace(ctx);

    // Worktree stage: git worktree add
    expect(mockExecFileAsync).toHaveBeenCalledWith(
      "git",
      ["worktree", "add", "-b", "zvada/europa", ctx.workspacePath, "origin/main"],
      expect.objectContaining({ cwd: ctx.repoRootPath })
    );

    // Session stage: INSERT session + UPDATE workspace to ready
    const prepareCalls = mockDb.prepare.mock.calls.map((c: string[]) => c[0]);
    expect(prepareCalls.some((q: string) => q.includes("INSERT INTO sessions"))).toBe(true);
    expect(prepareCalls.some((q: string) => q.includes("state = 'ready'"))).toBe(true);
  });

  it("emits DEUS_WORKSPACE_PROGRESS for each stage", async () => {
    mockFs.existsSync.mockReturnValue(false);
    const lines = captureStdout();

    await initializeWorkspace(createInitContext());

    const progressLines = lines.filter((l) => l.startsWith("DEUS_WORKSPACE_PROGRESS:"));
    // worktree, session, dependencies, hooks, git-clean, done = 6 progress lines
    expect(progressLines.length).toBeGreaterThanOrEqual(6);

    const payloads = progressLines.map((l) =>
      JSON.parse(l.replace("DEUS_WORKSPACE_PROGRESS:", "").trim())
    );
    const steps = payloads.map((p: { step: string }) => p.step);
    expect(steps).toContain("worktree");
    expect(steps).toContain("dependencies");
    expect(steps).toContain("hooks");
    expect(steps).toContain("session");
    expect(steps).toContain("done");
  });

  it("updates init_stage in DB for each stage", async () => {
    mockFs.existsSync.mockReturnValue(false);

    await initializeWorkspace(createInitContext());

    const initStageUpdates = mockDb.prepare.mock.calls
      .filter((c: string[]) => c[0].includes("init_stage = ?"))
      .map((c: string[]) => c[0]);

    // Should update init_stage for worktree, session, dependencies, hooks, git-clean, done = 6
    expect(initStageUpdates.length).toBeGreaterThanOrEqual(5);
  });

  it("uses correct worktreeBase for branching", async () => {
    mockFs.existsSync.mockReturnValue(false);
    const ctx = createInitContext({ worktreeBase: "origin/develop" });

    await initializeWorkspace(ctx);

    expect(mockExecFileAsync).toHaveBeenCalledWith(
      "git",
      expect.arrayContaining(["origin/develop"]),
      expect.any(Object)
    );
  });

  // ─── Non-fatal stage failure ──────────────────────────────────

  it("workspace becomes ready even when dependencies stage fails", async () => {
    mockExecFileAsync
      .mockResolvedValueOnce({ stdout: "", stderr: "" }) // worktree succeeds
      .mockRejectedValueOnce(new Error("bun install failed")); // deps fails

    mockFs.existsSync.mockImplementation((p: unknown) => {
      const s = String(p);
      return s.endsWith("bun.lock") || s.endsWith("package.json");
    });

    await initializeWorkspace(createInitContext());

    // Should still reach session stage → workspace becomes ready
    const prepareCalls = mockDb.prepare.mock.calls.map((c: string[]) => c[0]);
    expect(prepareCalls.some((q: string) => q.includes("state = 'ready'"))).toBe(true);
  });

  it("continues when hooks stage fails (non-fatal)", async () => {
    mockFs.existsSync.mockReturnValue(true);
    mockFs.copyFileSync.mockImplementation(() => {
      throw new Error("permission denied");
    });

    await initializeWorkspace(createInitContext());

    const prepareCalls = mockDb.prepare.mock.calls.map((c: string[]) => c[0]);
    expect(prepareCalls.some((q: string) => q.includes("state = 'ready'"))).toBe(true);
  });

  // ─── Fatal stage failure ──────────────────────────────────────

  it("sets state to error when worktree stage fails", async () => {
    mockExecFileAsync.mockRejectedValueOnce(new Error("worktree already exists"));

    await initializeWorkspace(createInitContext());

    const prepareCalls = mockDb.prepare.mock.calls.map((c: string[]) => c[0]);
    expect(
      prepareCalls.some(
        (q: string) =>
          q.includes("state = 'error'") && q.includes("init_stage") && q.includes("error_message")
      )
    ).toBe(true);

    // init_stage should be the stage name, error_message should be the error text
    // The error UPDATE call has 3 args: (init_stage, error_message, workspaceId)
    const runCalls = mockStmt.run.mock.calls;
    const errorCall = runCalls.find((c: unknown[]) => c.length === 3 && c[0] === "worktree");
    expect(errorCall).toBeTruthy();
    expect(errorCall![0]).toBe("worktree");
    expect(errorCall![1]).toBe("worktree already exists");
    expect(errorCall![2]).toBe("ws-001");
  });

  it("does not reach session stage when worktree fails", async () => {
    mockExecFileAsync.mockRejectedValueOnce(new Error("worktree failed"));

    await initializeWorkspace(createInitContext());

    const prepareCalls = mockDb.prepare.mock.calls.map((c: string[]) => c[0]);
    expect(prepareCalls.some((q: string) => q.includes("INSERT INTO sessions"))).toBe(false);
    expect(prepareCalls.some((q: string) => q.includes("state = 'ready'"))).toBe(false);
  });

  it("emits error progress when fatal stage fails", async () => {
    mockExecFileAsync.mockRejectedValueOnce(new Error("git error"));
    const lines = captureStdout();

    await initializeWorkspace(createInitContext());

    const progressLines = lines.filter((l) => l.startsWith("DEUS_WORKSPACE_PROGRESS:"));
    const payloads = progressLines.map((l) =>
      JSON.parse(l.replace("DEUS_WORKSPACE_PROGRESS:", "").trim())
    );
    expect(payloads.some((p: { step: string }) => p.step === "error")).toBe(true);
  });

  // ─── Dependency installation ──────────────────────────────────

  it("installs dependencies when bun.lock exists in worktree", async () => {
    mockFs.existsSync.mockImplementation((p: unknown) => String(p).endsWith("bun.lock"));

    await initializeWorkspace(createInitContext());

    const bunCall = mockExecFileAsync.mock.calls.find(
      (c: unknown[]) => c[0] === "bun" && (c[1] as string[])?.includes("install")
    );
    expect(bunCall).toBeTruthy();
    expect(bunCall![1]).toEqual(["install", "--frozen-lockfile"]);
  });

  it("sets CI=1 during dependency installation", async () => {
    mockFs.existsSync.mockImplementation((p: unknown) => String(p).endsWith("bun.lock"));

    await initializeWorkspace(createInitContext());

    const bunCall = mockExecFileAsync.mock.calls.find(
      (c: unknown[]) => c[0] === "bun" && (c[1] as string[])?.includes("install")
    );
    expect((bunCall![2] as { env: Record<string, string> }).env.CI).toBe("1");
  });

  // ─── .env copy ────────────────────────────────────────────────

  it("copies .env from repo root to worktree when it exists", async () => {
    mockFs.existsSync.mockImplementation((p: unknown) => {
      const s = String(p);
      if (s === "/repos/my-project/.env") return true;
      if (s === "/repos/my-project/.deus/europa/.env") return false;
      return false;
    });

    await initializeWorkspace(createInitContext());

    expect(mockFs.copyFileSync).toHaveBeenCalledWith(
      "/repos/my-project/.env",
      "/repos/my-project/.deus/europa/.env"
    );
  });

  it("skips .env copy when worktree already has one", async () => {
    mockFs.existsSync.mockImplementation((p: unknown) => {
      const s = String(p);
      if (s === "/repos/my-project/.env") return true;
      if (s === "/repos/my-project/.deus/europa/.env") return true;
      return false;
    });

    await initializeWorkspace(createInitContext());

    expect(mockFs.copyFileSync).not.toHaveBeenCalled();
  });

  // ─── Session creation ─────────────────────────────────────────

  it("creates session with idle status on success", async () => {
    mockFs.existsSync.mockReturnValue(false);

    await initializeWorkspace(createInitContext());

    const prepareCalls = mockDb.prepare.mock.calls.map((c: string[]) => c[0]);
    const insertSession = prepareCalls.find((q: string) => q.includes("INSERT INTO sessions"));
    expect(insertSession).toBeTruthy();
    expect(insertSession).toContain("'idle'");
  });

  it("transitions workspace to ready with current_session_id", async () => {
    mockFs.existsSync.mockReturnValue(false);

    await initializeWorkspace(createInitContext());

    const prepareCalls = mockDb.prepare.mock.calls.map((c: string[]) => c[0]);
    const updateWorkspace = prepareCalls.find(
      (q: string) => q.includes("state = 'ready'") && q.includes("current_session_id")
    );
    expect(updateWorkspace).toBeTruthy();
  });

  // ─── Git-clean skip ──────────────────────────────────────────

  it("skips git-clean when agent already has user messages", async () => {
    // Make the session query return a last_user_message_at (agent is working)
    mockStmt.get.mockReturnValue({ last_user_message_at: "2026-01-01T00:00:00Z" });
    mockFs.existsSync.mockReturnValue(false);

    await initializeWorkspace(createInitContext());

    // git checkout -- . should NOT be called (only worktree add is called)
    const gitCheckoutCalls = mockExecFileAsync.mock.calls.filter(
      (c: unknown[]) => c[0] === "git" && (c[1] as string[])?.includes("checkout")
    );
    expect(gitCheckoutCalls).toHaveLength(0);
  });

  it("runs git-clean when no user messages exist yet", async () => {
    // Session query returns null last_user_message_at
    mockStmt.get.mockReturnValue({ last_user_message_at: null });
    mockFs.existsSync.mockReturnValue(false);

    await initializeWorkspace(createInitContext());

    // git checkout -- . should be called
    const gitCheckoutCalls = mockExecFileAsync.mock.calls.filter(
      (c: unknown[]) => c[0] === "git" && (c[1] as string[])?.includes("checkout")
    );
    expect(gitCheckoutCalls).toHaveLength(1);
  });
});
