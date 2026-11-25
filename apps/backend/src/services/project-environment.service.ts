import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { finished } from "node:stream/promises";
import { parseEnv, stripVTControlCharacters } from "node:util";
import {
  parseProjectEnvironment,
  PROJECT_ENVIRONMENT_PATH,
  resolveProjectEnvironment,
  missingEnvironmentVariables,
  type ProjectEnvironment,
  type EnvironmentTarget,
} from "@deus-hq/api";
import { getWorkspace } from "@deus-hq/sdk";
import type { ProjectEnvironmentResponse } from "@shared/types/project-environment";
import { getDatabase } from "../lib/database";
import { ValidationError } from "../lib/errors";
import { processGroupsStopped, trackProcessGroup } from "@shared/lib/process-groups";
import { runGit } from "@shared/lib/git-process";
import { cloudAccount, cloudOrg, requireCloudOrg } from "./agent/cloud/config";
import { getCloudEnvironmentInfo } from "./cloud-environment.service";
import { createBackendChildEnv } from "@shared/lib/child-env";
import { SETUP_INTERRUPTED, SETUP_LOG_SUFFIX, setupFile } from "./setup-status";
import { setSetupStatus } from "./workspace-lifecycle";
import type { WorkspaceSetup } from "./agent/workspace-context";
import type { WorkspaceWithDetailsRow } from "../db";

function environmentFile(directory: string): string {
  if (!fs.statSync(directory, { throwIfNoEntry: false })?.isDirectory()) {
    throw new ValidationError(
      `Local repository folder not found: ${directory}. Restore it or add the repository from its new location.`
    );
  }
  const file = path.join(directory, PROJECT_ENVIRONMENT_PATH);
  for (const candidate of [path.dirname(file), file]) {
    try {
      if (fs.lstatSync(candidate).isSymbolicLink())
        throw new ValidationError(
          "Environment configuration must be a regular file in this checkout, not a symbolic link."
        );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return file;
}

export function readProjectFile(directory: string): ProjectEnvironment | null {
  try {
    return parseProjectEnvironment(fs.readFileSync(environmentFile(directory), "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new ValidationError((error as Error).message);
  }
}

const updatingIgnore = new Map<string, Promise<void>>();

export async function writeProjectFile(
  directory: string,
  project: ProjectEnvironment
): Promise<void> {
  const file = environmentFile(directory);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(project, null, 2) + "\n");
  // Saves to a project that ignores .deus share one check and one .gitignore edit.
  const pending = updatingIgnore.get(file);
  if (pending) return pending;
  const update = runGit(["check-ignore", "-q", PROJECT_ENVIRONMENT_PATH], { cwd: directory })
    .then(
      () =>
        fs.appendFileSync(
          path.join(directory, ".gitignore"),
          `\n!/.deus/\n/.deus/*\n!/${PROJECT_ENVIRONMENT_PATH}\n`
        ),
      () => {} // The recipe isn't ignored, or git couldn't inspect this folder.
    )
    .finally(() => updatingIgnore.delete(file));
  updatingIgnore.set(file, update);
  return update;
}

export function projectEnvironmentResponse(
  project: ProjectEnvironment | null,
  source: ProjectEnvironmentResponse["source"],
  target: EnvironmentTarget
): ProjectEnvironmentResponse {
  const resolved = project && resolveProjectEnvironment(project, target);
  return {
    project,
    source,
    tasks: resolved
      ? [
          // Cloud Run is already supervised by AGNT; this menu must not start a duplicate.
          ...(target === "local" && resolved.run ? [{ name: "run", command: resolved.run }] : []),
          ...Object.entries(resolved.tasks).map(([name, command]) => ({ name, command })),
        ]
      : [],
  };
}

export async function readLocalProjectEnvironment(
  directory: string,
  repoUrl?: string | null
): Promise<ProjectEnvironmentResponse> {
  const file = readProjectFile(directory);
  if (file) return projectEnvironmentResponse(file, "repository", "local");
  // A local workspace's saved cloud recipe is the default organization's.
  if (repoUrl && cloudOrg()) {
    const saved = await getCloudEnvironmentInfo(repoUrl);
    if (saved.lookupFailed)
      throw new ValidationError(
        "Couldn't load saved project settings. Check your cloud connection and retry setup."
      );
    if (saved.project) return projectEnvironmentResponse(saved.project, "settings", "local");
  }
  return projectEnvironmentResponse(null, "unconfigured", "local");
}

/** Cloud processes keep the recipe applied during preparation, including across pause/resume. */
export async function readWorkspaceEnvironment(
  workspace: WorkspaceWithDetailsRow,
  directory: string
): Promise<ProjectEnvironmentResponse> {
  if (workspace.kind !== "cloud")
    return readLocalProjectEnvironment(directory, workspace.git_origin_url);
  if (!cloudAccount() || !workspace.provider_workspace_id)
    throw new ValidationError("Cloud workspace is not ready.");
  const config = requireCloudOrg(workspace.organization_id);
  const remote = await getWorkspace(workspace.provider_workspace_id, {
    baseUrl: config.baseUrl,
    apiKey: config.apiKey,
  });
  const applied = remote.config?.appliedProject as
    | { recipe: ProjectEnvironment; source: "repository" | "settings" }
    | undefined;
  return projectEnvironmentResponse(
    applied?.recipe ?? null,
    applied?.source ?? "unconfigured",
    "cloud"
  );
}

/** Local env files stay local. Cloud credentials are never downloaded by this path. */
export function localProjectEnv(project: ProjectEnvironment, directory: string): NodeJS.ProcessEnv {
  const env = createBackendChildEnv(resolveProjectEnvironment(project, "local").env);
  for (const name of [".env", ".env.local"]) {
    try {
      Object.assign(env, parseEnv(fs.readFileSync(path.join(directory, name), "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return env;
}

interface SetupRun {
  controller: AbortController;
  command?: string;
  process?: Promise<void>;
}
const runs = new Map<string, SetupRun>();

export function setupForTurn(sessionId: string): WorkspaceSetup | null {
  const row = getDatabase()
    .prepare<
      [string],
      Pick<WorkspaceWithDetailsRow, "id" | "setup_status" | "error_message" | "error_detail">
    >(
      `SELECT w.id, w.setup_status, w.error_message, w.error_detail
    FROM sessions s JOIN workspaces w ON w.id = s.workspace_id
    WHERE s.id = ? AND w.kind = 'worktree' AND w.setup_status IN ('running', 'failed')`
    )
    .get(sessionId);
  if (!row) return null;
  if (row.setup_status === "running") {
    return {
      state: "running",
      command: runs.get(row.id)?.command,
      log: setupFile(row.id, "log"),
      statusFile: setupFile(row.id, "status"),
    };
  }
  const reason = row.error_message ?? "The setup did not finish.";
  return {
    state: "failed",
    reason: reason.endsWith(SETUP_LOG_SUFFIX) ? reason.slice(0, -SETUP_LOG_SUFFIX.length) : reason,
    detail: row.error_detail,
  };
}

export async function stopWorkspaceSetup(workspaceId: string): Promise<void> {
  const run = runs.get(workspaceId);
  if (!run) return;
  const reason = new Error("Setup was stopped when the workspace was archived.");
  run.controller.abort(reason);
  runs.delete(workspaceId);
  setSetupStatus(workspaceId, "failed", reason);
  await run.process?.catch(() => {});
}

/** One setup runner for initial preparation and an explicit retry. No implicit installs or Git resets. */
export async function prepareLocalEnvironment(
  workspaceId: string,
  directory: string,
  repoUrl?: string | null
): Promise<void> {
  if (runs.has(workspaceId)) return;
  const run: SetupRun = { controller: new AbortController() };
  runs.set(workspaceId, run);
  const { signal } = run.controller;
  const current = () => runs.get(workspaceId) === run;
  try {
    setSetupStatus(workspaceId, "running");
    const { project } = await readLocalProjectEnvironment(directory, repoUrl);
    signal.throwIfAborted();
    if (project) {
      const recipe = resolveProjectEnvironment(project, "local");
      const env = localProjectEnv(project, directory);
      const missing = missingEnvironmentVariables(recipe.requiredEnv, env);
      if (missing.length)
        throw new Error(`Add the missing local environment variables: ${missing.join(", ")}`);
      if (recipe.setup) {
        run.command = recipe.setup;
        run.process = runSetupCommand(workspaceId, recipe.setup, directory, env, signal);
        await run.process;
      }
    }
    if (current()) setSetupStatus(workspaceId, run.command ? "completed" : "none");
  } catch (error) {
    if (current()) {
      // Release the failed run before publishing so Run again can take its place.
      runs.delete(workspaceId);
      setSetupStatus(
        workspaceId,
        "failed",
        processGroupsStopped() ? { message: SETUP_INTERRUPTED } : (error as Error)
      );
    }
  } finally {
    if (current()) runs.delete(workspaceId);
  }
}

async function setupLogTail(logPath: string): Promise<string | null> {
  const file = await fs.promises.open(logPath, "r");
  try {
    const { size } = await file.stat();
    const buffer = Buffer.alloc(Math.min(size, 4096));
    const start = size - buffer.length;
    const { bytesRead } = await file.read(buffer, 0, buffer.length, start);
    const lines = stripVTControlCharacters(buffer.toString("utf8", 0, bytesRead)).split(/[\r\n]/);
    if (start > 0) lines.shift(); // The first line may start before the window.
    const nonempty = lines.map((line) => line.trim()).filter(Boolean);
    const tail = nonempty.slice(-2).join("\n").slice(-400);
    return tail.replace(/^\p{Surrogate}/u, "") || null;
  } finally {
    await file.close();
  }
}

export async function runSetupCommand(
  workspaceId: string,
  command: string,
  directory: string,
  env: NodeJS.ProcessEnv,
  signal?: AbortSignal
): Promise<void> {
  if (processGroupsStopped()) throw new Error("Deus is closing.");
  const logPath = setupFile(workspaceId, "log");
  type SetupExit = number | null | "timeout";
  const result = await new Promise<SetupExit>((resolve, reject) => {
    const log = fs.createWriteStream(logPath);
    const child = spawn("/bin/sh", ["-ec", command], {
      cwd: directory,
      env,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    // The backend stops the setup script's whole group when it quits (shared/lib/process-groups).
    const untrack = trackProcessGroup(child.pid);
    child.stdout.pipe(log, { end: false });
    child.stderr.pipe(log, { end: false });
    let drain: NodeJS.Timeout | undefined;
    const killProcessGroup = () => {
      if (child.pid) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          // The process group may already have exited.
        }
      }
      // A helper in another process group can keep the pipes open after the shell exits.
      drain ??= setTimeout(() => {
        child.stdout.destroy();
        child.stderr.destroy();
      }, 250);
    };
    signal?.addEventListener("abort", killProcessGroup, { once: true });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killProcessGroup();
    }, 300_000);
    let settled = false;
    const finish = (result: Error | SetupExit) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", killProcessGroup);
      untrack();
      clearTimeout(timer);
      if (result instanceof Error) reject(result);
      else resolve(finished(log).then(() => result));
      log.end();
    };
    child.once("error", finish);
    log.once("error", (error) => {
      killProcessGroup();
      finish(error);
    });
    child.once("close", (code) => {
      clearTimeout(drain);
      if (signal?.aborted) return finish(signal.reason);
      if (processGroupsStopped()) return finish(new Error(SETUP_INTERRUPTED));
      finish(timedOut ? "timeout" : code);
    });
  });
  if (result !== 0) {
    const detail = result === null ? null : await setupLogTail(logPath).catch(() => null);
    const message =
      result === "timeout"
        ? "Setup timed out after five minutes."
        : `Setup exited with code ${result}.${detail ? "" : SETUP_LOG_SUFFIX}`;
    throw Object.assign(new Error(message), {
      detail,
      exitCode: typeof result === "number" ? result : null,
    });
  }
}
