import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import Database from "better-sqlite3";
import type { ProjectEnvironment } from "@deus-hq/api";

const mocks = vi.hoisted(() => ({
  db: undefined as Database.Database | undefined,
  cloud: vi.fn(),
  saved: vi.fn(),
}));
vi.mock("../../../src/lib/database", () => ({ getDatabase: () => mocks.db }));
vi.mock("../../../src/services/query-engine", () => ({ invalidate: vi.fn() }));
vi.mock("../../../src/services/agent/cloud/config", () => ({ getCloudConfig: mocks.cloud }));
vi.mock("../../../src/services/cloud-environment.service", () => ({
  getCloudEnvironmentInfo: mocks.saved,
}));
import { initializeWorkspace } from "../../../src/services/workspace-init.service";
import {
  readLocalProjectEnvironment,
  prepareLocalEnvironment,
  writeProjectFile,
  readProjectFile,
  localProjectEnv,
  projectEnvironmentResponse,
} from "../../../src/services/project-environment.service";

let root: string;
const git = (...args: string[]) =>
  execFileSync("git", args, { cwd: root, stdio: "pipe" }).toString().trim();
const workspaceId = "environment-test";
function project(recipe: ProjectEnvironment) {
  writeProjectFile(root, recipe);
}
function row() {
  return mocks.db!.prepare("SELECT * FROM workspaces WHERE id = ?").get(workspaceId) as Record<
    string,
    unknown
  >;
}
async function initialize() {
  git("add", ".");
  git(
    "-c",
    "user.name=Environment Test",
    "-c",
    "user.email=test@example.test",
    "commit",
    "-qm",
    "fixture"
  );
  const directory = path.join(root, ".deus", "workspace");
  await initializeWorkspace({
    workspaceId,
    repositoryId: "repo",
    repoRootPath: root,
    workspacePath: directory,
    branchName: "test-workspace",
    worktreeBase: "main",
    parentBranch: "main",
    repoOriginUrl: "https://github.com/test/app",
  });
  return directory;
}
beforeEach(() => {
  fs.mkdirSync(".context", { recursive: true });
  root = fs.mkdtempSync(path.resolve(".context/environment-test-"));
  git("init", "-b", "main");
  fs.writeFileSync(path.join(root, "tracked.txt"), "original\n");
  fs.writeFileSync(
    path.join(root, ".gitignore"),
    ".env\n.env.local\n.deus/*\n!.deus/environment.json\n"
  );
  mocks.cloud.mockReturnValue(null);
  mocks.saved.mockReset();
  mocks.db = new Database(":memory:");
  mocks.db.exec(
    "CREATE TABLE workspaces (id TEXT PRIMARY KEY, init_stage TEXT, setup_status TEXT DEFAULT 'none', error_message TEXT, state TEXT DEFAULT 'initializing', current_session_id TEXT); CREATE TABLE sessions (id TEXT, workspace_id TEXT, status TEXT, updated_at TEXT)"
  );
  mocks.db.prepare("INSERT INTO workspaces (id) VALUES (?)").run(workspaceId);
});
afterEach(() => {
  mocks.db?.close();
  fs.rmSync(root, { recursive: true, force: true });
});

describe("local project environment journey", () => {
  it("checks out a real branch, copies local secrets before setup, runs one local script and preserves tracked changes", async () => {
    project({
      version: 1,
      setup: "exit 99",
      local: {
        setup: 'printf "%s" "$APP_SECRET" > proof.txt\nprintf "setup edit\\n" >> tracked.txt',
      },
      requiredEnv: ["APP_SECRET"],
    });
    fs.writeFileSync(path.join(root, ".env"), "APP_SECRET=local-test-value\n");
    const directory = await initialize();
    expect(row()).toMatchObject({ state: "ready", setup_status: "completed", init_stage: "done" });
    expect(fs.readFileSync(path.join(directory, "proof.txt"), "utf8")).toBe("local-test-value");
    expect(fs.readFileSync(path.join(directory, "tracked.txt"), "utf8")).toBe(
      "original\nsetup edit\n"
    );
    expect(git("status", "--short")).toBe("");
    expect((await readLocalProjectEnvironment(directory)).source).toBe("repository");
  });
  it("uses saved defaults only when this checkout has no file, never another branch's file", async () => {
    const directory = await initialize();
    project({ version: 1, setup: "exit 89" }); // Main checkout edited after the workspace branched.
    mocks.cloud.mockReturnValue({});
    mocks.saved.mockResolvedValue({
      configured: true,
      project: { version: 1, setup: "printf saved > saved.txt" },
    });
    await prepareLocalEnvironment(workspaceId, directory, "https://github.com/test/app");
    expect(fs.readFileSync(path.join(directory, "saved.txt"), "utf8")).toBe("saved");
    writeProjectFile(directory, { version: 1 });
    expect(
      (await readLocalProjectEnvironment(directory, "https://github.com/test/app")).project
    ).toEqual({ version: 1 });
  });
  it("reports invalid files, allows repair and an explicit retry, and never falls back on an error", async () => {
    fs.mkdirSync(path.join(root, ".deus"));
    fs.writeFileSync(path.join(root, ".deus/environment.json"), "broken");
    const directory = await initialize();
    expect(row()).toMatchObject({ state: "ready", setup_status: "failed" });
    expect(row().error_message).toContain("invalid JSON");
    expect(mocks.saved).not.toHaveBeenCalled();
    writeProjectFile(directory, { version: 1, setup: "printf repaired > proof.txt" });
    await prepareLocalEnvironment(workspaceId, directory);
    expect(row().setup_status).toBe("completed");
    expect(fs.readFileSync(path.join(directory, "proof.txt"), "utf8")).toBe("repaired");
  });
  it("fails on unavailable saved settings and missing required names without exposing values", async () => {
    mocks.cloud.mockReturnValue({});
    mocks.saved.mockResolvedValue({ configured: false, lookupFailed: true });
    const directory = await initialize();
    expect(row().setup_status).toBe("failed");
    expect(row().error_message).toContain("cloud connection");
    writeProjectFile(directory, {
      version: 1,
      requiredEnv: ["MISSING_TEST_KEY"],
      env: { APP_SECRET: "never-print-me" },
    });
    await prepareLocalEnvironment(workspaceId, directory);
    expect(row().error_message).toContain("MISSING_TEST_KEY");
    expect(JSON.stringify(row())).not.toContain("never-print-me");
  });
  it("runs multiline shell scripts with shared state and stops on a failing command", async () => {
    project({
      version: 1,
      setup: "mkdir nested\ncd nested\nprintf done > proof.txt\nfalse\nprintf bad > unexpected.txt",
    });
    const directory = await initialize();
    expect(row().setup_status).toBe("failed");
    expect(fs.readFileSync(path.join(directory, "nested/proof.txt"), "utf8")).toBe("done");
    expect(fs.existsSync(path.join(directory, "nested/unexpected.txt"))).toBe(false);
  });
  it("makes a saved recipe publishable while retaining ignored workspace data", () => {
    fs.writeFileSync(path.join(root, ".gitignore"), ".deus/\n");
    project({ version: 1, setup: "echo setup" });
    fs.mkdirSync(path.join(root, ".deus/other-workspace"));
    fs.writeFileSync(path.join(root, ".deus/other-workspace/private"), "private");
    const files = git("ls-files", "--others", "--exclude-standard");
    expect(files).toContain(".deus/environment.json");
    expect(files).not.toContain("other-workspace");
  });
  it("rejects symlinks when reading or saving repository configuration", () => {
    const outside = path.join(root, "outside.json");
    fs.writeFileSync(outside, '{"version":1}');
    fs.mkdirSync(path.join(root, ".deus"));
    fs.symlinkSync(outside, path.join(root, ".deus/environment.json"));
    expect(() => readProjectFile(root)).toThrow("symbolic link");
    expect(() => project({ version: 1, setup: "echo wrong" })).toThrow("symbolic link");
    expect(fs.readFileSync(outside, "utf8")).toBe('{"version":1}');
  });
  it("merges public defaults with local dotenv for setup and terminal processes without changing parent env", () => {
    fs.writeFileSync(path.join(root, ".env"), "APP_LOCAL_TEST=dotenv\n");
    const env = localProjectEnv(
      {
        version: 1,
        env: { APP_LOCAL_TEST: "public", COMMON_TEST: "base" },
        local: { env: { COMMON_TEST: "local" } },
      },
      root
    );
    expect(env).toMatchObject({ APP_LOCAL_TEST: "dotenv", COMMON_TEST: "local" });
    expect(process.env.APP_LOCAL_TEST).toBeUndefined();
  });
});

describe("workspace Run commands", () => {
  it("offers local Run and shared tasks, leaving the cloud app to AGNT supervision", () => {
    const recipe: ProjectEnvironment = {
      version: 1,
      run: "bun run dev",
      cloud: { run: "bun run dev --host 0.0.0.0" },
      tasks: { test: "bun test" },
    };
    expect(projectEnvironmentResponse(recipe, "repository", "local").tasks).toEqual([
      { name: "run", command: "bun run dev" },
      { name: "test", command: "bun test" },
    ]);
    expect(projectEnvironmentResponse(recipe, "repository", "cloud").tasks).toEqual([
      { name: "test", command: "bun test" },
    ]);
  });
});
