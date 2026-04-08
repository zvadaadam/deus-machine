import Database from "better-sqlite3";
import { execFileSync } from "node:child_process";
import {
  closeSync,
  existsSync,
  openSync,
  readSync,
  readdirSync,
  statSync,
  type Dirent,
} from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { RecentProject } from "@shared/types/onboarding";

export const RECENT_PROJECT_LIMIT = 100;
const CLAUDE_JSONL_SCAN_BYTES = 16 * 1024;
const GIT_ROOT_TIMEOUT_MS = 1500;
const IGNORED_PATH_SEGMENTS = [
  "/.deus/",
  "/.conductor/",
  "/.claude/worktrees/",
  "/.cursor/worktrees/",
  "/copilot-worktree/",
  "/.opendevs/",
  "/.hive/",
  "/.superset/worktrees/",
  "/conductor/workspaces/",
] as const;

interface ReaderOptions {
  homeDir?: string;
}

interface ListRecentProjectsOptions extends ReaderOptions {
  limit?: number;
  readers?: {
    cursor?: () => RecentProject[];
    vscode?: () => RecentProject[];
    claude?: () => RecentProject[];
  };
}

interface JsonlSuffixRead {
  contents: string;
  truncated: boolean;
}

interface ClaudeSessionFile {
  path: string;
  mtimeMs: number;
}

interface ResolvedClaudeProject {
  path: string;
  activityMtimeMs: number;
}

function normalizePathForMatching(fsPath: string): string {
  return fsPath.replace(/\\/g, "/");
}

function isAbsoluteNormalizedPath(normalizedPath: string): boolean {
  return (
    normalizedPath.startsWith("/") ||
    normalizedPath.startsWith("//") ||
    /^[A-Za-z]:\//.test(normalizedPath)
  );
}

function parseFileUriPath(uri: string): string | null {
  try {
    let fsPath = decodeURIComponent(new URL(uri).pathname);
    if (process.platform === "win32" && /^\/[A-Za-z]:\//.test(fsPath)) {
      fsPath = fsPath.slice(1);
    }
    return fsPath;
  } catch {
    return null;
  }
}

function getEditorStateDbPath(appName: string, homeDir: string): string {
  if (process.platform === "win32") {
    return join(
      process.env.APPDATA || join(homeDir, "AppData", "Roaming"),
      appName,
      "User",
      "globalStorage",
      "state.vscdb"
    );
  }

  if (process.platform === "darwin") {
    return join(
      homeDir,
      "Library",
      "Application Support",
      appName,
      "User",
      "globalStorage",
      "state.vscdb"
    );
  }

  return join(homeDir, ".config", appName, "User", "globalStorage", "state.vscdb");
}

export function isIgnoredRecentProjectPath(fsPath: string, options: ReaderOptions = {}): boolean {
  if (!fsPath) return true;

  const normalizedPath = normalizePathForMatching(fsPath);
  const normalizedHome = normalizePathForMatching(options.homeDir ?? homedir());

  if (!isAbsoluteNormalizedPath(normalizedPath)) return true;
  if (normalizedPath === "/" || normalizedPath === normalizedHome) return true;
  if (normalizedPath.endsWith(".app")) return true;

  return IGNORED_PATH_SEGMENTS.some((segment) => normalizedPath.includes(segment));
}

export function resolveGitProjectRoot(fsPath: string): string | null {
  try {
    const rootPath = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd: fsPath,
      encoding: "utf8",
      timeout: GIT_ROOT_TIMEOUT_MS,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();

    return rootPath || null;
  } catch {
    return null;
  }
}

function pushProject(
  projects: RecentProject[],
  seenPaths: Set<string>,
  project: RecentProject,
  options: ReaderOptions = {}
): void {
  const projectRoot = resolveGitProjectRoot(project.path);
  if (!projectRoot) return;
  if (seenPaths.has(projectRoot)) return;
  if (isIgnoredRecentProjectPath(projectRoot, options)) return;
  if (!existsSync(projectRoot)) return;

  seenPaths.add(projectRoot);
  projects.push({
    ...project,
    path: projectRoot,
    name: basename(projectRoot),
  });
}

function readVscdbProjects(
  dbPath: string,
  source: "cursor" | "vscode",
  options: ReaderOptions
): RecentProject[] {
  if (!existsSync(dbPath)) return [];

  let db: InstanceType<typeof Database> | undefined;
  try {
    db = new Database(dbPath, { readonly: true });
    const row = db
      .prepare("SELECT value FROM ItemTable WHERE key = 'history.recentlyOpenedPathsList'")
      .get() as { value: string } | undefined;

    if (!row?.value) return [];

    const seenPaths = new Set<string>();
    const projects: RecentProject[] = [];
    const data = JSON.parse(row.value) as { entries?: Array<{ folderUri?: string }> };

    for (const entry of data.entries ?? []) {
      const uri = entry.folderUri;
      if (!uri || !uri.startsWith("file://")) continue;

      const fsPath = parseFileUriPath(uri);
      if (!fsPath) continue;

      pushProject(projects, seenPaths, { path: fsPath, name: basename(fsPath), source }, options);
    }

    return projects;
  } catch {
    return [];
  } finally {
    db?.close();
  }
}

function sortDirentsByMtime(dirents: Dirent[], parentDir: string): Dirent[] {
  return [...dirents].sort((left, right) => {
    const leftTime = statSync(join(parentDir, left.name)).mtimeMs;
    const rightTime = statSync(join(parentDir, right.name)).mtimeMs;
    return rightTime - leftTime;
  });
}

function readJsonlSuffix(filePath: string, maxBytes = CLAUDE_JSONL_SCAN_BYTES): JsonlSuffixRead {
  const fileSize = statSync(filePath).size;
  const start = Math.max(0, fileSize - maxBytes);
  const fileDescriptor = openSync(filePath, "r");

  try {
    const buffer = Buffer.alloc(maxBytes);
    const bytesRead = readSync(fileDescriptor, buffer, 0, maxBytes, start);
    return {
      contents: buffer.subarray(0, bytesRead).toString("utf8"),
      truncated: start > 0,
    };
  } finally {
    closeSync(fileDescriptor);
  }
}

function extractClaudeCwdFromJsonl(filePath: string): string | null {
  try {
    const { contents, truncated } = readJsonlSuffix(filePath);
    const lines = contents.split("\n").filter(Boolean);

    if (truncated && lines.length > 0) {
      lines.shift();
    }

    for (const line of lines.reverse()) {
      try {
        const record = JSON.parse(line) as { cwd?: string };
        if (typeof record.cwd === "string" && record.cwd.length > 0) {
          return record.cwd;
        }
      } catch {
        // Ignore partial or malformed lines
      }
    }
  } catch {
    return null;
  }

  return null;
}

function getClaudeSessionJsonlFiles(sessionDir: string): ClaudeSessionFile[] {
  const files: ClaudeSessionFile[] = [];
  const candidateDirs = [sessionDir, join(sessionDir, "subagents")];

  for (const candidateDir of candidateDirs) {
    if (!existsSync(candidateDir)) continue;

    for (const entry of readdirSync(candidateDir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;

      const filePath = join(candidateDir, entry.name);
      files.push({ path: filePath, mtimeMs: statSync(filePath).mtimeMs });
    }
  }

  return files.sort((left, right) => right.mtimeMs - left.mtimeMs);
}

function resolveClaudeProject(
  projectDir: string,
  options: ReaderOptions = {}
): ResolvedClaudeProject | null {
  if (!existsSync(projectDir)) return null;

  try {
    const sessionEntries = readdirSync(projectDir, { withFileTypes: true }).filter((entry) =>
      entry.isDirectory()
    );
    const jsonlFiles = sessionEntries
      .flatMap((entry) => getClaudeSessionJsonlFiles(join(projectDir, entry.name)))
      .sort((left, right) => right.mtimeMs - left.mtimeMs);

    for (const jsonlFile of jsonlFiles) {
      const cwd = extractClaudeCwdFromJsonl(jsonlFile.path);
      if (!cwd) continue;
      if (isIgnoredRecentProjectPath(cwd, options)) continue;
      if (!existsSync(cwd)) continue;

      return {
        path: cwd,
        activityMtimeMs: jsonlFile.mtimeMs,
      };
    }
  } catch {
    return null;
  }

  return null;
}

export function resolveClaudeProjectPath(
  projectDir: string,
  options: ReaderOptions = {}
): string | null {
  return resolveClaudeProject(projectDir, options)?.path ?? null;
}

export function readClaudeProjects(dir: string, options: ReaderOptions = {}): RecentProject[] {
  if (!existsSync(dir)) return [];

  const seenPaths = new Set<string>();
  const projects: RecentProject[] = [];

  try {
    const entries = sortDirentsByMtime(
      readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isDirectory()),
      dir
    );
    const resolvedProjects = entries
      .map((entry) => resolveClaudeProject(join(dir, entry.name), options))
      .filter((project): project is ResolvedClaudeProject => project !== null)
      .sort((left, right) => right.activityMtimeMs - left.activityMtimeMs);

    for (const project of resolvedProjects) {
      pushProject(
        projects,
        seenPaths,
        { path: project.path, name: basename(project.path), source: "claude" },
        options
      );
    }
  } catch {
    return [];
  }

  return projects;
}

export function interleaveRecentProjects(
  projectLists: RecentProject[][],
  limit = RECENT_PROJECT_LIMIT
): RecentProject[] {
  const queues = projectLists.map((projects) => [...projects]);
  const seenPaths = new Set<string>();
  const merged: RecentProject[] = [];

  while (merged.length < limit && queues.some((queue) => queue.length > 0)) {
    for (const queue of queues) {
      while (queue.length > 0) {
        const nextProject = queue.shift()!;
        if (seenPaths.has(nextProject.path)) continue;
        seenPaths.add(nextProject.path);
        merged.push(nextProject);
        break;
      }

      if (merged.length >= limit) break;
    }
  }

  return merged;
}

export function listRecentProjects(options: ListRecentProjectsOptions = {}): RecentProject[] {
  const homeDir = options.homeDir ?? homedir();
  const limit = options.limit ?? RECENT_PROJECT_LIMIT;
  const readerOptions = { homeDir };

  const cursorProjects =
    options.readers?.cursor?.() ??
    readVscdbProjects(getEditorStateDbPath("Cursor", homeDir), "cursor", readerOptions);

  const vscodeProjects =
    options.readers?.vscode?.() ??
    readVscdbProjects(getEditorStateDbPath("Code", homeDir), "vscode", readerOptions);

  const claudeProjects =
    options.readers?.claude?.() ??
    readClaudeProjects(join(homeDir, ".claude/projects"), readerOptions);

  return interleaveRecentProjects([cursorProjects, vscodeProjects, claudeProjects], limit);
}
