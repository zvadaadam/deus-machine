import fs from "fs";
import path from "path";
import os from "os";
import { spawn } from "child_process";
import type BetterSqlite3 from "better-sqlite3";
import { DeusManifestSchema, type DeusManifest, type NormalizedTask } from "../lib/deus-manifest";
import { detectPackageManager, getRunPrefix } from "../lib/package-manager";
import { emitProgress } from "./workspace-init.service";

/**
 * Read and normalize deus.json manifests.
 *
 * Follows the config.service.ts pattern: readFileSync -> JSON.parse -> safeParse -> null on error.
 * Never throws — callers check for null.
 */

export function readManifest(dirPath: string): DeusManifest | null {
  try {
    const manifestPath = path.join(dirPath, "deus.json");
    if (!fs.existsSync(manifestPath)) return null;

    const raw = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    const parsed = DeusManifestSchema.safeParse(raw);
    if (!parsed.success) {
      console.error("[MANIFEST] Invalid deus.json:", parsed.error.issues);
      return null;
    }
    return parsed.data;
  } catch (error) {
    console.error("[MANIFEST] Error reading deus.json:", error);
    return null;
  }
}

/** lifecycle.setup takes precedence over legacy scripts.setup */
export function getSetupCommand(manifest: DeusManifest): string | null {
  return manifest.lifecycle?.setup ?? manifest.scripts?.setup ?? null;
}

/** lifecycle.archive takes precedence over legacy scripts.archive */
export function getArchiveCommand(manifest: DeusManifest): string | null {
  return manifest.lifecycle?.archive ?? manifest.scripts?.archive ?? null;
}

/** Normalize task entries: string shorthand → full object form */
export function getNormalizedTasks(manifest: DeusManifest): NormalizedTask[] {
  if (!manifest.tasks) return [];

  return Object.entries(manifest.tasks).map(([name, entry]) => {
    if (typeof entry === "string") {
      return {
        name,
        command: entry,
        description: null,
        icon: "terminal",
        persistent: false,
        mode: "concurrent" as const,
        depends: [],
        env: {},
      };
    }
    return {
      name,
      command: entry.command,
      description: entry.description ?? null,
      icon: entry.icon ?? "terminal",
      persistent: entry.persistent ?? false,
      mode: entry.mode ?? "concurrent",
      depends: entry.depends ?? [],
      env: entry.env ?? {},
    };
  });
}

/** Build environment variables for script execution */
export function getDeusEnv(
  manifest: DeusManifest,
  ctx: { id: string; rootPath: string; workspacePath: string }
): Record<string, string> {
  return {
    ...(manifest.env ?? {}),
    DEUS_ROOT_PATH: ctx.rootPath,
    DEUS_WORKSPACE_PATH: ctx.workspacePath,
    DEUS_WORKSPACE_ID: ctx.id,
  };
}

/**
 * Dangerous shell metacharacters that indicate command injection.
 * We allow simple commands like `bun install` or `npm run build` but reject
 * anything that chains, pipes, substitutes, or redirects — these have no
 * legitimate use in a deus.json lifecycle/setup command.
 */
const DANGEROUS_SHELL_PATTERN = /[;|&`$><\n]|\$\(|\)\s*\{/;

/**
 * Validate a manifest command string for dangerous shell metacharacters.
 * Returns true if the command is safe to execute, false otherwise.
 *
 * Rejects: ; && || | $() `` > < \n and other shell injection vectors.
 * Allows: simple commands with flags and arguments (e.g. "bun install", "cargo build --release").
 */
export function isManifestCommandSafe(cmd: string): boolean {
  return !DANGEROUS_SHELL_PATTERN.test(cmd);
}

/**
 * Read manifest with repo-root fallback.
 * Workspace worktrees may not have deus.json if it was added after creation.
 * Checks the worktree first (agent may have modified it), then falls back to repo root.
 */
export function readManifestWithFallback(
  workspacePath: string,
  repoRootPath: string
): DeusManifest | null {
  return readManifest(workspacePath) ?? readManifest(repoRootPath);
}

/** Write a manifest object to deus.json */
export function writeManifest(dirPath: string, manifest: DeusManifest): boolean {
  try {
    const manifestPath = path.join(dirPath, "deus.json");
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
    return true;
  } catch (error) {
    console.error("[MANIFEST] Error writing deus.json:", error);
    return false;
  }
}

/**
 * Scan a project directory and generate a suggested deus.json manifest.
 * Reads package.json, Cargo.toml, Makefile, etc. to infer scripts and tasks.
 */
export function detectManifestFromProject(
  rootPath: string,
  repoName: string
): Record<string, unknown> {
  const manifest: Record<string, unknown> = { version: 1, name: repoName };
  const tasks: Record<string, unknown> = {};
  const requires: Record<string, string> = {};

  // Detect Node.js / Bun project
  const pkgJsonPath = path.join(rootPath, "package.json");
  if (fs.existsSync(pkgJsonPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, "utf-8"));
      const pm = detectPackageManager(rootPath) ?? "npm";
      const run = getRunPrefix(pm);

      requires[pm] = ">= 1.0";
      if (pm !== "bun") requires.node = ">= 18";

      manifest.scripts = { setup: `${pm} install` };
      manifest.lifecycle = { setup: `${pm} install` };

      const scripts = pkg.scripts || {};
      if (scripts.dev)
        tasks.dev = {
          command: `${run} dev`,
          description: "Start dev server",
          icon: "play",
          persistent: true,
        };
      if (scripts.build)
        tasks.build = {
          command: `${run} build`,
          description: "Build for production",
          icon: "hammer",
        };
      if (scripts.test)
        tasks.test = { command: `${run} test`, description: "Run tests", icon: "check-circle" };
      if (scripts.lint)
        tasks.lint = { command: `${run} lint`, description: "Lint code", icon: "search-code" };
      if (scripts.format)
        tasks.format = { command: `${run} format`, description: "Format code", icon: "paintbrush" };
      if (scripts.typecheck)
        tasks.typecheck = {
          command: `${run} typecheck`,
          description: "Type check",
          icon: "search-code",
        };
      if (scripts.start)
        tasks.start = {
          command: `${run} start`,
          description: "Start production server",
          icon: "rocket",
          persistent: true,
        };
    } catch {
      /* invalid package.json — skip */
    }
  }

  // Detect Rust project
  const cargoPath = path.join(rootPath, "Cargo.toml");
  if (fs.existsSync(cargoPath)) {
    requires.cargo = ">= 1.0";
    if (!manifest.scripts) manifest.scripts = { setup: "cargo build" };
    if (!manifest.lifecycle) manifest.lifecycle = { setup: "cargo build" };
    if (!tasks.build)
      tasks.build = {
        command: "cargo build --release",
        description: "Build release",
        icon: "hammer",
      };
    if (!tasks.test)
      tasks.test = { command: "cargo test", description: "Run tests", icon: "check-circle" };
    tasks.clippy = {
      command: "cargo clippy",
      description: "Lint with Clippy",
      icon: "search-code",
    };
  }

  // Detect Python project
  const pyprojectPath = path.join(rootPath, "pyproject.toml");
  const requirementsPath = path.join(rootPath, "requirements.txt");
  if (fs.existsSync(pyprojectPath) || fs.existsSync(requirementsPath)) {
    requires.python = ">= 3.10";
    const hasUv = fs.existsSync(path.join(rootPath, "uv.lock"));
    const pip = hasUv ? "uv pip" : "pip";
    if (!manifest.scripts)
      manifest.scripts = {
        setup: fs.existsSync(requirementsPath)
          ? `${pip} install -r requirements.txt`
          : `${pip} install -e .`,
      };
    if (!manifest.lifecycle)
      manifest.lifecycle = {
        setup: fs.existsSync(requirementsPath)
          ? `${pip} install -r requirements.txt`
          : `${pip} install -e .`,
      };
    if (!tasks.test)
      tasks.test = { command: "pytest", description: "Run tests", icon: "check-circle" };
  }

  // Detect Makefile
  const makefilePath = path.join(rootPath, "Makefile");
  if (fs.existsSync(makefilePath)) {
    try {
      const content = fs.readFileSync(makefilePath, "utf-8");
      const targets = content.match(/^([a-zA-Z_-]+)\s*:/gm);
      if (targets) {
        for (const match of targets.slice(0, 8)) {
          // Cap at 8 tasks
          const target = match.replace(":", "").trim();
          if (["all", ".PHONY", ".DEFAULT"].includes(target)) continue;
          if (tasks[target]) continue; // Don't overwrite more specific detections
          tasks[target] = `make ${target}`;
        }
      }
    } catch {
      /* unreadable Makefile — skip */
    }
  }

  if (Object.keys(requires).length > 0) manifest.requires = requires;
  if (Object.keys(tasks).length > 0) manifest.tasks = tasks;

  return manifest;
}

export function runSetupScript(
  db: BetterSqlite3.Database,
  workspaceId: string,
  setupCmd: string,
  setupEnv: Record<string, string>,
  workspacePath: string
): void {
  if (!isManifestCommandSafe(setupCmd)) {
    console.warn(
      `[MANIFEST] Rejected unsafe setup command for workspace ${workspaceId}: ${setupCmd}`
    );
    db.prepare(
      "UPDATE workspaces SET setup_status = 'failed', error_message = ?, updated_at = datetime('now') WHERE id = ?"
    ).run("Setup command rejected: contains dangerous shell metacharacters", workspaceId);
    emitProgress(workspaceId, "setup_failed", "Setup failed: command rejected for safety");
    return;
  }

  const setupLogPath = path.join(os.tmpdir(), `deus-${workspaceId}-setup.log`);
  const setupLog = fs.createWriteStream(setupLogPath);

  const setupProc = spawn("sh", ["-c", setupCmd], {
    cwd: workspacePath,
    env: { ...process.env, ...setupEnv },
    stdio: ["ignore", "pipe", "pipe"],
  });
  setupProc.stdout.pipe(setupLog);
  setupProc.stderr.pipe(setupLog);

  let forceKillTimer: ReturnType<typeof setTimeout> | null = null;
  const timer = setTimeout(
    () => {
      setupProc.kill("SIGTERM");
      forceKillTimer = setTimeout(() => {
        try {
          setupProc.kill("SIGKILL");
        } catch {}
      }, 5000);
    },
    5 * 60 * 1000
  );

  let finished = false;
  const finish = (status: "completed" | "failed", error?: string) => {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    if (forceKillTimer) {
      clearTimeout(forceKillTimer);
      forceKillTimer = null;
    }
    try {
      setupLog.end();
    } catch {}
    if (status === "completed") {
      db.prepare(
        "UPDATE workspaces SET setup_status = 'completed', error_message = NULL, updated_at = datetime('now') WHERE id = ?"
      ).run(workspaceId);
    } else {
      db.prepare(
        "UPDATE workspaces SET setup_status = 'failed', error_message = ?, updated_at = datetime('now') WHERE id = ?"
      ).run(error, workspaceId);
    }
    // Emit progress event so frontend clears diff caches and re-fetches clean data.
    // Uses the same DEUS_WORKSPACE_PROGRESS protocol that initializeWorkspace() uses
    // (Electron's backend-process.ts parses the prefix → IPC event → useWorkspaceInitEvents hook).
    const step = status === "completed" ? "setup_done" : "setup_failed";
    const label = status === "completed" ? "Setup complete" : `Setup failed: ${error ?? "unknown"}`;
    emitProgress(workspaceId, step, label);
  };

  setupProc.on("close", (code) => {
    if (code === 0) finish("completed");
    else finish("failed", `Setup exited with code ${code}`);
  });

  setupProc.on("error", (err) => {
    finish("failed", `Setup spawn error: ${err.message}`);
  });
}
