/**
 * Starting a local workspace, failing, and coming back: real git in a scratch
 * repository, the real schema in memory.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import Database from "better-sqlite3";
import { SCHEMA_SQL } from "@shared/schema";

const mocks = vi.hoisted(() => ({
  db: undefined as Database.Database | undefined,
  invalidate: vi.fn(),
}));
vi.mock("../../../src/lib/database", () => ({ getDatabase: () => mocks.db }));
vi.mock("../../../src/services/query-engine", () => ({ invalidate: mocks.invalidate }));
vi.mock("../../../src/services/agent/cloud/config", async () =>
  (await import("../../cloud-config-mock")).cloudConfigMock(() => null)
);
vi.mock("../../../src/services/cloud-environment.service", () => ({
  getCloudEnvironmentInfo: vi.fn(),
}));
vi.mock("../../../src/services/cloud-workspace-init.service", () => ({
  pauseCloudWorkspace: vi.fn(),
  wakeCloudWorkspaceWithFeedback: vi.fn(),
}));
vi.mock("../../../src/services/workspace-status.service", () => ({
  autoProgressStatus: vi.fn(),
}));

import {
  fetchIssue,
  initializeWorkspace,
  pickWorkspaceName,
  removeWorktree,
  type InitContext,
} from "../../../src/services/workspace-checkout";
import {
  archiveWorkspace,
  unarchiveWorkspace,
} from "../../../src/services/workspace-archive.service";
import {
  failInterruptedWorkspaces,
  retryWorkspaceInit,
} from "../../../src/services/workspace-init.service";
import {
  deleteFailedWorkspace,
  prepareWorkspaceFixture,
  setSetupStatus,
} from "../../../src/services/workspace-lifecycle";
import {
  prepareLocalEnvironment,
  setupForTurn,
  writeProjectFile,
} from "../../../src/services/project-environment.service";
import * as lifecycle from "../../../src/services/workspace-lifecycle";
import { setupFile } from "../../../src/services/setup-status";
import { buildWorkspaceContext } from "../../../src/services/agent/workspace-context";
import { GitError, runGit } from "../../../src/lib/git-process";
import { CELESTIAL_NAMES } from "../../../src/services/workspace.service";

let scratch: string;
let root: string;
const gitIn = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, stdio: "pipe" }).toString().trim();
const git = (...args: string[]) => gitIn(root, ...args);
const commit = (cwd: string, file: string, text: string) => {
  fs.writeFileSync(path.join(cwd, file), text);
  gitIn(cwd, "add", ".");
  gitIn(cwd, "commit", "-qm", `${file}: ${text}`);
  return gitIn(cwd, "rev-parse", "HEAD");
};
const db = () => mocks.db!;
const row = (id: string) =>
  db().prepare("SELECT * FROM workspaces WHERE id = ?").get(id) as Record<string, unknown>;
const workspacePath = (slug: string) => path.join(root, ".deus", slug);
const branches = () => git("branch", "--format=%(refname:short)").split("\n");
const setupStatus = (id: string) => fs.readFileSync(setupFile(id, "status"), "utf8");

function setupScript(command: string) {
  fs.mkdirSync(path.join(root, ".deus"), { recursive: true });
  commit(root, ".deus/environment.json", JSON.stringify({ version: 1, setup: command }));
}

/** A workspace row as the create route writes it. */
function add(id: string, slug: string, fields: Record<string, unknown> = {}): InitContext {
  const values = {
    id,
    repository_id: "r",
    slug,
    git_branch: `test-user/${slug}`,
    git_source_branch: "main",
    git_target_branch: "main",
    state: "initializing",
    ...fields,
  };
  const columns = Object.keys(values);
  db()
    .prepare(
      `INSERT INTO workspaces (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`
    )
    .run(...Object.values(values));
  return {
    workspaceId: id,
    repoRootPath: root,
    workspacePath: workspacePath(slug),
    branchName: values.git_branch,
    sourceBranch: values.git_source_branch,
    repoOriginUrl: null,
  };
}

beforeEach(() => {
  fs.mkdirSync(".context", { recursive: true });
  scratch = fs.mkdtempSync(path.resolve(".context/workspace-start-"));
  vi.stubEnv("TMPDIR", scratch);
  root = path.join(scratch, "project");
  fs.mkdirSync(root);
  git("init", "-q", "-b", "main");
  git("config", "user.name", "Test User");
  git("config", "user.email", "test@example.test");
  commit(root, "tracked.txt", "first");
  mocks.invalidate.mockReset();
  mocks.db = new Database(":memory:");
  mocks.db.pragma("foreign_keys = ON");
  mocks.db.exec(SCHEMA_SQL);
  mocks.db
    .prepare(
      "INSERT INTO repositories (id, name, root_path, git_default_branch) VALUES ('r', 'project', ?, 'main')"
    )
    .run(root);
});
afterEach(() => {
  vi.unstubAllEnvs();
  mocks.db?.close();
  fs.rmSync(scratch, { recursive: true, force: true });
});

describe("starting a workspace", () => {
  it("makes the checkout and the first chat, and pushes every stage to clients", async () => {
    const stages = new Set();
    mocks.invalidate.mockImplementation((resources: string[]) => {
      if (resources.includes("workspaces")) stages.add(row("w").init_stage);
    });
    await initializeWorkspace(add("w", "vega"));

    expect(row("w")).toMatchObject({
      state: "ready",
      init_stage: "done",
      init_fetch_issue: null,
      error_message: null,
    });
    expect(row("w").current_session_id).toBeTruthy();
    expect(gitIn(workspacePath("vega"), "branch", "--show-current")).toBe("test-user/vega");
    expect([...stages]).toEqual(["fetch", "worktree", "session", "done"]);
    expect(setupForTurn(String(row("w").first_session_id))).toBeNull();
  });

  it("briefs any chat with its running command, then with the recorded failure and the person's retry", async () => {
    const command =
      "touch started; while [ ! -e finish ]; do sleep 0.05; done; printf 'Checking tools\\nMissing compiler\u2028Next step\u202e\\n'; exit 7";
    setupScript(command);
    await initializeWorkspace(add("w", "vega"));
    const cwd = workspacePath("vega");
    const session = String(row("w").first_session_id);
    const brief = (id: string) => buildWorkspaceContext(cwd, null, setupForTurn(id));
    try {
      await vi.waitFor(() => expect(fs.existsSync(path.join(cwd, "started"))).toBe(true));
      expect(row("w")).toMatchObject({
        state: "ready",
        setup_status: "running",
        current_session_id: session,
      });
      db().prepare("INSERT INTO sessions (id, workspace_id) VALUES ('sibling', 'w')").run();
      writeProjectFile(cwd, { version: 1, local: { setup: "echo repaired" } });
      for (const id of [session, "sibling"]) {
        const running = brief(id);
        expect(running).toContain("  | touch started;");
        expect(running).toContain(setupFile("w", "log"));
        expect(running).toContain("Do not start another install");
        expect(running).toContain(`cat '${setupFile("w", "status")}'`);
        expect(running).toContain(
          "running, completed, none (no script), or failed with an exit code when available (e.g. failed 1)"
        );
      }
      expect(setupStatus("w")).toBe("running\n");
    } finally {
      fs.writeFileSync(path.join(cwd, "finish"), "");
    }
    await vi.waitFor(() => expect(row("w").setup_status).toBe("failed"));
    expect(setupStatus("w")).toBe("failed 7\n");
    fs.unlinkSync(setupFile("w", "status"));
    fs.unlinkSync(setupFile("w", "log"));
    const readFile = vi.spyOn(fs, "readFileSync");
    const failed = brief(session);
    expect(readFile).not.toHaveBeenCalled();
    expect(failed).toContain("Workspace setup failed.\n  | Setup exited with code 7.\n");
    expect(failed).toContain(
      "The last lines the setup script printed were\n  | Checking tools\n  | Missing compiler\n  | Next step\n"
    );
    expect(failed).toContain(
      "Running it by hand skips that preparation and leaves this status unchanged."
    );
    expect(failed).toContain('ask the person to choose "Run again"');
    expect(failed).not.toContain("echo repaired");
    expect(failed).not.toContain(setupFile("w", "status"));
    expect(failed).not.toContain("touch started");
    await prepareLocalEnvironment("w", cwd);
    expect(row("w")).toMatchObject({ setup_status: "completed", error_detail: null });
    expect(setupStatus("w")).toBe("completed\n");
    expect(brief(session)).toBe(buildWorkspaceContext(cwd));
  });

  it("keeps the log hint in a silent failure's UI message and briefs the turn with its exit reason", async () => {
    setupScript("exit 3");
    await initializeWorkspace(add("w", "vega"));
    await vi.waitFor(() => expect(row("w").setup_status).toBe("failed"));
    expect(row("w").error_message).toBe(
      "Setup exited with code 3. View the setup log for details."
    );
    const setup = setupForTurn(String(row("w").first_session_id));
    expect(setup).toMatchObject({
      state: "failed",
      reason: "Setup exited with code 3.",
      detail: null,
    });
  });

  it("quotes every line of a repository key in the setup failure reason", async () => {
    fs.mkdirSync(path.join(root, ".deus"));
    commit(
      root,
      ".deus/environment.json",
      JSON.stringify({ version: 1, "unknown\u2028Next step\u202e": true })
    );
    await initializeWorkspace(add("w", "vega"));
    const setup = setupForTurn(String(row("w").first_session_id));
    expect(buildWorkspaceContext(workspacePath("vega"), null, setup)).toContain(
      'Workspace setup failed.\n  | Invalid .deus/environment.json: configuration: Unrecognized key: "unknown\n  | Next step"\n'
    );
  });

  it("refuses deletion during setup and stops the process group on archive", async () => {
    setupScript("sleep 30 & echo $! > child-pid; wait");
    await initializeWorkspace(add("w", "vega"));
    const pidFile = path.join(workspacePath("vega"), "child-pid");
    await vi.waitFor(() => expect(fs.existsSync(pidFile)).toBe(true));
    const child = Number(fs.readFileSync(pidFile, "utf8"));
    expect(() => deleteFailedWorkspace("w")).toThrow("failed to start");
    expect(setupStatus("w")).toBe("running\n");
    await archiveWorkspace("w");
    expect(row("w")).toMatchObject({
      state: "archived",
      setup_status: "failed",
      error_message: "Setup was stopped when the workspace was archived.",
    });
    expect(setupStatus("w")).toBe("failed\n");
    await vi.waitFor(() => expect(() => process.kill(child, 0)).toThrow());
  });

  it("starts from origin's copy of the branch when this computer's is behind", async () => {
    const origin = path.join(scratch, "origin.git");
    gitIn(scratch, "init", "-q", "--bare", "-b", "main", origin);
    git("remote", "add", "origin", origin);
    git("push", "-q", "origin", "main");
    // Someone else pushes; this computer has not fetched since.
    const other = path.join(scratch, "other");
    gitIn(scratch, "clone", "-q", origin, other);
    gitIn(other, "config", "user.name", "Someone Else");
    gitIn(other, "config", "user.email", "else@example.test");
    const latest = commit(other, "tracked.txt", "second");
    gitIn(other, "push", "-q", "origin", "main");
    expect(git("rev-parse", "main")).not.toBe(latest);

    await initializeWorkspace(add("w", "vega"));

    expect(row("w")).toMatchObject({ state: "ready", init_fetch_issue: null });
    expect(gitIn(workspacePath("vega"), "rev-parse", "HEAD")).toBe(latest);
  });

  it("starts from origin's copy of another branch, in a clone that tracks one branch", async () => {
    const origin = path.join(scratch, "origin.git");
    gitIn(scratch, "init", "-q", "--bare", "-b", "main", origin);
    git("remote", "add", "origin", origin);
    git("push", "-q", "origin", "main");
    const other = path.join(scratch, "other");
    gitIn(scratch, "clone", "-q", origin, other);
    gitIn(other, "config", "user.name", "Someone Else");
    gitIn(other, "config", "user.email", "else@example.test");
    gitIn(other, "checkout", "-q", "-b", "release");
    const latest = commit(other, "tracked.txt", "release");
    gitIn(other, "push", "-q", "origin", "release");
    // As `git clone --single-branch` (or `--depth`) leaves it: only main is tracked.
    git("config", "remote.origin.fetch", "+refs/heads/main:refs/remotes/origin/main");

    await initializeWorkspace({
      ...add("w", "vega", { git_source_branch: "release" }),
      sourceBranch: "release",
    });

    expect(row("w")).toMatchObject({ state: "ready", init_fetch_issue: null });
    expect(gitIn(workspacePath("vega"), "rev-parse", "HEAD")).toBe(latest);
  });

  it("still starts when origin cannot be reached, from the local copy, and says why", async () => {
    git("remote", "add", "origin", "http://127.0.0.1:9/project.git");

    await initializeWorkspace(add("w", "vega"));

    expect(row("w")).toMatchObject({ state: "ready", init_fetch_issue: "offline" });
    expect(gitIn(workspacePath("vega"), "rev-parse", "HEAD")).toBe(git("rev-parse", "main"));
  });

  it("says nothing about origin for a project that has none", async () => {
    await initializeWorkspace(add("w", "vega"));
    expect(row("w").init_fetch_issue).toBeNull();
  });

  it("takes another name instead of reusing or removing one that is taken on disk", async () => {
    // Left from a reset database: a folder with someone's work, and a branch.
    fs.mkdirSync(workspacePath("vega"), { recursive: true });
    fs.writeFileSync(path.join(workspacePath("vega"), "keep.txt"), "mine");
    git("branch", "test-user/vega");

    await initializeWorkspace(add("w", "vega"));

    const started = row("w");
    expect(started.state).toBe("ready");
    expect(started.slug).not.toBe("vega");
    expect(started.git_branch).toBe(`test-user/${started.slug}`);
    expect(fs.existsSync(path.join(workspacePath(started.slug as string), "tracked.txt"))).toBe(
      true
    );
    expect(fs.readFileSync(path.join(workspacePath("vega"), "keep.txt"), "utf8")).toBe("mine");
    expect(branches()).toContain("test-user/vega");
  });
});

describe("a start that fails", () => {
  it("gives a plain reason and git's own words, and leaves nothing behind", async () => {
    await initializeWorkspace(add("w", "vega", { git_source_branch: "develop" }));

    expect(row("w")).toMatchObject({
      state: "error",
      init_stage: "worktree",
      current_session_id: null,
      error_message: 'The branch "develop" does not exist in this project.',
    });
    expect(row("w").error_detail).toContain("git worktree add");
    expect(row("w").error_detail).toContain("invalid reference: develop");
    expect(fs.existsSync(workspacePath("vega"))).toBe(false);
    expect(branches()).toEqual(["main"]);
  });

  it("is started again on the same row, and only once", async () => {
    await initializeWorkspace(add("w", "vega", { git_source_branch: "develop" }));
    git("branch", "develop");

    await retryWorkspaceInit("w");
    // The claim is taken: a second click, or a second device, starts nothing.
    await expect(retryWorkspaceInit("w")).rejects.toThrow("not waiting for a retry");
    expect(row("w")).toMatchObject({ state: "initializing", error_message: null });

    await vi.waitFor(() => expect(row("w").state).toBe("ready"), { timeout: 8000 });
    expect(row("w")).toMatchObject({ slug: "vega", error_detail: null, init_stage: "done" });
    expect(gitIn(workspacePath("vega"), "branch", "--show-current")).toBe("test-user/vega");
    expect(
      db().prepare("SELECT count(*) AS n FROM sessions WHERE workspace_id = 'w'").get()
    ).toEqual({ n: 1 });
    await expect(retryWorkspaceInit("w")).rejects.toThrow("not waiting for a retry");
  });

  it("names a project folder that is gone", async () => {
    const ctx = add("w", "vega");
    fs.rmSync(root, { recursive: true });
    await initializeWorkspace(ctx);
    expect(row("w").state).toBe("error");
    expect(row("w").error_message).toContain("The project folder is missing");
  });

  it("removes a worktree that was cut short while being made", async () => {
    git("worktree", "add", "-q", "-b", "test-user/vega", workspacePath("vega"), "main");
    // What a killed `git worktree add` leaves: registered, and locked.
    git("worktree", "lock", "--reason", "initializing", workspacePath("vega"));

    await removeWorktree(root, workspacePath("vega"), "test-user/vega");

    expect(fs.existsSync(workspacePath("vega"))).toBe(false);
    expect(git("worktree", "list")).not.toContain("vega");
    expect(branches()).toEqual(["main"]);
    // And it is a quiet no-op when there is nothing to remove.
    await removeWorktree(root, workspacePath("vega"), "test-user/vega");
  });

  it("stops a command that runs too long, with everything it started", async () => {
    const started = Date.now();
    const pidFile = path.join(scratch, "pid");
    const failure = await runGit(
      ["-c", `alias.wait=!sh -c 'sleep 30 & echo $! > "${pidFile}"; wait'`, "wait"],
      { cwd: root, timeoutMs: 300 }
    ).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(GitError);
    expect((failure as GitError).timedOut).toBe(true);
    expect(Date.now() - started).toBeLessThan(5000);
    // The grandchild is gone too: a checkout does not keep writing after its command is stopped.
    const grandchild = Number(fs.readFileSync(pidFile, "utf8"));
    await vi.waitFor(() => expect(() => process.kill(grandchild, 0)).toThrow());
  });

  it("stops what is still running when the backend stops, and starts nothing after", async () => {
    // A module of its own: once stopped it stays stopped, as the backend does.
    vi.resetModules();
    const git = await import("../../../src/lib/git-process");
    const groups = await import("../../../src/lib/process-groups");
    const pidFile = path.join(scratch, "pid");
    const running = git
      .runGit(["-c", `alias.wait=!sh -c 'sleep 30 & echo $! > "${pidFile}"; wait'`, "wait"], {
        cwd: root,
        timeoutMs: 60_000,
      })
      .catch((error: unknown) => error);
    await vi.waitFor(() => expect(fs.existsSync(pidFile)).toBe(true));
    const grandchild = Number(fs.readFileSync(pidFile, "utf8"));
    const stopped = Date.now();

    groups.stopProcessGroups();

    expect(await running).toBeInstanceOf(git.GitError);
    expect(Date.now() - stopped).toBeLessThan(5000);
    await vi.waitFor(() => expect(() => process.kill(grandchild, 0)).toThrow());
    // What a start asks for next is refused without running: no new writer.
    const later = path.join(scratch, "later");
    await expect(
      git.runGit(["-c", `alias.mark=!touch "${later}"`, "mark"], { cwd: root })
    ).rejects.toBeInstanceOf(git.GitError);
    expect(fs.existsSync(later)).toBe(false);
  });
});

describe("a start Deus closed in the middle of", () => {
  it("keeps its ready checkout and chat when Deus quits during setup", async () => {
    setupScript("touch started; sleep 30");
    // Modules of their own: once stopped they stay stopped, as the backend does.
    vi.resetModules();
    const groups = await import("../../../src/lib/process-groups");
    const init = await import("../../../src/services/workspace-checkout");
    await init.initializeWorkspace(add("w", "vega"));
    await vi.waitFor(() =>
      expect(fs.existsSync(path.join(workspacePath("vega"), "started"))).toBe(true)
    );
    const chat = row("w").first_session_id;
    expect(chat).toBeTruthy();
    expect(row("w")).toMatchObject({
      state: "ready",
      current_session_id: chat,
      setup_status: "running",
    });
    expect(setupStatus("w")).toBe("running\n");

    groups.stopProcessGroups();
    await vi.waitFor(() => expect(row("w").setup_status).toBe("failed"));
    expect(row("w")).toMatchObject({
      state: "ready",
      init_stage: "done",
      current_session_id: chat,
      error_message: "Setup was stopped when Deus closed. Run it again.",
    });
    expect(setupStatus("w")).toBe("failed\n");
    expect(gitIn(workspacePath("vega"), "branch", "--show-current")).toBe("test-user/vega");
  });
});

describe("workspaces a previous process was still starting", () => {
  it("commits setup status and removes the stale file when publishing its replacement fails", () => {
    add("w", "vega", { state: "ready" });
    setSetupStatus("w", "running");
    expect(setupStatus("w")).toBe("running\n");
    let committed = false;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(fs, "renameSync").mockImplementationOnce(() => {
      committed = !db().inTransaction && row("w").setup_status === "failed";
      throw new Error("cannot publish status");
    });
    setSetupStatus("w", "failed", { message: "Setup failed" });
    expect(committed).toBe(true);
    expect(row("w").error_message).toBe("Setup failed");
    expect(fs.readdirSync(scratch)).toEqual(["project"]);
    expect(warn).toHaveBeenCalledOnce();
  });

  it("recovers interrupted workspaces even when the temp directory cannot hold a file", () => {
    add("w", "vega", { state: "ready", setup_status: "running" });
    add("early", "lyra", { init_stage: "fetch" });
    vi.stubEnv("TMPDIR", path.join(root, "tracked.txt"));
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(failInterruptedWorkspaces()).toBe(1);
    expect(row("w")).toMatchObject({
      state: "ready",
      setup_status: "failed",
      error_message: "Setup was stopped when Deus closed. Run it again.",
    });
    expect(row("early").state).toBe("error");
  });

  it.each(["worktree", "setup"])(
    "fail at startup and remove the owned %s checkout",
    async (stage) => {
      add("made", "vega", { init_stage: stage });
      git("worktree", "add", "-q", "-b", "test-user/vega", workspacePath("vega"), "main");
      git("worktree", "lock", "--reason", "initializing", workspacePath("vega"));
      // Stopped before it made anything: a folder under its name is not its own.
      add("early", "lyra", { init_stage: "fetch" });
      fs.mkdirSync(workspacePath("lyra"), { recursive: true });

      expect(failInterruptedWorkspaces()).toBe(2);
      await lifecycle.changeWorkspaceState("made", async () => {});

      for (const id of ["made", "early"]) {
        expect(row(id)).toMatchObject({
          state: "error",
          error_message: "Deus closed before this workspace was ready.",
        });
      }
      await vi.waitFor(() => expect(fs.existsSync(workspacePath("vega"))).toBe(false));
      await vi.waitFor(() => expect(branches()).toEqual(["main"]));
      expect(fs.existsSync(workspacePath("lyra"))).toBe(true);
      // Either can be started again.
      await retryWorkspaceInit("made");
      await vi.waitFor(() => expect(row("made").state).toBe("ready"), { timeout: 8000 });
    }
  );

  it("leave a cloud workspace alone once its session can report, and fail a setup nobody runs", () => {
    add("ready", "vega", { state: "ready", setup_status: "running" });
    add("cloud-live", "lyra", { kind: "cloud", provider_workspace_id: "vm" });
    db().prepare("INSERT INTO sessions (id, workspace_id) VALUES ('s', 'cloud-live')").run();
    db().prepare("UPDATE workspaces SET current_session_id = 's' WHERE id = 'cloud-live'").run();
    add("cloud-lost", "mira", { kind: "cloud" });

    expect(failInterruptedWorkspaces()).toBe(1);

    expect(row("cloud-live").state).toBe("initializing");
    expect(row("cloud-lost")).toMatchObject({
      state: "error",
      error_message: "Deus closed before the cloud computer was ready.",
    });
    expect(row("ready")).toMatchObject({ state: "ready", setup_status: "failed" });
    expect(row("ready").error_message).toContain("Run it again");
    expect(setupStatus("ready")).toBe("failed\n");
  });
});

describe("deleting", () => {
  it("removes a workspace that never started", () => {
    add("w", "vega", { state: "error" });
    deleteFailedWorkspace("w");
    expect(row("w")).toBeUndefined();
  });

  it("refuses one that started, has chats, or has a cloud computer", () => {
    add("ready", "vega", { state: "ready" });
    add("used", "lyra", { state: "error" });
    db()
      .prepare("INSERT INTO sessions (id, workspace_id, message_count) VALUES ('s', 'used', 2)")
      .run();
    add("cloud", "mira", { state: "error", kind: "cloud", provider_workspace_id: "vm" });

    expect(() => deleteFailedWorkspace("ready")).toThrow("failed to start");
    expect(() => deleteFailedWorkspace("used")).toThrow("has chats");
    expect(() => deleteFailedWorkspace("cloud")).toThrow("cloud computer");
    expect(() => deleteFailedWorkspace("missing")).toThrow("not found");
    for (const id of ["ready", "used", "cloud"]) expect(row(id)).toBeDefined();
  });

  it("an archived failure comes back as a failure, not as ready", async () => {
    add("failed", "vega", { state: "archived" });
    add("worked", "lyra", { state: "archived" });
    db().prepare("INSERT INTO sessions (id, workspace_id) VALUES ('s', 'worked')").run();
    db().prepare("UPDATE workspaces SET current_session_id = 's' WHERE id = 'worked'").run();

    await unarchiveWorkspace("failed");
    await unarchiveWorkspace("worked");

    expect(row("failed").state).toBe("error");
    expect(row("worked").state).toBe("ready");
  });
});

describe("names", () => {
  it("skips a name with a folder or a branch already on disk", async () => {
    fs.mkdirSync(workspacePath(CELESTIAL_NAMES[0]), { recursive: true });
    git("branch", `test-user/${CELESTIAL_NAMES[1]}`);
    const random = vi.spyOn(Math, "random");
    [0, 1, 2].forEach((index) => random.mockReturnValueOnce(index / CELESTIAL_NAMES.length));

    expect(await pickWorkspaceName(root)).toEqual({
      slug: CELESTIAL_NAMES[2],
      branchName: `test-user/${CELESTIAL_NAMES[2]}`,
    });
    random.mockRestore();
  });

  it("sees a branch as taken when a tag has the same name", async () => {
    // Git shortens such a branch to "heads/test-user/<name>": it must not look free.
    git("branch", `test-user/${CELESTIAL_NAMES[0]}`);
    git("tag", `test-user/${CELESTIAL_NAMES[0]}`);
    const random = vi.spyOn(Math, "random");
    [0, 1].forEach((index) => random.mockReturnValueOnce(index / CELESTIAL_NAMES.length));

    expect((await pickWorkspaceName(root)).slug).toBe(CELESTIAL_NAMES[1]);
    random.mockRestore();
  });
});

it("seeds a ready integration CLI workspace once, without publishing", () => {
  const insert = prepareWorkspaceFixture(db());
  insert.run("cli", "r");
  const seeded = row("cli");
  expect(seeded).toMatchObject({
    slug: "cli-test",
    state: "ready",
    init_stage: null,
    init_fetch_issue: null,
    setup_status: "none",
    error_message: null,
    error_detail: null,
  });
  insert.run("cli", "r");
  expect(row("cli")).toEqual(seeded);
  expect(mocks.invalidate).not.toHaveBeenCalled();
});

describe("why origin's latest was not fetched", () => {
  const said = (stderr: string, timedOut = false) =>
    fetchIssue(new GitError(["fetch", "origin", "main"], stderr, timedOut));

  it("tells offline from sign-in from the rest", () => {
    expect(said("fatal: unable to access 'x': Could not resolve host: github.com")).toBe("offline");
    expect(said("fatal: unable to access 'x': Failed to connect to github.com port 443")).toBe(
      "offline"
    );
    expect(said("ssh: connect to host github.com port 22: Connection refused")).toBe("offline");
    expect(said("", true)).toBe("offline");
    expect(said("fatal: could not read Username for 'https://x': terminal prompts disabled")).toBe(
      "auth"
    );
    expect(said("git@github.com: Permission denied (publickey).")).toBe("auth");
    expect(said("remote: Repository not found.\nfatal: repository 'x' not found")).toBe("auth");
    expect(said("fatal: protocol error: bad pack header")).toBe("failed");
    expect(fetchIssue(new Error("anything else"))).toBe("failed");
  });

  it("is nothing when the branch simply is not on origin", () => {
    expect(said("fatal: couldn't find remote ref my-local-branch")).toBeNull();
  });
});

describe("an attempt owns its checkout", () => {
  it.each(["fetch", "worktree"])(
    "archive stops the %s process group and reaps the checkout before returning",
    async (stage) => {
      const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
      git("remote", "add", "origin", root);
      const bin = path.join(scratch, "bin");
      const pidFile = path.join(scratch, "child.pid");
      const release = path.join(scratch, "release");
      fs.mkdirSync(bin);
      fs.writeFileSync(
        path.join(bin, "git"),
        `#!/bin/sh
if { [ "$1" = fetch ] && [ "$HOLD_STAGE" = fetch ]; } || { [ "$1 $2" = 'worktree add' ] && [ "$HOLD_STAGE" = worktree ]; }; then
  "$REAL_GIT" "$@" || exit $?
  sleep 60 &
  helper=$!
  echo "$helper" > "$PID_FILE"
  while [ ! -f "$RELEASE" ]; do sleep 0.02; done
  kill "$helper" 2>/dev/null
  wait "$helper" 2>/dev/null
  exit 0
fi
exec "$REAL_GIT" "$@"
`,
        { mode: 0o755 }
      );
      vi.stubEnv("HOLD_STAGE", stage);
      vi.stubEnv("REAL_GIT", realGit);
      vi.stubEnv("PID_FILE", pidFile);
      vi.stubEnv("RELEASE", release);
      vi.stubEnv("PATH", bin + path.delimiter + process.env.PATH);

      const work = initializeWorkspace(add("w", "vega"));
      try {
        await vi.waitFor(() => expect(fs.existsSync(pidFile)).toBe(true), { timeout: 5000 });
        const child = Number(fs.readFileSync(pidFile, "utf8"));
        expect(row("w").init_stage).toBe(stage);
        await archiveWorkspace("w");
        await vi.waitFor(() => expect(() => process.kill(child, 0)).toThrow());
      } finally {
        fs.writeFileSync(release, "");
        await work;
      }
      expect(row("w")).toMatchObject({
        state: "archived",
        init_stage: stage,
        current_session_id: null,
      });
      expect(branches()).toEqual(["main"]);
      expect(git("worktree", "list", "--porcelain")).not.toContain(workspacePath("vega"));
      expect(fs.existsSync(workspacePath("vega"))).toBe(false);
      await unarchiveWorkspace("w");
      expect(row("w").state).toBe("error");
    }
  );

  it("archive at the first-chat step ignores a late failure and a delayed ready", async () => {
    const ready = lifecycle.finishLocalStart;
    let lateReady!: () => void;
    let archived!: ReturnType<typeof archiveWorkspace>;
    const gate = vi.spyOn(lifecycle, "finishLocalStart").mockImplementationOnce((...args) => {
      expect(row("w").init_stage).toBe("session");
      lateReady = () => ready(...args);
      archived = archiveWorkspace("w");
      throw new Error("chat creation failed at the boundary");
    });
    try {
      await initializeWorkspace(add("w", "vega"));
      await archived;
      const before = row("w");
      mocks.invalidate.mockClear();
      lateReady();
      expect(row("w")).toEqual(before);
      expect(mocks.invalidate).not.toHaveBeenCalled();
      expect(row("w")).toMatchObject({ state: "archived", current_session_id: null });
      expect(branches()).toEqual(["main"]);
      expect(git("worktree", "list", "--porcelain")).not.toContain(workspacePath("vega"));
      expect(fs.existsSync(workspacePath("vega"))).toBe(false);
    } finally {
      gate.mockRestore();
    }
  });

  it("ignores every previous attempt result while a retry is initializing", async () => {
    const stages = vi.spyOn(lifecycle, "advanceLocalStage");
    try {
      await initializeWorkspace(add("w", "vega", { git_source_branch: "missing" }));
      const original = stages.mock.calls[0][2];
      git("branch", "missing");
      let before: unknown;
      let after: unknown;
      let publishes = 0;
      mocks.invalidate.mockImplementation(() => {
        if (before || row("w").init_stage !== "fetch") return;
        before = row("w");
        const n = mocks.invalidate.mock.calls.length;
        lifecycle.advanceLocalStage("w", "session", original);
        lifecycle.recordFetchOutcome("w", "offline", original);
        lifecycle.finishLocalStart("w", () => {}, original);
        lifecycle.failStart("w", "session", { message: "old failure", detail: null }, original);
        after = row("w");
        publishes = mocks.invalidate.mock.calls.length - n;
      });
      await retryWorkspaceInit("w");
      await vi.waitFor(() => expect(row("w").init_stage).toBe("done"), { timeout: 3000 });
      expect(after).toEqual(before);
      expect(publishes).toBe(0);
      expect(row("w").state).toBe("ready");
    } finally {
      stages.mockRestore();
    }
  });

  it("requires an initializing row even when the attempt token is current", async () => {
    const advance = lifecycle.advanceLocalStage;
    const observations: [unknown, unknown, number][] = [];
    const stage = vi
      .spyOn(lifecycle, "advanceLocalStage")
      .mockImplementationOnce((id, step, token) => {
        for (const state of ["error", "ready", "archived"]) {
          db().prepare("UPDATE workspaces SET state = ? WHERE id = ?").run(state, id);
          const before = row(id);
          const n = mocks.invalidate.mock.calls.length;
          advance(id, step, token);
          lifecycle.recordFetchOutcome(id, "offline", token);
          lifecycle.finishLocalStart(id, () => {}, token);
          lifecycle.failStart(id, step, { message: "late", detail: null }, token);
          observations.push([before, row(id), mocks.invalidate.mock.calls.length - n]);
        }
        db().prepare("UPDATE workspaces SET state = 'initializing' WHERE id = ?").run(id);
        advance(id, step, token);
      });
    try {
      await initializeWorkspace(add("w", "vega"));
      expect(observations).toHaveLength(3);
      for (const [before, after, notifications] of observations) {
        expect(after).toEqual(before);
        expect(notifications).toBe(0);
      }
    } finally {
      stage.mockRestore();
    }
  });

  it("recovers the durable session stage if first-chat cleanup is interrupted", async () => {
    const ctx = add("w", "vega");
    db().exec(
      "CREATE TRIGGER refuse_chat BEFORE INSERT ON sessions BEGIN SELECT RAISE(ABORT,'chat refused'); END"
    );
    vi.spyOn(fs.promises, "rm").mockRejectedValueOnce(new Error("cleanup interrupted"));
    await initializeWorkspace(ctx);
    expect(row("w")).toMatchObject({
      state: "initializing",
      init_stage: "session",
      current_session_id: null,
    });
    expect(branches()).toContain("test-user/vega");
    expect(failInterruptedWorkspaces()).toBe(1);
    await lifecycle.changeWorkspaceState("w", async () => {});
    expect(row("w")).toMatchObject({
      state: "error",
      error_message: "Deus closed before this workspace was ready.",
    });
    expect(branches()).toEqual(["main"]);
  });

  it.each(["worktree", "setup", "session", "failed first chat"])(
    "queues two immediate retries behind %s cleanup",
    async (stage) => {
      const failed = stage === "failed first chat";
      const ctx = add("w", "vega", {
        init_stage: stage,
        git_source_branch: "main",
      });
      if (failed)
        db().exec(
          "CREATE TRIGGER refuse_chat BEFORE INSERT ON sessions BEGIN SELECT RAISE(ABORT,'chat refused'); END"
        );
      else git("worktree", "add", "-q", "-b", "test-user/vega", workspacePath("vega"), "main");
      const removing = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const rm = fs.promises.rm.bind(fs.promises);
      const hold = vi.spyOn(fs.promises, "rm").mockImplementationOnce(async (...args) => {
        removing.resolve();
        await release.promise;
        return rm(...args);
      });
      try {
        const first = failed ? initializeWorkspace(ctx) : undefined;
        if (failed) {
          await removing.promise;
          db().exec("DROP TRIGGER refuse_chat");
        } else {
          expect(failInterruptedWorkspaces()).toBe(1);
        }
        const requests = Promise.allSettled([1, 2].map(async () => retryWorkspaceInit("w")));
        await removing.promise;
        const stateDuringCleanup = row("w").state;
        const branchDuringCleanup = branches();
        if (stateDuringCleanup === "initializing")
          expect(() => deleteFailedWorkspace("w")).toThrow();

        release.resolve();
        const results = await requests;
        await first;
        expect(results.map((r) => r.status)).toEqual(["fulfilled", "rejected"]);
        await vi.waitFor(() => expect(row("w").state).toBe("ready"), { timeout: 5000 });
        expect(stateDuringCleanup).toBe("initializing");
        expect(branchDuringCleanup).toContain("test-user/vega");
        expect(results[1]).toMatchObject({
          reason: { message: "This workspace is not waiting for a retry." },
        });
        expect(row("w").slug).toBe("vega");
        expect(branches()).toEqual(["main", "test-user/vega"]);
        expect(
          db().prepare("SELECT count(*) FROM sessions WHERE workspace_id = 'w'").pluck().get()
        ).toBe(1);
      } finally {
        release.resolve();
        hold.mockRestore();
      }
    }
  );
});

describe("only a failed start can be retried or deleted", () => {
  it.each(["retry", "delete"])(
    "checks state, pointer, all sessions and cloud computer before %s",
    (operation) => {
      const mismatches: string[] = [];
      for (const kind of ["cloud", "worktree"]) {
        for (const state of ["initializing", "ready", "archived", "error"]) {
          for (const pointer of [null, "unselected"]) {
            for (const chat of [false, true]) {
              for (const provider of [null, "computer"]) {
                const id = [kind, state, pointer, chat, provider].join("-");
                add(id, id, {
                  kind,
                  state,
                  current_session_id: pointer,
                  provider_workspace_id: provider,
                });
                if (chat)
                  db()
                    .prepare("INSERT INTO sessions (id, workspace_id) VALUES (?, ?)")
                    .run("s-" + id, id);
                let accepted = true;
                try {
                  if (operation === "delete") deleteFailedWorkspace(id);
                  else if (kind === "cloud") lifecycle.claimCloudRetry(db(), id);
                  else lifecycle.claimLocalRetry(id);
                } catch (error) {
                  expect(error).toMatchObject({ statusCode: 409 });
                  accepted = false;
                }
                if (accepted !== (state === "error" && !pointer && !chat && !provider))
                  mismatches.push(id);
              }
            }
          }
        }
      }
      expect(mismatches).toEqual([]);
    }
  );
});
