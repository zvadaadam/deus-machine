import { EventEmitter } from "node:events";
import path from "node:path";
import os from "os";
import { vi, describe, it, expect, beforeEach } from "vitest";
import * as api from "@shared/api/repos";
import { isOp } from "@shared/api/op";
import { operations, published } from "../../helpers";

const {
  mockStmt,
  mockDb,
  mockFs,
  mockExecFile,
  mockSpawn,
  mockInvalidate,
  mockPublish,
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
    mockPublish: vi.fn<(...args: any[]) => any>(),
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

vi.mock("../../../src/services/streams", () => ({ publish: mockPublish }));

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

/**
 * The lines git printed, as the clients following one kind of operation
 * received them. Everything a handler publishes is git's progress, and a line
 * goes to the followers of its own operation only: a clone's never reaches a
 * window that is creating a project.
 */
function progress(operation: "clone" | "init"): string[] {
  const sent = published(mockPublish, api.gitProgress);
  expect(sent).toHaveLength(mockPublish.mock.calls.length);
  return sent.filter(({ scope }) => scope.operation === operation).map(({ event }) => event.line);
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

describe("inspectRepo", () => {
  it("returns normalized repo metadata without registering it", async () => {
    await expect(run(api.inspectRepo, { root_path: "/path/to/deus" })).resolves.toEqual({
      root_path: "/path/to/deus",
      name: "deus",
      git_default_branch: "main",
      git_origin_url: "https://github.com/zvadaadam/deus.git",
    });
    expect(mockStmt.run).not.toHaveBeenCalled();
  });
});

describe("gitClone", () => {
  const url = "https://github.com/example/deus";

  it("returns a specific error when the target exists but is not a git repo", async () => {
    mockFs.existsSync.mockImplementation((target: string) => target === TARGET);

    await expect(run(api.gitClone, { url, targetPath: TARGET })).rejects.toMatchObject({
      statusCode: 409,
      message: "Target directory already exists and is not a git repository",
    });
  });

  it("returns an already-cloned error when the target already has .git", async () => {
    const gitPath = path.join(TARGET, ".git");
    mockFs.existsSync.mockImplementation(
      (target: string) => target === TARGET || target === gitPath
    );

    await expect(run(api.gitClone, { url, targetPath: TARGET })).rejects.toMatchObject({
      statusCode: 409,
      message: "Target already contains a git repository",
    });
  });

  it("refuses a URL git could read as anything but an http(s) address", async () => {
    for (const unsafe of ["git@github.com:example/deus.git", "https://github.com/a/b; rm -rf ~"]) {
      await expect(run(api.gitClone, { url: unsafe, targetPath: TARGET })).rejects.toMatchObject({
        statusCode: 400,
        message: "Invalid repository URL format",
      });
    }
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it("refuses a target outside the home directory", async () => {
    await expect(run(api.gitClone, { url, targetPath: "/etc/deus" })).rejects.toMatchObject({
      statusCode: 400,
      message: "Target path must be within the home directory",
    });
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it("publishes git's progress to the clients following a clone and answers with where the clone is", async () => {
    const proc = spawnedGit();
    const cloning = run(api.gitClone, { url, targetPath: "~/deus" });

    proc.stderr.emit("data", Buffer.from("Cloning into 'deus'...\nReceiving objects:  50%\r"));
    proc.stderr.emit("data", Buffer.from("Receiving objects: 100%"));
    proc.emit("close", 0);

    await expect(cloning).resolves.toEqual({ path: TARGET });
    expect(mockSpawn).toHaveBeenCalledWith(
      "git",
      ["clone", "--progress", url, TARGET],
      expect.objectContaining({ timeout: 300_000 })
    );
    expect(progress("clone")).toEqual([
      "Cloning into 'deus'...",
      "Receiving objects:  50%",
      "Receiving objects: 100%",
      "Clone complete.",
    ]);
    expect(published(mockPublish, api.gitProgress)[0]).toEqual({
      scope: { operation: "clone" },
      event: { line: "Cloning into 'deus'..." },
    });
    // Nothing of a clone reaches a window that is creating a project.
    expect(progress("init")).toEqual([]);
  });

  it("fails with git's last words when the clone fails", async () => {
    const proc = spawnedGit();
    const cloning = run(api.gitClone, { url, targetPath: TARGET });

    proc.stderr.emit("data", Buffer.from("fatal: repository not found"));
    proc.emit("close", 128);

    await expect(cloning).rejects.toMatchObject({
      statusCode: 500,
      message: "fatal: repository not found",
    });
    expect(progress("clone")).toEqual(["fatal: repository not found"]);
  });

  it("fails when git cannot be started", async () => {
    const proc = spawnedGit();
    const cloning = run(api.gitClone, { url, targetPath: TARGET });

    proc.emit("error", new Error("spawn git ENOENT"));

    await expect(cloning).rejects.toMatchObject({
      statusCode: 500,
      message: "Failed to start git: spawn git ENOENT",
    });
  });
});

describe("gitInit", () => {
  const input = { projectName: "demo", targetPath: TARGET };

  it("refuses a name that is not a plain folder name", async () => {
    await expect(run(api.gitInit, { ...input, projectName: "../demo" })).rejects.toMatchObject({
      statusCode: 400,
      message: "gitInit: projectName: Invalid project name",
    });
  });

  it("refuses a GitHub template without an HTTPS address", async () => {
    for (const templateUrl of [undefined, "git@github.com:acme/template.git"]) {
      await expect(
        run(api.gitInit, { ...input, templateType: "github", templateUrl })
      ).rejects.toMatchObject({
        statusCode: 400,
        message: "gitInit: templateUrl: Only HTTPS URLs are allowed",
      });
    }
    expect(mockSpawn).not.toHaveBeenCalled();
    expect(mockFs.mkdirSync).not.toHaveBeenCalled();
  });

  it("refuses a target that already exists", async () => {
    mockFs.existsSync.mockImplementation((target: string) => target === TARGET);

    await expect(run(api.gitInit, input)).rejects.toMatchObject({
      statusCode: 409,
      message: "Target directory already exists",
    });
  });

  it("creates an empty project with a first commit and its GitHub repository", async () => {
    mockRunGh.mockResolvedValue({ success: true, stdout: "https://github.com/me/demo\n" });

    await expect(run(api.gitInit, { ...input, templateType: "empty" })).resolves.toEqual({
      path: TARGET,
      githubUrl: "https://github.com/me/demo",
    });

    expect(mockFs.writeFileSync).toHaveBeenCalledWith(path.join(TARGET, "README.md"), "# demo\n");
    expect(mockExecFile.mock.calls.map(([, args]) => args[0])).toEqual([
      "init",
      "add",
      "commit",
      "push",
    ]);
    expect(mockRunGh).toHaveBeenCalledWith(
      ["repo", "create", "demo", "--private", "--source", TARGET, "--remote", "origin"],
      expect.objectContaining({ cwd: TARGET })
    );
    expect(progress("init")).toEqual([
      "Creating project directory...",
      "Initializing git repository...",
      "Creating initial commit...",
      "Creating GitHub repository...",
      "GitHub repository created: https://github.com/me/demo",
      "Pushing initial commit...",
      "Project created successfully.",
    ]);
    expect(published(mockPublish, api.gitProgress)[0]).toEqual({
      scope: { operation: "init" },
      event: { line: "Creating project directory..." },
    });
    // Nothing of a new project reaches a window that is cloning.
    expect(progress("clone")).toEqual([]);
  });

  it("still creates the project when GitHub is unavailable", async () => {
    mockRunGh.mockResolvedValue({
      success: false,
      error: "gh_not_authenticated",
      message: "Not signed in to GitHub",
    });

    await expect(run(api.gitInit, input)).resolves.toEqual({ path: TARGET, githubUrl: null });
    expect(progress("init")).toContain("GitHub: Not signed in to GitHub");
    expect(mockExecFile.mock.calls.map(([, args]) => args[0])).not.toContain("push");
  });

  it("starts from a copy of a GitHub template, without its history", async () => {
    mockRunGh.mockResolvedValue({ success: false, error: "gh_not_installed", message: "" });
    const proc = spawnedGit();
    const templateUrl = "https://github.com/acme/template";
    const creating = run(api.gitInit, { ...input, templateType: "github", templateUrl });

    proc.emit("close", 0);

    await expect(creating).resolves.toEqual({ path: TARGET, githubUrl: null });
    expect(mockSpawn).toHaveBeenCalledWith(
      "git",
      ["clone", "--depth", "1", templateUrl, TARGET],
      expect.objectContaining({ timeout: 120_000 })
    );
    expect(mockFs.rmSync).toHaveBeenCalledWith(path.join(TARGET, ".git"), {
      recursive: true,
      force: true,
    });
    expect(mockFs.writeFileSync).not.toHaveBeenCalled();
  });
});

describe("repoEnvironmentFile", () => {
  it("refuses a repository that does not exist", async () => {
    await expect(run(api.repoEnvironmentFile, { repoId: "missing" })).rejects.toMatchObject({
      statusCode: 404,
      message: "Repository not found",
    });
  });

  it("answers with the checkout's file and its branch", async () => {
    mockStmt.get.mockReturnValueOnce(REPO);
    mockReadProjectFile.mockReturnValue({ version: 1, setup: "bun install" });
    git(() => "feature/login\n");

    await expect(run(api.repoEnvironmentFile, { repoId: REPO.id })).resolves.toEqual({
      project: { version: 1, setup: "bun install" },
      branch: "feature/login",
    });
    expect(mockReadProjectFile).toHaveBeenCalledWith(REPO.root_path);
    expect(mockExecFile).toHaveBeenCalledWith(
      "git",
      ["branch", "--show-current"],
      { cwd: REPO.root_path },
      expect.any(Function)
    );
  });

  it("says so when no branch is checked out", async () => {
    mockStmt.get.mockReturnValueOnce(REPO);
    mockReadProjectFile.mockReturnValue(null);

    await expect(run(api.repoEnvironmentFile, { repoId: REPO.id })).resolves.toEqual({
      project: null,
      branch: "detached HEAD",
    });
  });
});

describe("saveRepoEnvironmentFile", () => {
  it("writes the project to the repository's checkout", async () => {
    mockStmt.get.mockReturnValueOnce(REPO);
    const project = { version: 1 as const, setup: "bun install", requiredEnv: ["API_KEY"] };

    await expect(
      run(api.saveRepoEnvironmentFile, { repoId: REPO.id, project })
    ).resolves.toBeUndefined();
    expect(mockWriteProjectFile).toHaveBeenCalledWith(REPO.root_path, project);
  });

  it("refuses a project the environment file cannot hold", async () => {
    await expect(
      run(api.saveRepoEnvironmentFile, { repoId: REPO.id, project: { version: 2 } as never })
    ).rejects.toMatchObject({ statusCode: 400 });
    await expect(
      run(api.saveRepoEnvironmentFile, { repoId: REPO.id } as never)
    ).rejects.toMatchObject({
      statusCode: 400,
      message: "saveRepoEnvironmentFile requires project",
    });
    expect(mockWriteProjectFile).not.toHaveBeenCalled();
  });

  it("refuses a repository that does not exist", async () => {
    await expect(
      run(api.saveRepoEnvironmentFile, { repoId: "missing", project: { version: 1 } })
    ).rejects.toMatchObject({ statusCode: 404 });
    expect(mockWriteProjectFile).not.toHaveBeenCalled();
  });
});

describe("repoPrs", () => {
  it("lists the open pull requests GitHub reports", async () => {
    mockStmt.get.mockReturnValueOnce(REPO);
    mockRunGh.mockResolvedValue({
      success: true,
      stdout: JSON.stringify([
        {
          number: 7,
          title: "Add login",
          headRefName: "feature/login",
          baseRefName: "main",
          url: "https://github.com/zvadaadam/deus/pull/7",
          isDraft: true,
        },
        {
          number: 8,
          title: "Fix logout",
          headRefName: "fix/logout",
          baseRefName: "develop",
          url: "https://github.com/zvadaadam/deus/pull/8",
        },
      ]),
    });

    await expect(run(api.repoPrs, { repoId: REPO.id })).resolves.toEqual([
      {
        number: 7,
        title: "Add login",
        branch: "feature/login",
        baseBranch: "main",
        url: "https://github.com/zvadaadam/deus/pull/7",
        isDraft: true,
      },
      {
        number: 8,
        title: "Fix logout",
        branch: "fix/logout",
        baseBranch: "develop",
        url: "https://github.com/zvadaadam/deus/pull/8",
        isDraft: false,
      },
    ]);
    expect(mockRunGh).toHaveBeenCalledWith(
      expect.arrayContaining(["pr", "list", "--repo", "zvadaadam/deus", "--state", "open"]),
      { cwd: REPO.root_path, timeoutMs: 10000 }
    );
  });

  it("answers with nothing when GitHub cannot be asked", async () => {
    mockStmt.get.mockReturnValueOnce(REPO);
    mockRunGh.mockResolvedValue({ success: false, error: "gh_not_installed", message: "" });
    await expect(run(api.repoPrs, { repoId: REPO.id })).resolves.toEqual([]);

    mockStmt.get.mockReturnValueOnce(REPO);
    mockRunGh.mockResolvedValue({ success: true, stdout: "not json" });
    await expect(run(api.repoPrs, { repoId: REPO.id })).resolves.toEqual([]);
  });

  it("does not ask GitHub about a repository hosted elsewhere", async () => {
    mockStmt.get.mockReturnValueOnce({ ...REPO, git_origin_url: "https://gitlab.com/acme/app" });

    await expect(run(api.repoPrs, { repoId: REPO.id })).resolves.toEqual([]);
    expect(mockRunGh).not.toHaveBeenCalled();
  });

  it("refuses a repository that does not exist", async () => {
    await expect(run(api.repoPrs, { repoId: "missing" })).rejects.toMatchObject({
      statusCode: 404,
    });
  });
});

describe("repoBranches", () => {
  it("lists origin's branches by name", async () => {
    mockStmt.get.mockReturnValueOnce(REPO);
    git(() => "origin/main\norigin/HEAD\norigin/feature/login\n\n");

    await expect(run(api.repoBranches, { repoId: REPO.id })).resolves.toEqual({
      branches: [{ name: "main" }, { name: "feature/login" }],
    });
    expect(mockExecFile).toHaveBeenCalledWith(
      "git",
      expect.arrayContaining(["for-each-ref", "--sort=-committerdate", "refs/remotes/origin/"]),
      expect.objectContaining({ cwd: REPO.root_path }),
      expect.any(Function)
    );
  });

  it("answers with no branches when git fails", async () => {
    mockStmt.get.mockReturnValueOnce(REPO);
    git(() => new Error("fatal: not a git repository"));

    await expect(run(api.repoBranches, { repoId: REPO.id })).resolves.toEqual({ branches: [] });
  });

  it("refuses a request with no repoId", async () => {
    await expect(run(api.repoBranches, {} as never)).rejects.toMatchObject({
      statusCode: 400,
      message: "repoBranches requires repoId",
    });
  });
});

describe("cloudRepoAccess", () => {
  it("answers with the verdict provisioning uses", async () => {
    mockResolveCloudRepoAccess.mockResolvedValue({ status: "needs_grant", slug: "acme/app" });

    await expect(run(api.cloudRepoAccess, { repoId: REPO.id })).resolves.toEqual({
      status: "needs_grant",
      slug: "acme/app",
    });
    expect(mockResolveCloudRepoAccess).toHaveBeenCalledWith(REPO.id);
  });
});

describe("recentProjects", () => {
  it("answers with the projects found on this computer", async () => {
    const projects = [{ name: "app", path: "/projects/app", source: "cursor" }];
    mockListRecentProjects.mockReturnValue(projects);

    await expect(run(api.recentProjects)).resolves.toEqual({ projects });
  });
});
