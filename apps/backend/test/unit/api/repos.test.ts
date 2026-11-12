import { EventEmitter } from "node:events";
import path from "node:path";
import os from "os";
import { vi, describe, it, expect, beforeEach } from "vitest";
import * as api from "@shared/api/repos";
import { isOp } from "@shared/api/op";
import { operations } from "../../helpers";

const {
  mockStmt,
  mockDb,
  mockFs,
  mockExecFile,
  mockSpawn,
  mockInvalidate,
  mockBroadcast,
  mockRunGh,
  mockReadProjectFile,
  mockWriteProjectFile,
  mockListRecentProjects,
  mockResolveCloudRepoAccess,
} = vi.hoisted(() => {
  const mockStmt = {
    all: vi.fn<(...args: any[]) => any>(() => []),
    get: vi.fn<(...args: any[]) => any>(),
    run: vi.fn<(...args: any[]) => any>(),
  };
  return {
    mockStmt,
    mockDb: {
      prepare: vi.fn<(...args: any[]) => any>(() => mockStmt),
      transaction: vi.fn<(...args: any[]) => any>((fn: Function) => fn),
    },
    mockFs: {
      realpathSync: vi.fn<(...args: any[]) => any>((p: string) => p),
      accessSync: vi.fn<(...args: any[]) => any>(),
      statSync: vi.fn<(...args: any[]) => any>(() => ({ isDirectory: () => true })),
      existsSync: vi.fn<(...args: any[]) => any>(() => false),
      mkdirSync: vi.fn<(...args: any[]) => any>(),
      writeFileSync: vi.fn<(...args: any[]) => any>(),
      rmSync: vi.fn<(...args: any[]) => any>(),
      constants: { R_OK: 4, X_OK: 1 },
    },
    mockExecFile: vi.fn<(...args: any[]) => any>(),
    mockSpawn: vi.fn<(...args: any[]) => any>(),
    mockInvalidate: vi.fn<(...args: any[]) => any>(),
    mockBroadcast: vi.fn<(...args: any[]) => any>(),
    mockRunGh: vi.fn<(...args: any[]) => any>(),
    mockReadProjectFile: vi.fn<(...args: any[]) => any>(),
    mockWriteProjectFile: vi.fn<(...args: any[]) => any>(),
    mockListRecentProjects: vi.fn<(...args: any[]) => any>(),
    mockResolveCloudRepoAccess: vi.fn<(...args: any[]) => any>(),
  };
});

vi.mock("../../../src/lib/database", () => ({
  getDatabase: vi.fn<(...args: any[]) => any>(() => mockDb),
}));

vi.mock("../../../src/services/git.service", () => ({
  detectDefaultBranch: vi.fn<(...args: any[]) => any>(() => "main"),
}));

vi.mock("child_process", () => ({
  execFileSync: vi.fn<(...args: any[]) => any>(
    (cmd: string, args: string[], opts?: { cwd?: string; encoding?: string }) => {
      if (cmd === "git" && args?.includes("--show-toplevel")) {
        return Buffer.from((opts?.cwd ?? "") + "\n");
      }
      if (cmd === "git" && args?.[0] === "remote" && args?.[1] === "get-url") {
        return opts?.encoding
          ? "https://github.com/zvadaadam/deus.git"
          : Buffer.from("https://github.com/zvadaadam/deus.git\n");
      }
      return Buffer.from("");
    }
  ),
  execFile: mockExecFile,
  spawn: mockSpawn,
}));

vi.mock("fs", () => ({ default: mockFs, ...mockFs }));

vi.mock("@shared/lib/uuid", () => ({
  uuidv7: vi.fn<(...args: any[]) => any>(() => "test-uuid-1234"),
}));

vi.mock("../../../src/services/query-engine", () => ({
  invalidate: (...args: unknown[]) => mockInvalidate(...args),
}));

vi.mock("../../../src/services/ws.service", () => ({ broadcast: mockBroadcast }));

vi.mock("../../../src/services/gh.service", async () => ({
  runGh: mockRunGh,
  parseGitHubRepo: (await import("@shared/lib/github")).parseGitHubRepo,
}));

vi.mock("../../../src/services/project-environment.service", () => ({
  readProjectFile: mockReadProjectFile,
  writeProjectFile: mockWriteProjectFile,
}));

vi.mock("../../../src/services/recent-projects.service", () => ({
  listRecentProjects: mockListRecentProjects,
}));

vi.mock("../../../src/services/cloud-workspace-init.service", () => ({
  resolveCloudRepoAccess: mockResolveCloudRepoAccess,
}));

import repoHandlers from "../../../src/api/repos";

const run = operations(repoHandlers);

const REPO = {
  id: "repo-1",
  name: "deus",
  root_path: "/projects/deus",
  git_default_branch: "main",
  sort_order: 1,
  git_origin_url: "https://github.com/zvadaadam/deus.git",
  updated_at: "2024-01-01T00:00:00Z",
};
const TARGET = path.join(os.homedir(), "deus");

/** What `git <args>` printed: the answer the handler's promisified `execFile` resolves with. */
function git(answer: (args: string[]) => string | Error) {
  mockExecFile.mockImplementation(
    (_cmd: string, args: string[], _opts: unknown, done: (...result: unknown[]) => void) => {
      const result = answer(args);
      if (result instanceof Error) done(result);
      else done(null, { stdout: result, stderr: "" });
    }
  );
}

/** The process `spawn` hands back, driven by the test. */
function spawnedGit() {
  const proc = Object.assign(new EventEmitter(), { stderr: new EventEmitter() });
  mockSpawn.mockReturnValue(proc);
  return proc;
}

/** The lines pushed to clients as one kind of progress event. */
function progress(event: string): string[] {
  return mockBroadcast.mock.calls
    .map(([frame]) => JSON.parse(frame))
    .filter((frame) => frame.type === "q:event" && frame.event === event)
    .map((frame) => frame.data.line);
}

beforeEach(() => {
  vi.clearAllMocks();
  mockStmt.get.mockReset();
  mockStmt.all.mockReset().mockReturnValue([]);
  mockDb.prepare.mockReturnValue(mockStmt);
  mockDb.transaction.mockImplementation((fn: Function) => fn);
  mockFs.existsSync.mockReset().mockReturnValue(false);
  mockRunGh.mockReset();
  git(() => "");
  // A GitHub repository that could not be created is logged, by design.
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

it("answers every operation the contract declares", () => {
  const declared = Object.values(api)
    .filter(isOp)
    .map((op) => op.name);
  expect(repoHandlers.map((handler) => handler.op.name).sort()).toEqual(declared.sort());
});

describe("repos", () => {
  it("lists the repositories in the database", async () => {
    mockStmt.all.mockReturnValue([{ id: "repo-1", name: "test-repo", root_path: "/path/to/repo" }]);

    const repos = await run(api.repos);
    expect(repos).toHaveLength(1);
    expect(repos[0].name).toBe("test-repo");
  });

  it("answers with an empty list when there are none", async () => {
    expect(await run(api.repos)).toEqual([]);
  });
});

describe("addRepo", () => {
  it("refuses a request with no root_path", async () => {
    await expect(run(api.addRepo, {} as never)).rejects.toMatchObject({
      statusCode: 400,
      message: "addRepo requires root_path",
    });
  });

  it("answers with the created repository and tells subscribers", async () => {
    const createdRepo = {
      id: "test-uuid-1234",
      name: "my-project",
      root_path: "/path/to/my-project",
      git_default_branch: "main",
    };

    mockStmt.get
      .mockReturnValueOnce(undefined)
      .mockReturnValueOnce({ max: 0 })
      .mockReturnValueOnce(createdRepo);

    const repo = await run(api.addRepo, { root_path: "/path/to/my-project" });
    expect(repo.id).toBe("test-uuid-1234");
    expect(repo.name).toBe("my-project");
    expect(mockStmt.run).toHaveBeenCalledWith(
      "test-uuid-1234",
      "my-project",
      "/path/to/my-project",
      "main",
      1,
      "https://github.com/zvadaadam/deus.git"
    );
    expect(mockInvalidate).toHaveBeenCalledWith(["workspaces", "stats"]);
  });

  it("refuses a repository that was already added, naming the existing one", async () => {
    const existingRepo = {
      id: "existing-id",
      name: "existing-repo",
      root_path: "/path/to/existing",
    };

    mockStmt.get.mockReturnValueOnce(existingRepo);

    await expect(run(api.addRepo, { root_path: "/path/to/existing" })).rejects.toMatchObject({
      statusCode: 409,
      message: "Repository already exists",
      details: existingRepo,
    });
    expect(mockStmt.run).not.toHaveBeenCalled();
    expect(mockInvalidate).not.toHaveBeenCalled();
  });

  it("calls detectDefaultBranch with the given path", async () => {
    const { detectDefaultBranch } = await import("../../../src/services/git.service");

    mockStmt.get
      .mockReturnValueOnce(undefined)
      .mockReturnValueOnce({ max: 0 })
      .mockReturnValueOnce({ id: "test-uuid-1234", name: "repo" });

    await run(api.addRepo, { root_path: "/path/to/repo" });

    expect(detectDefaultBranch).toHaveBeenCalledWith("/path/to/repo");
  });

  it("refuses a folder that is not a git repository", async () => {
    const { execFileSync } = await import("child_process");
    vi.mocked(execFileSync).mockImplementationOnce(() => {
      throw new Error("fatal: not a git repository");
    });

    await expect(run(api.addRepo, { root_path: "/path/to/folder" })).rejects.toMatchObject({
      statusCode: 400,
      message: "Path is not a git repository",
    });
  });
});
