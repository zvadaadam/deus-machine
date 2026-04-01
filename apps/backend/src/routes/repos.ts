import { Hono } from "hono";
import path from "path";
import fs from "fs";
import os from "os";
import { spawn, execFile, execFileSync } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);
import { uuidv7 } from "@shared/lib/uuid";
import { getDatabase } from "../lib/database";
import { AppError, ValidationError, ConflictError, NotFoundError } from "../lib/errors";
import { parseBody, CreateRepoBody, InitProjectBody } from "../lib/schemas";
import { detectDefaultBranch } from "../services/git.service";
import {
  getAllRepositories,
  getRepositoryByRootPath,
  getRepositoryById,
  getMaxRepositorySortOrder,
} from "../db";
import {
  readManifest,
  getNormalizedTasks,
  writeManifest,
  detectManifestFromProject,
} from "../services/manifest.service";
import { DeusManifestSchema } from "../lib/deus-manifest";
import { invalidate } from "../services/query-engine";
import { runGh, parseGitHubRepo } from "../services/gh.service";
import { broadcast } from "../services/ws.service";
import type { QueryResource } from "@shared/types/query-protocol";

const app = new Hono();

app.get("/repos", (c) => {
  const db = getDatabase();
  return c.json(getAllRepositories(db));
});

/** Global git + GitHub identity — used by the "Start New Project" modal. */
app.get("/git/user", async (c) => {
  let name: string | null = null;
  let email: string | null = null;
  let githubUsername: string | null = null;
  try {
    const { stdout } = await execFileAsync("git", ["config", "--global", "user.name"], {
      encoding: "utf-8",
      timeout: 2000,
    });
    name = stdout.trim() || null;
  } catch {
    /* not configured */
  }
  try {
    const { stdout } = await execFileAsync("git", ["config", "--global", "user.email"], {
      encoding: "utf-8",
      timeout: 2000,
    });
    email = stdout.trim() || null;
  } catch {
    /* not configured */
  }
  // Try to get GitHub username via gh CLI (non-blocking, cosmetic only)
  try {
    const result = await runGh(["api", "user", "--jq", ".login"], {
      cwd: os.homedir(),
      timeoutMs: 3000,
    });
    if (result.success && result.stdout?.trim()) {
      githubUsername = result.stdout.trim();
    }
  } catch {
    /* gh not installed or not authenticated */
  }
  return c.json({ name, email, githubUsername });
});

app.post("/repos", async (c) => {
  const db = getDatabase();
  let { root_path } = parseBody(CreateRepoBody, await c.req.json());

  // Normalize path
  try {
    root_path = fs.realpathSync(root_path);
  } catch {
    throw new ValidationError("Path does not exist or is inaccessible");
  }

  // Verify permissions
  try {
    fs.accessSync(root_path, fs.constants.R_OK | fs.constants.X_OK);
  } catch {
    throw new AppError(403, "Path is not accessible (permission denied)");
  }

  const stats = fs.statSync(root_path);
  if (!stats.isDirectory()) throw new ValidationError("Path is not a directory");

  // Check git repo and resolve to repo root
  try {
    root_path = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd: root_path,
      timeout: 2000,
    })
      .toString()
      .trim();
  } catch {
    throw new ValidationError("Path is not a git repository");
  }

  const repoName = path.basename(root_path);
  const defaultBranch = detectDefaultBranch(root_path);

  // Resolve origin URL (non-fatal — repos without remotes should still work)
  let gitOriginUrl: string | null = null;
  try {
    gitOriginUrl =
      execFileSync("git", ["remote", "get-url", "origin"], {
        cwd: root_path,
        encoding: "utf-8",
        timeout: 2000,
      }).trim() || null;
  } catch {
    // No origin remote — that's fine
  }

  const insertRepo = db.transaction(
    (
      root_path: string,
      repoId: string,
      repoName: string,
      defaultBranch: string,
      originUrl: string | null
    ) => {
      const existing = getRepositoryByRootPath(db, root_path);
      if (existing) throw new ConflictError("Repository already exists", existing);

      const sortOrder = getMaxRepositorySortOrder(db) + 1;

      db.prepare(
        `
      INSERT INTO repositories (id, name, root_path, git_default_branch, sort_order, git_origin_url)
      VALUES (?, ?, ?, ?, ?, ?)
    `
      ).run(repoId, repoName, root_path, defaultBranch, sortOrder, originUrl);

      return getRepositoryById(db, repoId);
    }
  );

  const repoId = uuidv7();
  const repo = insertRepo(root_path, repoId, repoName, defaultBranch, gitOriginUrl);
  invalidate(["stats"] as QueryResource[]);
  return c.json(repo, 201);
});

// ─── Clone Endpoint ──────────────────────────────────────────

/** Broadcast a raw git stderr line to all connected WS clients. */
function pushCloneLine(line: string): void {
  broadcast(JSON.stringify({ type: "q:event", event: "git-clone-progress", data: { line } }));
}

app.post("/repos/clone", async (c) => {
  const body = await c.req.json();
  const { url, targetPath } = body as { url: string; targetPath: string };

  if (!url || typeof url !== "string") {
    throw new ValidationError("Missing or invalid 'url' parameter");
  }

  const SAFE_GIT_URL_PATTERN = /^https?:\/\/[^\s;|&`$()]+$/;
  if (!SAFE_GIT_URL_PATTERN.test(url)) {
    throw new ValidationError("Invalid repository URL format");
  }

  if (!targetPath || typeof targetPath !== "string") {
    throw new ValidationError("Missing or invalid 'targetPath' parameter");
  }

  // Path traversal guard — reject paths that escape the user's home directory
  const resolvedPath = path.resolve(targetPath);
  const homeDir = os.homedir();
  if (!resolvedPath.startsWith(homeDir + path.sep) && resolvedPath !== homeDir) {
    throw new ValidationError("Target path must be within the home directory");
  }

  // Ensure parent directory exists
  const parentDir = path.dirname(resolvedPath);
  try {
    fs.mkdirSync(parentDir, { recursive: true });
  } catch (err) {
    throw new AppError(500, `Cannot create parent directory: ${(err as Error).message}`);
  }

  // Check target doesn't already exist
  if (fs.existsSync(resolvedPath)) {
    throw new ConflictError("Target directory already exists");
  }

  // Run git clone with progress, forward raw stderr lines to frontend
  return new Promise<Response>((resolve) => {
    const proc = spawn("git", ["clone", "--progress", url, resolvedPath], {
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 300_000, // 5 minute timeout
    });

    let stderrBuffer = "";

    proc.stderr?.on("data", (chunk: Buffer) => {
      stderrBuffer += chunk.toString();
      // Git progress uses \r for in-place updates within a phase
      const lines = stderrBuffer.split(/[\r\n]+/);
      stderrBuffer = lines.pop() || "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed) pushCloneLine(trimmed);
      }
    });

    proc.on("close", (code) => {
      // Flush remaining buffer
      const remaining = stderrBuffer.trim();
      if (remaining) pushCloneLine(remaining);

      if (code === 0) {
        pushCloneLine("Clone complete.");
        resolve(c.json({ success: true, path: resolvedPath }));
      } else {
        resolve(c.json({ error: remaining || `git clone exited with code ${code}` }, 500));
      }
    });

    proc.on("error", (err) => {
      resolve(c.json({ error: `Failed to start git: ${err.message}` }, 500));
    });
  });
});

// ─── Init (create new project) Endpoint ──────────────────────

/** Broadcast a git init progress line to all connected WS clients. */
function pushInitLine(line: string): void {
  broadcast(JSON.stringify({ type: "q:event", event: "git-init-progress", data: { line } }));
}

app.post("/repos/init", async (c) => {
  const { projectName, targetPath, template } = parseBody(InitProjectBody, await c.req.json());

  // Path validation — same guards as clone endpoint
  const resolvedPath = path.resolve(targetPath);
  const homeDir = os.homedir();
  if (!resolvedPath.startsWith(homeDir + path.sep) && resolvedPath !== homeDir) {
    throw new ValidationError("Target path must be within the home directory");
  }

  // Ensure parent exists, target does NOT exist
  const parentDir = path.dirname(resolvedPath);
  try {
    fs.mkdirSync(parentDir, { recursive: true });
  } catch (err) {
    throw new AppError(500, `Cannot create parent directory: ${(err as Error).message}`);
  }
  if (fs.existsSync(resolvedPath)) {
    throw new ConflictError("Target directory already exists");
  }

  const templateType = template?.type || "empty";

  if (templateType === "github" && template?.url) {
    // Clone template repo, strip .git, re-init
    pushInitLine("Downloading template...");
    await new Promise<void>((resolve, reject) => {
      const proc = spawn("git", ["clone", "--depth", "1", template.url, resolvedPath], {
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 120_000,
      });

      let stderrBuffer = "";
      proc.stderr?.on("data", (chunk: Buffer) => {
        stderrBuffer += chunk.toString();
        const lines = stderrBuffer.split(/[\r\n]+/);
        stderrBuffer = lines.pop() || "";
        for (const line of lines) {
          const trimmed = line.trim();
          if (trimmed) pushInitLine(trimmed);
        }
      });

      proc.on("close", (code) => {
        const remaining = stderrBuffer.trim();
        if (remaining) pushInitLine(remaining);
        if (code === 0) resolve();
        else reject(new Error(remaining || `git clone exited with code ${code}`));
      });

      proc.on("error", (err) => reject(err));
    });

    // Strip template's .git and re-init as a fresh repo
    pushInitLine("Initializing as new project...");
    fs.rmSync(path.join(resolvedPath, ".git"), { recursive: true, force: true });
    await execFileAsync("git", ["init"], { cwd: resolvedPath, timeout: 5000 });
  } else {
    // Empty project
    pushInitLine("Creating project directory...");
    fs.mkdirSync(resolvedPath, { recursive: true });

    pushInitLine("Initializing git repository...");
    await execFileAsync("git", ["init"], { cwd: resolvedPath, timeout: 5000 });

    // Create README
    fs.writeFileSync(path.join(resolvedPath, "README.md"), `# ${projectName}\n`);
  }

  // Initial commit
  pushInitLine("Creating initial commit...");
  await execFileAsync("git", ["add", "."], { cwd: resolvedPath, timeout: 5000 });
  await execFileAsync("git", ["commit", "-m", "Initial commit"], {
    cwd: resolvedPath,
    timeout: 5000,
  });

  // Create GitHub repo (non-fatal — works without gh CLI or auth)
  // Step 1: create the repo (without --push to avoid partial-failure losing the URL)
  // Step 2: push separately (tolerates GitHub propagation delays)
  let githubUrl: string | null = null;
  try {
    pushInitLine("Creating GitHub repository...");
    const ghResult = await runGh(
      ["repo", "create", projectName, "--private", "--source", resolvedPath, "--remote", "origin"],
      { cwd: resolvedPath, timeoutMs: 30_000 }
    );
    if (ghResult.success && ghResult.stdout) {
      const urlMatch = ghResult.stdout.match(/https:\/\/github\.com\/[^\s]+/);
      if (urlMatch) {
        githubUrl = urlMatch[0];
        pushInitLine(`GitHub repository created: ${githubUrl}`);
      }
    } else if (!ghResult.success) {
      console.warn("[repos/init] gh repo create failed:", ghResult.error, ghResult.message);
      pushInitLine(`GitHub: ${ghResult.message || ghResult.error}`);
    }

    // Push initial commit (best-effort — repo link is valid even if push fails)
    if (githubUrl) {
      try {
        pushInitLine("Pushing initial commit...");
        await execFileAsync("git", ["push", "-u", "origin", "HEAD"], {
          cwd: resolvedPath,
          timeout: 15_000,
        });
      } catch (pushErr) {
        console.warn("[repos/init] git push failed (repo still created):", pushErr);
        pushInitLine("Push failed — you can push manually later.");
      }
    }
  } catch (err) {
    console.warn("[repos/init] gh repo create error:", err);
    pushInitLine("Skipped GitHub — repository created locally.");
  }

  pushInitLine("Project created successfully.");
  return c.json({ success: true, path: resolvedPath, githubUrl });
});

// ─── Manifest Endpoints (per-repo, settings UI) ─────────────

// Read manifest from repo root
app.get("/repos/:id/manifest", (c) => {
  const db = getDatabase();
  const repo = getRepositoryById(db, c.req.param("id"));
  if (!repo) throw new NotFoundError("Repository not found");

  const manifest = readManifest(repo.root_path);
  if (!manifest) return c.json({ manifest: null, tasks: [] });
  const tasks = getNormalizedTasks(manifest);
  return c.json({ manifest, tasks });
});

// Write manifest to repo root
app.post("/repos/:id/manifest", async (c) => {
  const db = getDatabase();
  const repo = getRepositoryById(db, c.req.param("id"));
  if (!repo) throw new NotFoundError("Repository not found");

  const manifest = parseBody(DeusManifestSchema, await c.req.json());
  const success = writeManifest(repo.root_path, manifest);
  if (!success) return c.json({ error: "Failed to write manifest" }, 500);
  return c.json({ success: true });
});

// Auto-detect manifest from project files (package.json, Cargo.toml, etc.)
app.get("/repos/:id/detect-manifest", (c) => {
  const db = getDatabase();
  const repo = getRepositoryById(db, c.req.param("id"));
  if (!repo) throw new NotFoundError("Repository not found");

  const manifest = detectManifestFromProject(repo.root_path, repo.name);
  return c.json({ manifest });
});

// ─── PR and Branch List Endpoints ─────────────────────────────

app.get("/repos/:id/prs", async (c) => {
  const db = getDatabase();
  const repo = getRepositoryById(db, c.req.param("id"));
  if (!repo) throw new NotFoundError("Repository not found");

  // Resolve origin URL (prefer stored value, fall back to git)
  let originUrl: string | null = repo.git_origin_url;
  if (!originUrl) {
    try {
      originUrl =
        execFileSync("git", ["remote", "get-url", "origin"], {
          cwd: repo.root_path,
          encoding: "utf-8",
          timeout: 2000,
        }).trim() || null;
    } catch {
      // No origin remote
    }
  }

  if (!originUrl) return c.json([]);

  const nwo = parseGitHubRepo(originUrl);
  if (!nwo) return c.json([]);

  const result = await runGh(
    [
      "pr",
      "list",
      "--repo",
      nwo,
      "--state",
      "open",
      "--json",
      "number,title,headRefName,baseRefName,url,isDraft",
      "--limit",
      "50",
    ],
    { cwd: repo.root_path, timeoutMs: 10000 }
  );

  if (!result.success) {
    return c.json([]);
  }

  let prs: any[];
  try {
    prs = JSON.parse(result.stdout || "[]");
    if (!Array.isArray(prs)) return c.json([]);
  } catch {
    return c.json([]);
  }

  return c.json(
    prs.map((pr: any) => ({
      number: pr.number,
      title: pr.title,
      branch: pr.headRefName,
      baseBranch: pr.baseRefName,
      url: pr.url,
      isDraft: pr.isDraft === true,
    }))
  );
});

app.get("/repos/:id/branches", async (c) => {
  const db = getDatabase();
  const repo = getRepositoryById(db, c.req.param("id"));
  if (!repo) throw new NotFoundError("Repository not found");

  let output: string;
  try {
    const { stdout } = await execFileAsync(
      "git",
      [
        "for-each-ref",
        "--sort=-committerdate",
        "--format=%(refname:short)",
        "refs/remotes/origin/",
        "--count=100",
      ],
      { cwd: repo.root_path, encoding: "utf-8", timeout: 5000 }
    );
    output = stdout;
  } catch {
    return c.json({ branches: [] });
  }

  const branches = output
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((ref) => ref.replace(/^origin\//, ""))
    .filter((name) => name !== "HEAD");

  return c.json({ branches: branches.map((name) => ({ name })) });
});

export default app;
