import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { Writable } from "node:stream";
import Database from "better-sqlite3";
import type { ProjectEnvironment } from "@deus-hq/api";

const mocks = vi.hoisted(() => ({
  db: undefined as Database.Database | undefined,
  cloud: vi.fn(),
  saved: vi.fn(),
}));
vi.mock("../../../src/lib/database", () => ({ getDatabase: () => mocks.db }));
vi.mock("../../../src/services/query-engine", () => ({ invalidate: vi.fn() }));
vi.mock("../../../src/services/agent/cloud/config", async () =>
  (await import("../../cloud-config-mock")).cloudConfigMock(mocks.cloud)
);
vi.mock("../../../src/services/cloud-environment.service", () => ({
  getCloudEnvironmentInfo: mocks.saved,
}));
import { initializeWorkspace } from "../../../src/services/workspace-checkout";
import { setupFile } from "../../../src/services/setup-status";
import {
  readLocalProjectEnvironment,
  prepareLocalEnvironment,
  writeProjectFile,
  readProjectFile,
  localProjectEnv,
  projectEnvironmentResponse,
  runSetupCommand,
  stopWorkspaceSetup,
} from "../../../src/services/project-environment.service";

let root: string;
const git = (...args: string[]) =>
  execFileSync("git", args, { cwd: root, stdio: "pipe" }).toString().trim();
const workspaceId = "environment-test";
const statusFile = () => fs.readFileSync(setupFile(workspaceId, "status"), "utf8");
function project(recipe: ProjectEnvironment) {
  writeProjectFile(root, recipe);
}
function row() {
  return mocks.db!.prepare("SELECT * FROM workspaces WHERE id = ?").get(workspaceId) as Record<
    string,
    unknown
  >;
}
async function initialize(waitForSetup = true) {
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
    repoRootPath: root,
    workspacePath: directory,
    branchName: "test-workspace",
    sourceBranch: "main",
    repoOriginUrl: "https://github.com/test/app",
  });
  if (waitForSetup) await vi.waitFor(() => expect(row().setup_status).not.toBe("running"));
  return directory;
}
beforeEach(() => {
  fs.mkdirSync(".context", { recursive: true });
  root = fs.mkdtempSync(path.resolve(".context/environment-test-"));
  git("init", "-b", "main");
  vi.stubEnv("TMPDIR", path.join(root, ".git"));
  fs.writeFileSync(path.join(root, "tracked.txt"), "original\n");
  fs.writeFileSync(
    path.join(root, ".gitignore"),
    ".env\n.env.local\n.deus/*\n!.deus/environment.json\n"
  );
  mocks.cloud.mockReturnValue(null);
  mocks.saved.mockReset();
  mocks.db = new Database(":memory:");
  mocks.db.exec(
    "CREATE TABLE workspaces (id TEXT PRIMARY KEY, slug TEXT, git_branch TEXT, init_stage TEXT, init_fetch_issue TEXT, setup_status TEXT DEFAULT 'none', error_message TEXT, error_detail TEXT, state TEXT DEFAULT 'initializing', current_session_id TEXT, first_session_id TEXT, started_by TEXT); CREATE TABLE sessions (id TEXT, workspace_id TEXT, status TEXT, started_by TEXT, updated_at TEXT)"
  );
  mocks.db.prepare("INSERT INTO workspaces (id) VALUES (?)").run(workspaceId);
});
afterEach(() => {
  vi.unstubAllEnvs();
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
    expect(statusFile()).toBe("completed\n");
    expect(fs.readFileSync(path.join(directory, "proof.txt"), "utf8")).toBe("local-test-value");
    expect(fs.readFileSync(path.join(directory, "tracked.txt"), "utf8")).toBe(
      "original\nsetup edit\n"
    );
    expect(git("status", "--short")).toBe("");
    expect((await readLocalProjectEnvironment(directory)).source).toBe("repository");
  });
  it("opens the first chat under the id minted with the workspace, started by whoever started it", async () => {
    const startedBy = JSON.stringify({ kind: "session", sessionId: "lead" });
    mocks
      .db!.prepare("UPDATE workspaces SET first_session_id = 'chat-1', started_by = ? WHERE id = ?")
      .run(startedBy, workspaceId);
    await initialize();
    expect(row()).toMatchObject({
      state: "ready",
      current_session_id: "chat-1",
      setup_status: "none",
    });
    expect(statusFile()).toBe("none\n");
    expect(mocks.db!.prepare("SELECT id, started_by FROM sessions").all()).toEqual([
      { id: "chat-1", started_by: startedBy },
    ]);
  });
  it("opens no chat in a workspace archived while it started", async () => {
    mocks.db!.prepare("UPDATE workspaces SET state = 'archived' WHERE id = ?").run(workspaceId);
    await initialize();
    expect(row()).toMatchObject({ state: "archived", current_session_id: null });
    expect(mocks.db!.prepare("SELECT id FROM sessions").all()).toEqual([]);
  });
  it("uses saved defaults only when this checkout has no file, never another branch's file", async () => {
    const directory = await initialize();
    project({ version: 1, setup: "exit 89" }); // Main checkout edited after the workspace branched.
    mocks.cloud.mockReturnValue({ baseUrl: "https://cloud.test", apiKey: "key" });
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
  it("opens the chat during a saved recipe lookup and never starts its script after an archive", async () => {
    mocks.cloud.mockReturnValue({ baseUrl: "https://cloud.test", apiKey: "key" });
    let answer!: (value: unknown) => void;
    mocks.saved.mockReturnValue(new Promise((resolve) => (answer = resolve)));
    const directory = await initialize(false);
    expect(row()).toMatchObject({ state: "ready", setup_status: "running" });
    expect(statusFile()).toBe("running\n");
    expect(mocks.saved).toHaveBeenCalledTimes(1);
    await stopWorkspaceSetup(workspaceId);
    answer({ configured: true, project: { version: 1, setup: "touch unexpected" } });
    await new Promise((resolve) => setImmediate(resolve));
    expect(row()).toMatchObject({
      setup_status: "failed",
      error_message: "Setup was stopped when the workspace was archived.",
    });
    expect(statusFile()).toBe("failed\n");
    expect(fs.existsSync(path.join(directory, "unexpected"))).toBe(false);
  });
  it.each(["success", "failure"])(
    "ignores a replaced setup run's late %s in the row and its file",
    async (outcome) => {
      const directory = await initialize();
      mocks.cloud.mockReturnValue({ baseUrl: "https://cloud.test", apiKey: "key" });
      const old = Promise.withResolvers<unknown>();
      mocks.saved.mockReturnValueOnce(old.promise);
      const first = prepareLocalEnvironment(workspaceId, directory, "https://github.com/test/app");
      expect(mocks.saved).toHaveBeenCalledOnce();
      await stopWorkspaceSetup(workspaceId);
      writeProjectFile(directory, {
        version: 1,
        setup: "touch running; while [ ! -f finish ]; do sleep 0.05; done",
      });
      const replacement = prepareLocalEnvironment(workspaceId, directory);
      try {
        await vi.waitFor(() => expect(fs.existsSync(path.join(directory, "running"))).toBe(true));
        const before = row();
        const mirror = vi.spyOn(fs, "renameSync");
        try {
          if (outcome === "failure") old.reject(new Error("late"));
          else old.resolve({ configured: true, project: { version: 1, setup: "touch stale" } });
          await first;
          expect(row()).toEqual(before);
          expect(statusFile()).toBe("running\n");
          expect(mirror).not.toHaveBeenCalled();
          expect(fs.existsSync(path.join(directory, "stale"))).toBe(false);
        } finally {
          mirror.mockRestore();
        }
      } finally {
        fs.writeFileSync(path.join(directory, "finish"), "");
        await replacement;
      }
      expect(row().setup_status).toBe("completed");
      expect(statusFile()).toBe("completed\n");
    }
  );

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
  it("reports a missing checkout without falling back or recreating it", async () => {
    mocks.cloud.mockReturnValue({ baseUrl: "https://cloud.test", apiKey: "key" });
    fs.rmSync(root, { recursive: true });
    await expect(readLocalProjectEnvironment(root, "https://github.com/test/app")).rejects.toThrow(
      "Local repository folder not found"
    );
    expect(mocks.saved).not.toHaveBeenCalled();
    expect(() => project({ version: 1 })).toThrow("Local repository folder not found");
    expect(fs.existsSync(root)).toBe(false);
  });
  it("fails on unavailable saved settings and missing required names without exposing values", async () => {
    mocks.cloud.mockReturnValue({ baseUrl: "https://cloud.test", apiKey: "key" });
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
  it.each([1, 2])(
    "keeps the last two non-empty setup lines from fd %i on a failed exit",
    async (fd) => {
      project({
        version: 1,
        setup: `printf 'earlier step\\n  compiling  \\r\\n\\n\\033[31mmissing <tool>\\033[0m\\n    \\n\\033[0m' >&${fd}\nexit 1`,
      });
      const directory = await initialize();
      expect(row()).toMatchObject({
        state: "ready",
        setup_status: "failed",
        error_message: "Setup exited with code 1.",
        error_detail: "compiling\nmissing <tool>",
      });
      expect(statusFile()).toBe("failed 1\n");
      writeProjectFile(directory, { version: 1, setup: "exit 1" });
      await prepareLocalEnvironment(workspaceId, directory);
      expect(row()).toMatchObject({
        setup_status: "failed",
        error_message: "Setup exited with code 1. View the setup log for details.",
        error_detail: null,
      });
    }
  );
  it("clips a complete line within the window without splitting a Unicode character", async () => {
    const suffix = "x".repeat(392) + " failed";
    const output = "x".repeat(600) + "🛠" + suffix;
    project({ version: 1, setup: `printf '%s\\n' '${output}'\nexit 1` });
    await prepareLocalEnvironment(workspaceId, root);
    expect(row().error_detail).toBe(suffix);
    project({ version: 1, setup: "true" });
    await prepareLocalEnvironment(workspaceId, root);
    expect(row()).toMatchObject({
      setup_status: "completed",
      error_message: null,
      error_detail: null,
    });
  });
  it("drops the cut first line of a log window and keeps the complete diagnostic", async () => {
    project({ version: 1, setup: "printf '%05000d\\nMissing compiler' 0\nexit 1" });
    await prepareLocalEnvironment(workspaceId, root);
    expect(row().error_detail).toBe("Missing compiler");
  });
  it("uses the plain sentence for one 16 KB line ending in 6,000 spaces", async () => {
    project({ version: 1, setup: "printf '%010000d failed%6000s' 0 ''\nexit 1" });
    await prepareLocalEnvironment(workspaceId, root);
    expect(row()).toMatchObject({
      error_message: "Setup exited with code 1. View the setup log for details.",
      error_detail: null,
    });
  });
  it("uses the plain sentence when the finished log cannot be read", async () => {
    project({ version: 1, setup: "echo 'Missing compiler'\nexit 1" });
    vi.spyOn(fs.promises, "open").mockRejectedValueOnce(new Error("log was removed"));
    await prepareLocalEnvironment(workspaceId, root);
    expect(row()).toMatchObject({
      error_message: "Setup exited with code 1. View the setup log for details.",
      error_detail: null,
    });
  });
  it.each(["timeout", "archive"])(
    "settles a setup on %s while a detached helper holds its pipes",
    async (end) => {
      project({
        version: 1,
        setup: `printf 'earlier\\ninstalling\\n\\033[31mMissing compiler\\033[0m\\n'
      exec node -e 'const helper = require("node:child_process").spawn("sleep", ["30"], { detached: true, stdio: "inherit" });
        require("node:fs").writeFileSync("helper-pid", String(helper.pid));'`,
      });
      const pidFile = path.join(root, "helper-pid");
      if (end === "timeout") vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const setup = prepareLocalEnvironment(workspaceId, root);
      try {
        await vi.waitFor(() => expect(fs.existsSync(pidFile)).toBe(true));
        expect(row().setup_status).toBe("running");
        expect(statusFile()).toBe("running\n");
        const settled = vi.fn();
        void (end === "archive" ? stopWorkspaceSetup(workspaceId) : setup).then(settled);
        if (end === "timeout") vi.advanceTimersByTime(300_000);
        await vi.waitFor(() => expect(settled).toHaveBeenCalledOnce(), { timeout: 2000 });
        process.kill(Number(fs.readFileSync(pidFile, "utf8")), 0); // The helper still holds both pipes.
        expect(row()).toMatchObject({
          setup_status: "failed",
          error_message:
            end === "timeout"
              ? "Setup timed out after five minutes."
              : "Setup was stopped when the workspace was archived.",
          error_detail: end === "timeout" ? "installing\nMissing compiler" : null,
        });
        expect(statusFile()).toBe("failed\n");
      } finally {
        vi.useRealTimers();
        const stopped = stopWorkspaceSetup(workspaceId);
        if (fs.existsSync(pidFile)) {
          const helper = Number(fs.readFileSync(pidFile, "utf8"));
          process.kill(helper, "SIGKILL");
          await vi.waitFor(() => expect(() => process.kill(helper, 0)).toThrow());
        }
        await stopped;
        await setup;
      }
    }
  );
  it("stops the setup shell and its descendant when the log stream fails", async () => {
    let shellPid: number | undefined;
    let childPid: number | undefined;
    let output = "";
    const log = new Writable({
      write(chunk, _encoding, callback) {
        output += chunk.toString();
        if (!output.includes("\n")) return callback();
        [shellPid, childPid] = output.trim().split(" ").map(Number);
        callback(new Error("setup log failed"));
      },
    });
    vi.spyOn(fs, "createWriteStream").mockReturnValue(log as fs.WriteStream);
    const running = (pid: number) => {
      try {
        const state = execFileSync("ps", ["-o", "stat=", "-p", String(pid)], {
          encoding: "utf8",
        }).trim();
        return state !== "" && !state.startsWith("Z");
      } catch (error) {
        if ((error as { status?: number }).status === 1) return false;
        throw error;
      }
    };
    const stop = (pid: number | undefined) => {
      if (!pid || !running(pid)) return;
      try {
        process.kill(pid, "SIGKILL");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
    };
    try {
      await expect(
        runSetupCommand(
          workspaceId,
          'sleep 30 &\nprintf "%s %s\\n" "$$" "$!"\nwait',
          root,
          process.env
        )
      ).rejects.toThrow("setup log failed");
      expect(shellPid).toBeGreaterThan(1);
      expect(childPid).toBeGreaterThan(1);
      await vi.waitFor(() => expect(running(childPid!)).toBe(false), { timeout: 1000 });
      expect(running(shellPid!)).toBe(false);
    } finally {
      stop(childPid);
      stop(shellPid);
    }
  });
  it("stops a setup that is still running when the backend stops, and starts none after", async () => {
    // Modules of their own: once stopped they stay stopped, as the backend does.
    vi.resetModules();
    const groups = await import("../../../src/lib/process-groups");
    const environment = await import("../../../src/services/project-environment.service");
    const pidFile = path.join(root, "setup-child");
    const setup = environment
      .runSetupCommand(workspaceId, `sleep 30 & echo $! > "${pidFile}"; wait`, root, process.env)
      .catch((error: unknown) => error);
    await vi.waitFor(() => expect(fs.existsSync(pidFile)).toBe(true));
    const child = Number(fs.readFileSync(pidFile, "utf8"));

    groups.stopProcessGroups();

    expect(await setup).toMatchObject({
      message: "Setup was stopped when Deus closed. Run it again.",
    });
    await vi.waitFor(() => expect(() => process.kill(child, 0)).toThrow());
    await expect(
      environment.runSetupCommand(workspaceId, "true", root, process.env)
    ).rejects.toThrow("Deus is closing.");
    // A recipe that resolves after shutdown cannot spawn; its durable status still explains the stop.
    project({ version: 1, setup: "touch unexpected" });
    await environment.prepareLocalEnvironment(workspaceId, root);
    expect(row()).toMatchObject({
      setup_status: "failed",
      error_message: "Setup was stopped when Deus closed. Run it again.",
    });
    expect(statusFile()).toBe("failed\n");
    expect(fs.existsSync(path.join(root, "unexpected"))).toBe(false);
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

describe("workspace folders in the repository's git status", () => {
  const excludeFile = () => path.join(root, ".git", "info", "exclude");
  const readExclude = () =>
    fs.existsSync(excludeFile()) ? fs.readFileSync(excludeFile(), "utf8") : "";

  it("hides them through the local exclude file when nothing ignores .deus", async () => {
    fs.writeFileSync(path.join(root, ".gitignore"), ".env\n.env.local\n");
    await initialize();

    expect(git("status", "--porcelain")).not.toContain(".deus");
    expect(readExclude()).toContain("/.deus/*");
    // The shareable project file stays visible to git.
    expect(() => git("check-ignore", "-q", ".deus/environment.json")).toThrow();
  });

  it("leaves the exclude file alone when the repository already ignores .deus", async () => {
    const before = readExclude();
    await initialize();

    expect(readExclude()).toBe(before);
  });
});
