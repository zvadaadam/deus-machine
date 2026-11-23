/**
 * Projects with no folder on this computer: adding one from GitHub, one
 * project per repository, GitHub's branches, and the guards that keep such a
 * row away from git and the filesystem. Runs against a real SQLite database
 * built from the fresh schema.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import * as gitProcess from "@shared/lib/git-process";
import Database from "better-sqlite3";
import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import { SCHEMA_SQL } from "@shared/schema";
import * as api from "@shared/api/repos";
import { operations } from "../../helpers";

const m = vi.hoisted(() => ({
  db: null as unknown as Database.Database,
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

let scratch: string;
const fsMethods = ["realpathSync", "existsSync", "writeFileSync", "mkdirSync"] as const;
function expectNoLocalReadsOrWrites() {
  for (const op of [
    gitProcess.runGit,
    m.detectDefaultBranch,
    m.readProjectFile,
    m.writeProjectFile,
    ...fsMethods.map((name) => fs[name]),
  ])
    expect(op).not.toHaveBeenCalled();
}

function folder(name: string, origin: string) {
  const root = path.join(scratch, name);
  execFileSync("git", ["init", "-q", "-b", "develop", root]);
  execFileSync("git", ["-C", root, "remote", "add", "origin", origin]);
  return root;
}

beforeEach(() => {
  vi.clearAllMocks();
  m.uuid = 0;
  m.db = new Database(":memory:");
  m.db.pragma("foreign_keys = ON");
  m.db.exec(SCHEMA_SQL);
  m.defaultOrg.mockReturnValue("org-default");
  scratch = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), "deus-cloud-repos-")));
  vi.stubEnv("GIT_CONFIG_GLOBAL", path.join(scratch, "no-global-config"));
  vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");
  vi.spyOn(gitProcess, "runGit");
  for (const name of fsMethods) vi.spyOn(fs, name);
  m.detectDefaultBranch.mockResolvedValue("develop");
});

afterEach(() => {
  vi.unstubAllEnvs();
  m.db.close();
  fs.rmSync(scratch, { recursive: true, force: true });
});

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
    expectNoLocalReadsOrWrites();
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
    const root = folder("rocket", "git@github.com:acme/rocket.git");

    const repo = await run(api.addRepo, { root_path: root });

    expect(repo).toMatchObject({
      id: "cloudy",
      root_path: root,
      git_default_branch: "develop",
    });
    expect(rows()).toHaveLength(1);
    expect(m.invalidate).toHaveBeenCalledWith(["workspaces"]);
  });

  it("keeps two folders of one repository as two projects", async () => {
    insert("first", "/Users/me/rocket", "https://github.com/acme/rocket");
    const root = folder("rocket-2", "https://github.com/acme/rocket.git");

    const repo = await run(api.addRepo, { root_path: root });

    expect(repo.id).not.toBe("first");
    expect(rows()).toHaveLength(2);
  });

  it("adds a folder of another repository as a new project", async () => {
    insert("cloudy", null, "https://github.com/acme/rocket");
    const root = folder("other", "https://github.com/acme/other.git");

    const repo = await run(api.addRepo, { root_path: root });

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
    expectNoLocalReadsOrWrites();
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
    const root = folder("rocket", "https://github.com/acme/rocket");
    insert("local", root, "https://github.com/acme/rocket");
    execFileSync("git", [
      "-C",
      root,
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.test",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "--allow-empty",
      "-qm",
      "first",
    ]);
    execFileSync("git", ["-C", root, "update-ref", "refs/remotes/origin/feat", "HEAD"]);

    expect(await run(api.repoBranches, { repoId: "local" })).toEqual({
      branches: [{ name: "feat", is_remote: true }],
    });
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
    expectNoLocalReadsOrWrites();
  });

  it("asks GitHub for its pull requests by its address, from no folder", async () => {
    m.runGh.mockResolvedValue({ success: true, stdout: "[]" });
    expect(await run(api.repoPrs, { repoId: "cloudy" })).toEqual([]);
    expect(m.runGh).toHaveBeenCalledWith(
      expect.arrayContaining(["--repo", "acme/rocket"]),
      expect.objectContaining({ cwd: undefined })
    );
    expectNoLocalReadsOrWrites();
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
