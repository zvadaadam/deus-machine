import { vi, describe, it, expect, beforeEach } from "vitest";
import { Hono } from "hono";
import os from "os";
import { errorHandler } from "../../../src/middleware/error-handler";

const mockStmt = {
  all: vi.fn(() => []),
  get: vi.fn(),
  run: vi.fn(),
};
const mockDb = {
  prepare: vi.fn(() => mockStmt),
  transaction: vi.fn((fn: Function) => fn),
};

vi.mock("../../../src/lib/database", () => ({
  getDatabase: vi.fn(() => mockDb),
}));

vi.mock("../../../src/services/git.service", () => ({
  detectDefaultBranch: vi.fn(() => "main"),
}));

vi.mock("child_process", () => ({
  execFileSync: vi.fn((cmd: string, args: string[], opts?: { cwd?: string }) => {
    // --show-toplevel returns the repo root path (echo back the cwd)
    if (cmd === "git" && args?.includes("--show-toplevel")) {
      return Buffer.from((opts?.cwd ?? "") + "\n");
    }
    return Buffer.from("");
  }),
  execFile: vi.fn(),
}));

const { mockFsExistsSync, mockFsMkdirSync } = vi.hoisted(() => ({
  mockFsExistsSync: vi.fn(() => false),
  mockFsMkdirSync: vi.fn(),
}));

vi.mock("fs", () => ({
  default: {
    realpathSync: vi.fn((p: string) => p),
    accessSync: vi.fn(),
    statSync: vi.fn(() => ({ isDirectory: () => true })),
    existsSync: mockFsExistsSync,
    mkdirSync: mockFsMkdirSync,
    constants: { R_OK: 4, X_OK: 1 },
  },
  realpathSync: vi.fn((p: string) => p),
  accessSync: vi.fn(),
  statSync: vi.fn(() => ({ isDirectory: () => true })),
  existsSync: mockFsExistsSync,
  mkdirSync: mockFsMkdirSync,
  constants: { R_OK: 4, X_OK: 1 },
}));

vi.mock("@shared/lib/uuid", () => ({
  uuidv7: vi.fn(() => "test-uuid-1234"),
}));

const mockInvalidate = vi.fn();
vi.mock("../../../src/services/query-engine", () => ({
  invalidate: (...args: unknown[]) => mockInvalidate(...args),
}));

import reposRoutes from "../../../src/routes/repos";

// Wrap the sub-app with error handler like the real app does
const app = new Hono();
app.route("/", reposRoutes);
app.onError(errorHandler);

beforeEach(() => {
  vi.clearAllMocks();
  mockDb.prepare.mockReturnValue(mockStmt);
  mockDb.transaction.mockImplementation((fn: Function) => fn);
  mockFsExistsSync.mockReturnValue(false);
});

describe("GET /repos", () => {
  it("returns 200 with array from database", async () => {
    mockStmt.all.mockReturnValue([{ id: "repo-1", name: "test-repo", root_path: "/path/to/repo" }]);

    const res = await app.request("/repos");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
    expect(body).toHaveLength(1);
    expect(body[0].name).toBe("test-repo");
  });

  it("returns empty array when no repos exist", async () => {
    mockStmt.all.mockReturnValue([]);
    const res = await app.request("/repos");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual([]);
  });
});

describe("POST /repos", () => {
  it("returns 400 when root_path is missing", async () => {
    const res = await app.request("/repos", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it("returns 201 with created repo on success", async () => {
    const createdRepo = {
      id: "test-uuid-1234",
      name: "my-project",
      root_path: "/path/to/my-project",
      git_default_branch: "main",
    };

    // First call: check existing (none found)
    // Second call: get max sort_order
    // Third call: get created repo
    mockStmt.get
      .mockReturnValueOnce(undefined) // no existing repo
      .mockReturnValueOnce({ max: 0 }) // max sort_order
      .mockReturnValueOnce(createdRepo); // newly created

    const res = await app.request("/repos", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ root_path: "/path/to/my-project" }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.id).toBe("test-uuid-1234");
    expect(body.name).toBe("my-project");
    expect(mockInvalidate).toHaveBeenCalledWith(["stats"]);
  });

  it("returns 409 when repo already exists", async () => {
    const existingRepo = {
      id: "existing-id",
      name: "existing-repo",
      root_path: "/path/to/existing",
    };

    // The transaction function throws ConflictError when existing repo is found
    mockStmt.get.mockReturnValueOnce(existingRepo);

    const res = await app.request("/repos", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ root_path: "/path/to/existing" }),
    });
    expect(res.status).toBe(409);
  });

  it("calls detectDefaultBranch with the given path", async () => {
    const { detectDefaultBranch } = await import("../../../src/services/git.service");

    mockStmt.get
      .mockReturnValueOnce(undefined)
      .mockReturnValueOnce({ max: 0 })
      .mockReturnValueOnce({ id: "test-uuid-1234", name: "repo" });

    await app.request("/repos", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ root_path: "/path/to/repo" }),
    });

    expect(detectDefaultBranch).toHaveBeenCalledWith("/path/to/repo");
  });
});

describe("POST /repos/clone", () => {
  it("returns a specific error when the target exists but is not a git repo", async () => {
    const targetPath = `${os.homedir()}/deus`;
    mockFsExistsSync.mockImplementation((target: string) => target === targetPath);

    const res = await app.request("/repos/clone", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: "https://github.com/example/deus", targetPath }),
    });

    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toMatchObject({
      error: "Target directory already exists and is not a git repository",
    });
  });

  it("returns an already-cloned error when the target already has .git", async () => {
    const targetPath = `${os.homedir()}/deus`;
    mockFsExistsSync.mockImplementation(
      (target: string) => target === targetPath || target === `${targetPath}/.git`
    );

    const res = await app.request("/repos/clone", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: "https://github.com/example/deus", targetPath }),
    });

    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toMatchObject({
      error: "Target already contains a git repository",
    });
  });
});
