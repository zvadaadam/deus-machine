import { Hono } from "hono";
import Database from "better-sqlite3";
import { existsSync, readdirSync } from "fs";
import { homedir } from "os";
import { join, basename } from "path";
import type { RecentProject } from "@shared/types/onboarding";

const app = new Hono();

app.get("/onboarding/recent-projects", (c) => {
  const home = homedir();
  const projects: RecentProject[] = [];
  const seenPaths = new Set<string>();

  // Read from Cursor state.vscdb
  const cursorDbPath = join(
    home,
    "Library/Application Support/Cursor/User/globalStorage/state.vscdb"
  );
  readVscdbProjects(cursorDbPath, "cursor", projects, seenPaths);

  // Read from VSCode state.vscdb
  const vscodeDbPath = join(
    home,
    "Library/Application Support/Code/User/globalStorage/state.vscdb"
  );
  readVscdbProjects(vscodeDbPath, "vscode", projects, seenPaths);

  // Read from Claude projects directory
  readClaudeProjects(join(home, ".claude/projects"), projects, seenPaths);

  return c.json({ projects: projects.slice(0, 30) });
});

// Worktree directories created by AI coding tools — filter these from recent projects
// so only root repos are shown, not individual worktree checkouts.
const WORKTREE_SEGMENTS = [
  "/.deus/", // Deus worktrees
  "/.conductor/", // OpenDevs worktrees
  "/.claude/worktrees/", // Claude Code worktrees
  "/.cursor/worktrees/", // Cursor parallel agent worktrees
  "/copilot-worktree/", // GitHub Copilot CLI worktrees
];

function isWorktreePath(fsPath: string): boolean {
  return WORKTREE_SEGMENTS.some((seg) => fsPath.includes(seg));
}

function readVscdbProjects(
  dbPath: string,
  source: "cursor" | "vscode",
  projects: RecentProject[],
  seen: Set<string>
) {
  if (!existsSync(dbPath)) return;
  let db: InstanceType<typeof Database> | undefined;
  try {
    db = new Database(dbPath, { readonly: true });
    const row = db
      .prepare("SELECT value FROM ItemTable WHERE key = 'history.recentlyOpenedPathsList'")
      .get() as { value: string } | undefined;

    if (!row?.value) return;
    const data = JSON.parse(row.value);
    const entries = data.entries || [];

    for (const entry of entries) {
      const uri = entry.folderUri;
      if (!uri || !uri.startsWith("file://")) continue;
      const fsPath = decodeURIComponent(uri.replace("file://", ""));
      if (seen.has(fsPath) || isWorktreePath(fsPath) || !existsSync(fsPath)) continue;
      seen.add(fsPath);
      projects.push({ path: fsPath, name: basename(fsPath), source });
    }
  } catch {
    // Silently skip if DB is locked or malformed
  } finally {
    db?.close();
  }
}

function readClaudeProjects(dir: string, projects: RecentProject[], seen: Set<string>) {
  if (!existsSync(dir)) return;
  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      // Claude encodes paths: leading dash + dashes as path separators
      // e.g., "-Users-zvada-Developer-myproject" -> "/Users/zvada/Developer/myproject"
      const decoded = entry.name.replace(/-/g, "/");
      if (!decoded.startsWith("/")) continue;
      if (seen.has(decoded) || isWorktreePath(decoded) || !existsSync(decoded)) continue;
      seen.add(decoded);
      projects.push({ path: decoded, name: basename(decoded), source: "claude" });
    }
  } catch {
    // Silently skip
  }
}

export default app;
