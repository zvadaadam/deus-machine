import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { pathToFileURL } from "node:url";
import path from "node:path";
import os from "os";
import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import * as api from "@shared/api/repos";
import { isOp } from "@shared/api/op";
import { GitError, runGit } from "@shared/lib/git-process";
import { operations, published } from "../../helpers";

const {
  mockStmt,
  mockDb,
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
  detectDefaultBranch: vi.fn<(...args: any[]) => any>(async () => "main"),
}));

vi.mock("@shared/lib/git-process", async (read) => {
  const actual = await read<typeof import("@shared/lib/git-process")>();
  return { ...actual, runGit: vi.fn(actual.runGit) };
});

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
const mockRunGit = vi.mocked(runGit);
let home: string;
let target: string;
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: "pipe" }).trim();

function repository(name: string) {
  const folder = path.join(home, name);
  git(home, "init", "-q", "-b", "main", folder);
  git(folder, "remote", "add", "origin", REPO.git_origin_url);
  return folder;
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
  mockRunGh.mockReset();
  mockRunGit.mockReset();
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "deus-repos-")));
  target = path.join(home, "deus");
  vi.stubEnv("HOME", home);
  vi.stubEnv("GIT_ALLOW_PROTOCOL", "file");
  vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");
  vi.stubEnv("GIT_CONFIG_GLOBAL", path.join(home, ".gitconfig"));
  fs.writeFileSync(
    path.join(home, ".gitconfig"),
    "[user]\n\tname = Repos Test\n\temail = test@example.test\n[init]\n\tdefaultBranch = main\n"
  );
  // A GitHub repository that could not be created is logged, by design.
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(home, { recursive: true, force: true });
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
    const folder = repository("my-project");
    const createdRepo = {
      id: "test-uuid-1234",
      name: "my-project",
      root_path: folder,
      git_default_branch: "main",
    };

    mockStmt.get
      .mockReturnValueOnce(undefined)
      .mockReturnValueOnce({ max: 0 })
      .mockReturnValueOnce(createdRepo);

    const repo = await run(api.addRepo, { root_path: folder });
    expect(repo.id).toBe("test-uuid-1234");
    expect(repo.name).toBe("my-project");
    expect(mockStmt.run).toHaveBeenCalledWith(
      "test-uuid-1234",
      "my-project",
      folder,
      "main",
      1,
      "https://github.com/zvadaadam/deus.git"
    );
    expect(mockInvalidate).toHaveBeenCalledWith(["workspaces", "repos"]);
  });

  it("refuses a repository that was already added, naming the existing one", async () => {
    const folder = repository("existing");
    const existingRepo = {
      id: "existing-id",
      name: "existing-repo",
      root_path: folder,
    };

    mockStmt.get.mockReturnValueOnce(existingRepo);

    await expect(run(api.addRepo, { root_path: folder })).rejects.toMatchObject({
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

    const folder = repository("repo");
    await run(api.addRepo, { root_path: folder });

    expect(detectDefaultBranch).toHaveBeenCalledWith(folder);
  });

  it("inspects a checkout and refuses a non-repository under a German locale", async () => {
    vi.stubEnv("LANG", "de_DE.UTF-8");
    vi.stubEnv("LC_ALL", "de_DE.UTF-8");
    const folder = repository("deus");
    const subfolder = path.join(folder, "src");
    fs.mkdirSync(subfolder);
    await expect(run(api.inspectRepo, { root_path: subfolder })).resolves.toEqual({
      root_path: folder,
      name: "deus",
      git_default_branch: "main",
      git_origin_url: REPO.git_origin_url,
    });
    await expect(run(api.addRepo, { root_path: home })).rejects.toMatchObject({
      statusCode: 400,
      message: "Path is not a git repository",
    });
    expect(mockStmt.run).not.toHaveBeenCalled();
  });
});

describe("inspectRepo", () => {
  it.each(["", "relative", "vanished"])(
    "refuses an invalid toplevel %j before writing",
    async (root) => {
      mockRunGit.mockResolvedValueOnce(root === "vanished" ? path.join(home, root) : root);
      await expect(run(api.addRepo, { root_path: home })).rejects.toThrow(
        /git.*(folder|toplevel)/i
      );
      expect(mockStmt.run).not.toHaveBeenCalled();
    }
  );

  it("inspects a repository without an origin", async () => {
    git(home, "init", "-q", target);
    await expect(run(api.inspectRepo, { root_path: target })).resolves.toEqual({
      root_path: target,
      name: "deus",
      git_default_branch: "main",
      git_origin_url: null,
    });
    expect(mockStmt.run).not.toHaveBeenCalled();
  });
});

describe("gitClone", () => {
  const url = "https://github.com/example/deus";

  it("returns a specific error when the target exists but is not a git repo", async () => {
    fs.mkdirSync(target);

    await expect(run(api.gitClone, { url, targetPath: target })).rejects.toMatchObject({
      statusCode: 409,
      message: "Target directory already exists and is not a git repository",
    });
  });

  it("returns an already-cloned error when the target already has .git", async () => {
    repository("deus");

    await expect(run(api.gitClone, { url, targetPath: target })).rejects.toMatchObject({
      statusCode: 409,
      message: "Target already contains a git repository",
    });
  });

  it("refuses an address git could read as anything but an https or ssh repository", async () => {
    for (const unsafe of [
      "https://github.com/a/b; rm -rf ~",
      "http://github.com/a/b",
      "file:///etc",
      "ext::sh -c touch% /tmp/pwned",
      "/Users/someone/repo",
      "--upload-pack=touch /tmp/pwned",
    ]) {
      await expect(run(api.gitClone, { url: unsafe, targetPath: target })).rejects.toMatchObject({
        statusCode: 400,
      });
    }
    expect(mockRunGit).not.toHaveBeenCalled();
  });

  it("refuses an address with a credential in it, without repeating it", async () => {
    const refused = run(api.gitClone, {
      url: "https://someone:ghp_secret@github.com/a/b",
      targetPath: target,
    });
    await expect(refused).rejects.toMatchObject({ statusCode: 400 });
    await expect(refused).rejects.not.toThrow(/ghp_secret/);
    expect(mockRunGit).not.toHaveBeenCalled();
  });

  it("refuses a target outside the home directory", async () => {
    await expect(
      run(api.gitClone, { url, targetPath: path.join(path.dirname(home), "outside") })
    ).rejects.toMatchObject({
      statusCode: 400,
      message: "Target path must be within the home directory",
    });
    expect(mockRunGit).not.toHaveBeenCalled();
  });

  it("publishes git's progress to the clients following a clone and answers with where the clone is", async () => {
    mockRunGit.mockImplementationOnce(async (_args, { onStderr }) => {
      onStderr?.("Cloning into 'deus'...\nReceiving objects:  50%\r");
      onStderr?.("Receiving objects: 100%");
      return "";
    });
    await expect(run(api.gitClone, { url, targetPath: "~/deus" })).resolves.toEqual({
      path: target,
    });
    // https and ssh only, the address after `--`, in the runner (no prompts, its own group, a timeout).
    expect(mockRunGit).toHaveBeenCalledWith(
      [
        ...["-c", "protocol.allow=never"],
        ...["-c", "protocol.https.allow=always", "-c", "protocol.ssh.allow=always"],
        ...["clone", "--progress", "--", url, target],
      ],
      expect.objectContaining({ cwd: path.dirname(target), timeoutMs: 300_000 })
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

  it("clones an ssh address and GitHub's owner/name", async () => {
    for (const [given, cloned] of [
      ["git@github.com:example/deus.git", "git@github.com:example/deus.git"],
      ["example/deus", "https://github.com/example/deus"],
    ]) {
      mockRunGit.mockReset().mockResolvedValue("");
      await run(api.gitClone, { url: given!, targetPath: target });
      expect(mockRunGit.mock.calls[0]![0].slice(-3)).toEqual(["--", cloned, target]);
    }
  });

  it("fails with git's words, without its progress, when the clone fails", async () => {
    const said =
      "Cloning into 'deus'...\nremote: Repository not found.\nfatal: repository not found\n";
    mockRunGit.mockImplementationOnce(async (args, { onStderr }) => {
      onStderr?.(said);
      throw new GitError(args, { stderr: said.trim(), code: 128 });
    });
    await expect(run(api.gitClone, { url, targetPath: target })).rejects.toMatchObject({
      statusCode: 500,
      message: "remote: Repository not found.\nfatal: repository not found",
    });
    expect(progress("clone")).toEqual([
      "Cloning into 'deus'...",
      "remote: Repository not found.",
      "fatal: repository not found",
    ]);
  });

  it("says a clone was stopped at its timeout", async () => {
    mockRunGit.mockRejectedValueOnce(new GitError(["clone"], { timedOut: true }));
    await expect(run(api.gitClone, { url, targetPath: target })).rejects.toMatchObject({
      statusCode: 500,
      message: "git clone did not finish within 5 minutes and was stopped.",
    });
  });

  it("fails when git cannot be started", async () => {
    mockRunGit.mockRejectedValueOnce(
      new GitError(["clone"], { cause: new Error("spawn git ENOENT") })
    );
    await expect(run(api.gitClone, { url, targetPath: target })).rejects.toMatchObject({
      statusCode: 500,
      message: "Failed to start git: spawn git ENOENT",
    });
  });
});

describe("gitInit", () => {
  const input = { projectName: "demo", targetPath: "~/deus" };

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
    expect(mockRunGit).not.toHaveBeenCalled();
    expect(fs.existsSync(target)).toBe(false);
  });

  it("refuses a target that already exists", async () => {
    fs.mkdirSync(target);

    await expect(run(api.gitInit, input)).rejects.toMatchObject({
      statusCode: 409,
      message: "Target directory already exists",
    });
  });

  it("creates an empty project with a first commit and its GitHub repository", async () => {
    const bare = path.join(home, "origin.git");
    git(home, "init", "--bare", "-q", bare);
    mockRunGh.mockImplementation(async () => {
      git(target, "remote", "add", "origin", bare);
      return { success: true, stdout: "https://github.com/me/demo\n" };
    });

    await expect(run(api.gitInit, { ...input, templateType: "empty" })).resolves.toEqual({
      path: target,
      githubUrl: "https://github.com/me/demo",
    });

    expect(git(bare, "show", "main:README.md")).toBe("# demo");
    expect(git(bare, "rev-parse", "main")).toBe(git(target, "rev-parse", "HEAD"));
    expect(mockRunGh).toHaveBeenCalledWith(
      ["repo", "create", "demo", "--private", "--source", target, "--remote", "origin"],
      expect.objectContaining({ cwd: target })
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

    await expect(run(api.gitInit, input)).resolves.toEqual({ path: target, githubUrl: null });
    expect(progress("init")).toContain("GitHub: Not signed in to GitHub");
    expect(mockRunGit.mock.calls.map(([args]) => args[0])).not.toContain("push");
  });

  it("starts from a copy of a GitHub template, without its history", async () => {
    mockRunGh.mockResolvedValue({ success: false, error: "gh_not_installed", message: "" });
    const template = repository("template");
    fs.writeFileSync(path.join(template, "example.txt"), "template contents");
    git(template, "add", ".");
    git(template, "commit", "-qm", "Template history");
    const bare = path.join(home, "template.git");
    git(home, "clone", "--bare", "-q", template, bare);
    const templateUrl = "https://github.com/acme/template";
    git(home, "config", "--global", `url.${pathToFileURL(bare).href}.insteadOf`, templateUrl);

    await expect(
      run(api.gitInit, { ...input, templateType: "github", templateUrl })
    ).resolves.toEqual({
      path: target,
      githubUrl: null,
    });
    expect(git(target, "log", "--format=%s")).toBe("Initial commit");
    expect(git(target, "show", "HEAD:example.txt")).toBe("template contents");
    expect(git(target, "remote")).toBe("");
    expect(progress("init")).toContain(`Cloning into '${target}'...`);
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
    mockRunGit.mockResolvedValueOnce("feature/login\n");

    await expect(run(api.repoEnvironmentFile, { repoId: REPO.id })).resolves.toEqual({
      project: { version: 1, setup: "bun install" },
      branch: "feature/login",
    });
    expect(mockReadProjectFile).toHaveBeenCalledWith(REPO.root_path);
    expect(mockRunGit).toHaveBeenCalledWith(["branch", "--show-current"], { cwd: REPO.root_path });
  });

  it("says so when no branch is checked out", async () => {
    mockStmt.get.mockReturnValueOnce(REPO);
    mockReadProjectFile.mockReturnValue(null);
    mockRunGit.mockResolvedValueOnce("");

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
  it("lists origin's branches by name, marked as the clone's remote-tracking refs", async () => {
    mockStmt.get.mockReturnValueOnce(REPO);
    mockRunGit.mockResolvedValueOnce("main\nHEAD\nfeature/login\n\n");

    await expect(run(api.repoBranches, { repoId: REPO.id })).resolves.toEqual({
      branches: [
        { name: "main", is_remote: true },
        { name: "feature/login", is_remote: true },
      ],
    });
    expect(mockRunGit).toHaveBeenCalledWith(
      expect.arrayContaining(["for-each-ref", "--sort=-committerdate", "refs/remotes/origin/"]),
      expect.objectContaining({ cwd: REPO.root_path })
    );
  });

  it("lists the project's own branches when it has no origin", async () => {
    mockStmt.get.mockReturnValueOnce(REPO);
    mockRunGit.mockResolvedValueOnce("").mockResolvedValueOnce("main\nwip\n");

    await expect(run(api.repoBranches, { repoId: REPO.id })).resolves.toEqual({
      branches: [
        { name: "main", is_local: true },
        { name: "wip", is_local: true },
      ],
    });
  });

  it("answers with no branches when git fails", async () => {
    mockStmt.get.mockReturnValueOnce(REPO);
    mockRunGit.mockRejectedValueOnce(new GitError([], { code: 128 }));

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
    expect(mockResolveCloudRepoAccess).toHaveBeenCalledWith(REPO.id, undefined, {
      fresh: undefined,
    });
  });

  it("asks afresh when the gate is waiting for a grant", async () => {
    mockResolveCloudRepoAccess.mockResolvedValue({ status: "ok", slug: "acme/app" });

    await run(api.cloudRepoAccess, { repoId: REPO.id, organizationId: "org-2", fresh: true });
    expect(mockResolveCloudRepoAccess).toHaveBeenCalledWith(REPO.id, "org-2", { fresh: true });
  });
});

describe("recentProjects", () => {
  it("answers with the projects found on this computer", async () => {
    const projects = [{ name: "app", path: "/projects/app", source: "cursor" }];
    mockListRecentProjects.mockResolvedValue(projects);

    await expect(run(api.recentProjects)).resolves.toEqual({ projects });
  });
});
