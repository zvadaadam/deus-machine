/**
 * Projects with no folder on this computer: adding one from GitHub, one
 * project per repository, GitHub's branches, and the guards that keep such a
 * row away from git and the filesystem. Runs against a real SQLite database
 * built from the fresh schema.
 */
import Database from "better-sqlite3";
import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import { SCHEMA_SQL } from "@shared/schema";
import * as api from "@shared/api/repos";
import { operations } from "../../helpers";

const m = vi.hoisted(() => ({
  db: null as unknown as Database.Database,
  execFile: vi.fn(),
  execFileSync: vi.fn(),
  spawn: vi.fn(),
  fs: {
    realpathSync: vi.fn((p: string) => p),
    accessSync: vi.fn(),
    statSync: vi.fn(() => ({ isDirectory: () => true })),
    existsSync: vi.fn(() => false),
    mkdirSync: vi.fn(),
    writeFileSync: vi.fn(),
    rmSync: vi.fn(),
    constants: { R_OK: 4, X_OK: 1 },
  },
  remoteUrl: vi.fn((): string | null => null),
  defaultBranch: vi.fn(),
  branches: vi.fn(),
  accessibleRepos: vi.fn(),
  defaultOrg: vi.fn((): string | null => "org-default"),
  invalidate: vi.fn(),
  runGh: vi.fn(),
  readProjectFile: vi.fn(),
  writeProjectFile: vi.fn(),
  detectDefaultBranch: vi.fn(async () => "develop"),
  uuid: 0,
}));

vi.mock("../../../src/lib/database", () => ({ getDatabase: () => m.db }));
vi.mock("child_process", () => ({
  execFile: m.execFile,
  execFileSync: (cmd: string, args: string[], opts?: { cwd?: string }) => {
    m.execFileSync(cmd, args, opts);
    if (cmd === "git" && args.includes("--show-toplevel")) return Buffer.from(`${opts?.cwd}\n`);
    return Buffer.from("");
  },
  spawn: m.spawn,
}));
vi.mock("fs", () => ({ default: m.fs, ...m.fs }));
vi.mock("../../../src/lib/git-remotes", () => ({ getGitRemoteUrlSync: m.remoteUrl }));
vi.mock("../../../src/services/git.service", () => ({
  detectDefaultBranch: m.detectDefaultBranch,
}));
vi.mock("../../../src/services/github-remote", () => ({
  defaultBranch: m.defaultBranch,
  branches: m.branches,
}));
vi.mock("../../../src/services/cloud-settings.service", () => ({
  listAccessibleRepos: m.accessibleRepos,
}));
vi.mock("../../../src/services/agent/cloud/config", () => ({
  defaultCloudOrgId: m.defaultOrg,
}));
vi.mock("../../../src/services/query-engine", () => ({ invalidate: m.invalidate }));
vi.mock("../../../src/services/streams", () => ({ publish: vi.fn() }));
vi.mock("../../../src/services/gh.service", async () => ({
  runGh: m.runGh,
  parseGitHubRepo: (await import("@shared/lib/github")).parseGitHubRepo,
}));
vi.mock("../../../src/services/project-environment.service", () => ({
  readProjectFile: m.readProjectFile,
  writeProjectFile: m.writeProjectFile,
}));
vi.mock("../../../src/services/recent-projects.service", () => ({ listRecentProjects: vi.fn() }));
vi.mock("../../../src/services/cloud-workspace-init.service", () => ({
  resolveCloudRepoAccess: vi.fn(),
}));
vi.mock("@shared/lib/uuid", () => ({ uuidv7: () => `new-${++m.uuid}` }));

import repoHandlers from "../../../src/api/repos";

const run = operations(repoHandlers);

function rows() {
  return m.db
    .prepare(
      "SELECT id, name, root_path, git_default_branch, git_origin_url FROM repositories ORDER BY sort_order, id"
    )
    .all();
}

function insert(id: string, root: string | null, origin: string | null, branch = "main") {
  m.db
    .prepare(
      `INSERT INTO repositories (id, name, root_path, git_default_branch, sort_order, git_origin_url)
       VALUES (?, ?, ?, ?, (SELECT COALESCE(MAX(sort_order), 0) + 1 FROM repositories), ?)`
    )
    .run(id, id, root, branch, origin);
}

/** Every git or filesystem call made so far. */
function gitAndFsCalls() {
  return [
    ...m.execFile.mock.calls,
    ...m.execFileSync.mock.calls,
    ...m.spawn.mock.calls,
    ...m.remoteUrl.mock.calls,
    ...m.readProjectFile.mock.calls,
    ...m.writeProjectFile.mock.calls,
    ...m.fs.realpathSync.mock.calls,
    ...m.fs.existsSync.mock.calls,
    ...m.fs.writeFileSync.mock.calls,
    ...m.fs.mkdirSync.mock.calls,
  ];
}

beforeEach(() => {
  vi.clearAllMocks();
  m.uuid = 0;
  m.db = new Database(":memory:");
  m.db.pragma("foreign_keys = ON");
  m.db.exec(SCHEMA_SQL);
  m.defaultOrg.mockReturnValue("org-default");
  m.remoteUrl.mockReturnValue(null);
  m.detectDefaultBranch.mockResolvedValue("develop");
});

afterEach(() => m.db.close());

describe("project rows", () => {
  it.each([
    ["", "/repo"],
    ["named", ""],
  ])("refuses invalid names or folders on insert and update", (name, root) => {
    const write = m.db.prepare("INSERT INTO repositories (id, name, root_path) VALUES (?, ?, ?)");
    expect(() => write.run("new", name, root)).toThrow(/project/i);
    write.run("cloud", "valid", null);
    expect(() =>
      m.db
        .prepare("UPDATE repositories SET name = ?, root_path = ? WHERE id = 'cloud'")
        .run(name, root)
    ).toThrow(/project/i);
  });

  it("installs on an existing database without modifying its old blank row", () => {
    m.db.exec("DROP TRIGGER IF EXISTS validate_project_insert");
    insert("legacy", "", null);
    m.db.exec(SCHEMA_SQL);
    m.db.prepare("UPDATE repositories SET sort_order = 3 WHERE id = 'legacy'").run();
    expect(rows()).toEqual([expect.objectContaining({ id: "legacy", root_path: "" })]);
    expect(() => insert("another", "", null)).toThrow(/project/i);
  });
});

describe("addCloudRepo", () => {
  it("adds a project with no folder, named after the repository, its default branch from GitHub", async () => {
    m.defaultBranch.mockResolvedValue("trunk");

    const repo = await run(api.addCloudRepo, {
      repository: "acme/rocket",
      organizationId: "org-2",
    });

    expect(repo).toMatchObject({
      id: "new-1",
      name: "rocket",
      root_path: null,
      git_default_branch: "trunk",
      git_origin_url: "https://github.com/acme/rocket",
    });
    expect(m.defaultBranch).toHaveBeenCalledWith("acme/rocket", "org-2");
    expect(m.invalidate).toHaveBeenCalledWith(["workspaces"]);
    expect(gitAndFsCalls()).toEqual([]);
  });

  it("asks GitHub with the default organization when none is named", async () => {
    m.defaultBranch.mockResolvedValue("main");
    await run(api.addCloudRepo, { repository: "acme/rocket" });
    expect(m.defaultBranch).toHaveBeenCalledWith("acme/rocket", "org-default");
  });

  it("takes https and ssh addresses, in https form", async () => {
    m.defaultBranch.mockResolvedValue("main");
    const https = await run(api.addCloudRepo, {
      repository: "https://github.com/acme/one.git",
    });
    const ssh = await run(api.addCloudRepo, { repository: "git@github.com:acme/two.git" });
    const sshUrl = await run(api.addCloudRepo, { repository: "ssh://git@github.com/acme/three" });
    expect(https.git_origin_url).toBe("https://github.com/acme/one");
    expect(ssh.git_origin_url).toBe("https://github.com/acme/two");
    expect(sshUrl.git_origin_url).toBe("https://github.com/acme/three");
  });

  it("returns the project that already exists for the repository, in any form of its address", async () => {
    insert("local", "/Users/me/rocket", "git@github.com:Acme/Rocket.git");
    m.defaultBranch.mockResolvedValue("main");

    for (const repository of [
      "acme/rocket",
      "https://github.com/acme/rocket",
      "https://github.com/Acme/Rocket.git",
      "git@github.com:acme/rocket.git",
    ]) {
      const repo = await run(api.addCloudRepo, { repository });
      expect(repo.id).toBe("local");
    }
    expect(rows()).toHaveLength(1);
    expect(m.defaultBranch).not.toHaveBeenCalled();
  });

  it("returns the earlier cloud project rather than adding a second", async () => {
    m.defaultBranch.mockResolvedValue("main");
    const first = await run(api.addCloudRepo, { repository: "acme/rocket" });
    const second = await run(api.addCloudRepo, { repository: "git@github.com:acme/rocket.git" });
    expect(second.id).toBe(first.id);
    expect(rows()).toHaveLength(1);
  });

  it("refuses an address that is not GitHub, in words", async () => {
    for (const repository of [
      "https://gitlab.com/acme/rocket",
      "https://evil.example/github.com/acme/rocket",
      "git@bitbucket.org:acme/rocket.git",
      "rocket",
      "https://github.com/acme",
      "../..",
      "acme/..",
      "./rocket",
      "acme/...git",
    ]) {
      await expect(run(api.addCloudRepo, { repository })).rejects.toMatchObject({
        statusCode: 400,
        message: expect.stringContaining("Only GitHub repositories"),
      });
    }
    expect(rows()).toHaveLength(0);
  });

  it("adds the project on main when GitHub will not name its default branch", async () => {
    m.defaultBranch.mockResolvedValue(null);
    const repo = await run(api.addCloudRepo, { repository: "acme/secret" });
    expect(repo.git_default_branch).toBe("main");
    expect(repo.root_path).toBeNull();
  });
});

describe("addRepo with a folder for a project that has none", () => {
  it("gives the folder to that project instead of adding a second", async () => {
    insert("cloudy", null, "https://github.com/acme/rocket");
    m.remoteUrl.mockReturnValue("git@github.com:acme/rocket.git");

    const repo = await run(api.addRepo, { root_path: "/Users/me/rocket" });

    expect(repo).toMatchObject({
      id: "cloudy",
      root_path: "/Users/me/rocket",
      git_default_branch: "develop",
    });
    expect(rows()).toHaveLength(1);
    expect(m.invalidate).toHaveBeenCalledWith(["workspaces"]);
  });

  it("keeps two folders of one repository as two projects", async () => {
    insert("first", "/Users/me/rocket", "https://github.com/acme/rocket");
    m.remoteUrl.mockReturnValue("https://github.com/acme/rocket.git");

    const repo = await run(api.addRepo, { root_path: "/Users/me/rocket-2" });

    expect(repo.id).not.toBe("first");
    expect(rows()).toHaveLength(2);
  });

  it("adds a folder of another repository as a new project", async () => {
    insert("cloudy", null, "https://github.com/acme/rocket");
    m.remoteUrl.mockReturnValue("https://github.com/acme/other.git");

    const repo = await run(api.addRepo, { root_path: "/Users/me/other" });

    expect(repo.id).not.toBe("cloudy");
    expect(rows()).toHaveLength(2);
    expect((rows()[0] as { root_path: string | null }).root_path).toBeNull();
  });
});

describe("repoBranches for a project with no folder", () => {
  it("lists GitHub's branches, default first, with the composer's organization", async () => {
    insert("cloudy", null, "https://github.com/acme/rocket");
    m.branches.mockResolvedValue({ defaultBranch: "main", branches: ["main", "feat", "fix"] });

    const answer = await run(api.repoBranches, { repoId: "cloudy", organizationId: "org-2" });

    expect(answer).toEqual({ branches: [{ name: "main" }, { name: "feat" }, { name: "fix" }] });
    expect(m.branches).toHaveBeenCalledWith("acme/rocket", "org-2");
    expect(gitAndFsCalls()).toEqual([]);
  });

  it("corrects the project's default branch when GitHub names another", async () => {
    insert("cloudy", null, "https://github.com/acme/rocket", "main");
    m.branches.mockResolvedValue({ defaultBranch: "trunk", branches: ["trunk", "main"] });

    await run(api.repoBranches, { repoId: "cloudy" });

    expect(m.branches).toHaveBeenCalledWith("acme/rocket", "org-default");
    expect((rows()[0] as { git_default_branch: string }).git_default_branch).toBe("trunk");
    expect(m.invalidate).toHaveBeenCalledWith(["workspaces"]);
  });

  it("leaves the project alone when GitHub will not answer", async () => {
    insert("cloudy", null, "https://github.com/acme/rocket", "main");
    m.branches.mockResolvedValue({ defaultBranch: null, branches: [] });

    expect(await run(api.repoBranches, { repoId: "cloudy" })).toEqual({ branches: [] });
    expect((rows()[0] as { git_default_branch: string }).git_default_branch).toBe("main");
    expect(m.invalidate).not.toHaveBeenCalled();
  });

  it("still reads local git for a project with a folder", async () => {
    insert("local", "/Users/me/rocket", "https://github.com/acme/rocket");
    m.execFile.mockImplementation((_cmd, _args, _opts, cb) =>
      cb(null, { stdout: "main\nfeat\n", stderr: "" })
    );

    const answer = await run(api.repoBranches, { repoId: "local" });

    expect(answer).toEqual({
      branches: [
        { name: "main", is_remote: true },
        { name: "feat", is_remote: true },
      ],
    });
    expect(m.execFile.mock.calls[0][2]).toMatchObject({ cwd: "/Users/me/rocket" });
    expect(m.branches).not.toHaveBeenCalled();
  });
});

describe("a project with no folder never reaches git or the filesystem", () => {
  beforeEach(() => insert("cloudy", null, "https://github.com/acme/rocket"));

  it("refuses its environment file in words", async () => {
    await expect(run(api.repoEnvironmentFile, { repoId: "cloudy" })).rejects.toMatchObject({
      statusCode: 409,
      message: expect.stringContaining("not on this computer"),
    });
    await expect(
      run(api.saveRepoEnvironmentFile, {
        repoId: "cloudy",
        project: { version: 1, setup: "bun install" },
      })
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(gitAndFsCalls()).toEqual([]);
  });

  it("asks GitHub for its pull requests by its address, from no folder", async () => {
    m.runGh.mockResolvedValue({ success: true, stdout: "[]" });
    expect(await run(api.repoPrs, { repoId: "cloudy" })).toEqual([]);
    expect(m.runGh).toHaveBeenCalledWith(
      expect.arrayContaining(["--repo", "acme/rocket"]),
      expect.objectContaining({ cwd: undefined })
    );
    expect(gitAndFsCalls()).toEqual([]);
  });
});

describe("cloudRepositories", () => {
  it("lists the organization's repositories, marking the ones that are projects", async () => {
    insert("local", "/Users/me/rocket", "git@github.com:acme/rocket.git");
    insert("cloudy", null, "https://github.com/acme/cloudy");
    insert("elsewhere", "/Users/me/lab", "https://gitlab.com/acme/lab");
    m.accessibleRepos.mockResolvedValue({ repos: ["acme/rocket", "acme/cloudy", "acme/new"] });

    const answer = await run(api.cloudRepositories, { organizationId: "org-2" });

    expect(m.accessibleRepos).toHaveBeenCalledWith("org-2");
    expect(answer).toEqual({
      repositories: [
        { slug: "acme/rocket", repoId: "local" },
        { slug: "acme/cloudy", repoId: "cloudy" },
        { slug: "acme/new", repoId: null },
      ],
    });
  });

  it("uses the default organization when none is named", async () => {
    m.accessibleRepos.mockResolvedValue({ repos: [] });
    expect(await run(api.cloudRepositories, {})).toEqual({ repositories: [] });
    expect(m.accessibleRepos).toHaveBeenCalledWith("org-default");
  });

  it("says to sign in when there is no organization", async () => {
    m.defaultOrg.mockReturnValue(null);
    await expect(run(api.cloudRepositories, {})).rejects.toMatchObject({
      statusCode: 409,
      message: expect.stringContaining("Sign in to Deus Cloud"),
    });
    expect(m.accessibleRepos).not.toHaveBeenCalled();
  });
});
