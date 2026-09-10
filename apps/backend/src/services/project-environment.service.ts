import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn, execFileSync } from "node:child_process";
import { parseEnv } from "node:util";
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
import { getCloudConfig } from "./agent/cloud/config";
import { getCloudEnvironmentInfo } from "./cloud-environment.service";
import { createBackendChildEnv } from "../runtime/child-env";
import { invalidate } from "./query-engine";
import type { WorkspaceWithDetailsRow } from "../db";

function environmentFile(directory: string): string {
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

export function writeProjectFile(directory: string, project: ProjectEnvironment): void {
  const file = environmentFile(directory);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(project, null, 2) + "\n");
  // Older projects ignore all of .deus. Keep workspace data ignored while making
  // this explicit Save to repository action publishable through normal Git.
  let ignored = false;
  try {
    execFileSync("git", ["check-ignore", "-q", PROJECT_ENVIRONMENT_PATH], {
      cwd: directory,
      stdio: "ignore",
    });
    ignored = true;
  } catch {
    /* Not ignored, or not a Git repository. */
  }
  if (ignored)
    fs.appendFileSync(
      path.join(directory, ".gitignore"),
      "\n!/.deus/\n/.deus/*\n!/.deus/environment.json\n"
    );
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
  if (repoUrl && getCloudConfig()) {
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
  const config = getCloudConfig();
  if (!config || !workspace.provider_workspace_id)
    throw new ValidationError("Cloud workspace is not ready.");
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

/** One setup runner for initial preparation and an explicit retry. No implicit installs or Git resets. */
export async function prepareLocalEnvironment(
  workspaceId: string,
  directory: string,
  repoUrl?: string | null
): Promise<void> {
  const db = getDatabase();
  db.prepare(
    "UPDATE workspaces SET setup_status = 'running', error_message = NULL WHERE id = ?"
  ).run(workspaceId);
  invalidate(["workspaces"]);
  try {
    const { project } = await readLocalProjectEnvironment(directory, repoUrl);
    if (!project) {
      db.prepare("UPDATE workspaces SET setup_status = 'none' WHERE id = ?").run(workspaceId);
      return;
    }
    const recipe = resolveProjectEnvironment(project, "local");
    const env = localProjectEnv(project, directory);
    const missing = missingEnvironmentVariables(recipe.requiredEnv, env);
    if (missing.length)
      throw new Error(`Add the missing local environment variables: ${missing.join(", ")}`);
    if (recipe.setup) await runSetupCommand(workspaceId, recipe.setup, directory, env);
    db.prepare(
      "UPDATE workspaces SET setup_status = 'completed', error_message = NULL WHERE id = ?"
    ).run(workspaceId);
  } catch (error) {
    db.prepare("UPDATE workspaces SET setup_status = 'failed', error_message = ? WHERE id = ?").run(
      (error as Error).message,
      workspaceId
    );
  } finally {
    invalidate(["workspaces"]);
  }
}

export function runSetupCommand(
  workspaceId: string,
  command: string,
  directory: string,
  env: NodeJS.ProcessEnv
): Promise<void> {
  return new Promise((resolve, reject) => {
    const log = fs.createWriteStream(path.join(os.tmpdir(), `deus-${workspaceId}-setup.log`));
    const child = spawn("/bin/sh", ["-ec", command], {
      cwd: directory,
      env,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.pipe(log, { end: false });
    child.stderr.pipe(log, { end: false });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      if (child.pid) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          // The process group may already have exited.
        }
      }
    }, 300_000);
    let finished = false;
    const finish = (error?: Error) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (error) {
        log.end();
        reject(error);
      } else log.end(resolve);
    };
    child.once("error", finish);
    log.once("error", (error) => {
      child.kill("SIGKILL");
      finish(error);
    });
    child.once("close", (code) =>
      finish(
        code === 0 && !timedOut
          ? undefined
          : new Error(
              timedOut
                ? "Setup timed out after five minutes."
                : `Setup exited with code ${code}. View the setup log for details.`
            )
      )
    );
  });
}
